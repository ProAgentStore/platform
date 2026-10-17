import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Named HTTP credential profiles and their per-instance bindings (#1123). Every tool here returns
 * metadata — names, origins, secret version, bindings — and none returns a secret: the API has no
 * reveal. A secret goes IN through `create_http_profile` / `rotate_http_profile_secret`, and is kept
 * out of everything this file logs: the `input` handed to audit and dry-run records only that one was
 * supplied (`secret_supplied: true`), never its value, so the guarantee does not rest on the audit
 * redactor recognising a field name.
 */
export function registerHttpProfileTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const tokenArg = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const profileId = z.string().describe("Profile id (hcp_…) from list_http_profiles.");
	const secretArg = z.string().min(1).max(8192).describe("The credential — an API key or token. Stored encrypted; never shown again by any tool.");
	const origins = z.array(z.string()).max(20).optional().describe('Where this credential is meant to be sent, as bare origins: ["https://discord.com"]. Recorded now; enforced once host allowlisting ships (#1125).');
	const err = (data: unknown) => (data as { error?: string }).error;
	// #1124: how the secret becomes a request. Non-secret by construction — the owner's configuration.
	const strategyArg = z
		.enum(["none", "api_key", "bearer", "header_template", "basic", "multi_header", "oauth2_client_credentials", "oauth2_authorization_code"])
		.optional()
		.describe("How the secret is sent. bearer → `Authorization: Bearer <secret>`; header_template → a named header with static text around the secret (Discord: `Authorization: Bot <secret>`); api_key → a header or query parameter; basic → HTTP Basic (username in strategy_config, password = the secret); multi_header → several headers, literals and/or the secret; oauth2_client_credentials / oauth2_authorization_code → the secret is the CLIENT secret and requests carry a minted, auto-refreshed access token (authorization_code needs the owner's one-time consent in a browser). Omitted on create, the profile renders nothing.");
	const strategyConfigArg = z
		.union([z.record(z.unknown()), z.string()])
		.optional()
		.describe('Per strategy, never a secret: api_key {"in":"header"|"query","name":"X-Api-Key"}; header_template {"header":{"name":"Authorization","template":"Bot {{secret}}"}} — static text around ONE {{secret}}, no other placeholder; basic {"username":"..."}; multi_header {"headers":[{"name":"X-Key","template":"{{secret}}"},{"name":"X-Version","template":"2"}]}; OAuth2 {"tokenUrl":"https://...","clientId":"...","scope":"...","clientAuth":"body"|"basic"} plus "authorizeUrl" for authorization_code. Any strategy but multi_header may add "staticHeaders" (non-secret literals).');
	const configOf = (raw: unknown) => {
		if (typeof raw !== "string") return raw;
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return raw;
		}
	};

	server.tool(
		"list_http_profiles",
		"List your named HTTP credential profiles: id, name, description, allowed origins, auth strategy (`unspecified` until #1124), secret version and last rotation, and which instance bindings use each. Never returns a secret — there is no way to read one back. Read-only.",
		{ token: tokenArg },
		async ({ token }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_http_profiles", {});
			if (denied) return denied;
			return jsonText(await authedCall("/v1/http-profiles", session, {}, env));
		},
	);

	server.tool(
		"get_http_profile",
		"Read one HTTP credential profile's metadata and bindings. Never the secret. Read-only.",
		{ token: tokenArg, profile_id: profileId },
		async ({ token, profile_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_http_profile", { profile_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/http-profiles/${encodeURIComponent(profile_id)}`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"test_http_profile",
		"Storage-test an HTTP credential profile: is the secret present and decryptable, which origins are recorded, which instances are bound. Sends nothing over the network and returns no part of the secret; `scope` says what it does not establish (a live request needs #1124/#1125). Read-only.",
		{ token: tokenArg, profile_id: profileId },
		async ({ token, profile_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "test_http_profile", { profile_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/http-profiles/${encodeURIComponent(profile_id)}/test`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"create_http_profile",
		"Create a named HTTP credential profile holding one secret (API key / token / password / OAuth2 client secret), encrypted at rest, and the auth strategy that turns it into a request (#1124). No agent can use it until you bind it to an instance with bind_http_profile; the agent then calls http_request with `profile` set to the binding name, and never sees the secret. The secret is never returned by any tool afterwards. `name`: lower-case letters, digits, - or _. Call with dry_run first.",
		{
			token: tokenArg,
			name: z.string().describe('Profile name, e.g. "discord-bot".'),
			secret: secretArg,
			description: z.string().max(500).optional(),
			allowed_origins: origins,
			strategy: strategyArg,
			strategy_config: strategyConfigArg,
			dry_run: z.boolean().optional(),
		},
		async ({ token, name, secret, description, allowed_origins, strategy, strategy_config, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { name, description, allowed_origins, strategy, strategy_config: configOf(strategy_config), secret_supplied: true };
			const denied = await requirePermission(safetyFor(token), "write", "create_http_profile", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "create_http_profile", `create HTTP credential profile "${name}"`, input, { endpoint: "/v1/http-profiles", method: "POST" });
			const data = await authedCall("/v1/http-profiles", session, { method: "POST", body: JSON.stringify({ name, secret, description, allowedOrigins: allowed_origins, strategy, strategyConfig: configOf(strategy_config) }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "create_http_profile", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"update_http_profile",
		"Change an HTTP credential profile's name, description, allowed origins, or auth strategy (strategy + strategy_config, validated together; changing them clears an OAuth2 grant). Never the secret — use rotate_http_profile_secret. Renaming does not change any binding name. Call with dry_run first.",
		{
			token: tokenArg,
			profile_id: profileId,
			name: z.string().optional(),
			description: z.string().max(500).optional(),
			allowed_origins: origins,
			strategy: strategyArg,
			strategy_config: strategyConfigArg,
			dry_run: z.boolean().optional(),
		},
		async ({ token, profile_id, name, description, allowed_origins, strategy, strategy_config, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { profile_id, name, description, allowed_origins, strategy, strategy_config: configOf(strategy_config) };
			const denied = await requirePermission(safetyFor(token), "write", "update_http_profile", input);
			if (denied) return denied;
			const endpoint = `/v1/http-profiles/${encodeURIComponent(profile_id)}`;
			if (dry_run) return dryRun(safetyFor(token), "update_http_profile", "update an HTTP credential profile's metadata", input, { endpoint, method: "PATCH" });
			const data = await authedCall(endpoint, session, { method: "PATCH", body: JSON.stringify({ name, description, allowedOrigins: allowed_origins, strategy, strategyConfig: configOf(strategy_config) }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "update_http_profile", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"rotate_http_profile_secret",
		"Replace an HTTP credential profile's secret. Every instance bound to the profile uses the new one; `secret.version` increments. The old secret is overwritten, not kept. Call with dry_run first.",
		{ token: tokenArg, profile_id: profileId, secret: secretArg, dry_run: z.boolean().optional() },
		async ({ token, profile_id, secret, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { profile_id, secret_supplied: true };
			const denied = await requirePermission(safetyFor(token), "write", "rotate_http_profile_secret", input);
			if (denied) return denied;
			const endpoint = `/v1/http-profiles/${encodeURIComponent(profile_id)}/rotate`;
			if (dry_run) return dryRun(safetyFor(token), "rotate_http_profile_secret", "replace an HTTP credential profile's secret", input, { endpoint, method: "POST" });
			const data = await authedCall(endpoint, session, { method: "POST", body: JSON.stringify({ secret }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "rotate_http_profile_secret", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_http_profile",
		'Delete an HTTP credential profile and every binding to it — each bound instance loses access at once. Check get_http_profile\'s bindings first. DESTRUCTIVE: requires confirm "delete_http_profile".',
		{
			token: tokenArg,
			profile_id: profileId,
			confirm: z.string().optional().describe('Must be "delete_http_profile" to delete.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, profile_id, confirm, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { profile_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_http_profile", input);
			if (denied) return denied;
			const endpoint = `/v1/http-profiles/${encodeURIComponent(profile_id)}`;
			if (dry_run) return dryRun(safetyFor(token), "delete_http_profile", "delete an HTTP credential profile and its bindings", input, { endpoint, method: "DELETE" });
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_http_profile", confirm, "delete_http_profile", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, session, { method: "DELETE" }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "delete_http_profile", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_http_bindings",
		"List the HTTP credential profiles one instance may use: each binding's name (what the agent selects), connector, profile, allowed origins and secret version. An instance can use a profile only through one of these. Never a secret. Read-only.",
		{ token: tokenArg, instance_id: z.string().describe("Instance ID from my_instances") },
		async ({ token, instance_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_instance_http_bindings", { instance_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/http-bindings`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	const bindingName = z.string().describe('The name the agent will select this credential by, e.g. "discord". Lower-case letters, digits, - or _.');
	const connector = z.string().optional().describe('Connector the binding is for. Default "http".');

	server.tool(
		"bind_http_profile",
		"Let one instance use one of your HTTP credential profiles, under a binding name. Both must be yours. Binding an existing name points it at the new profile. The agent still never sees the secret. Call with dry_run first.",
		{ token: tokenArg, instance_id: z.string(), binding_name: bindingName, profile_id: profileId, connector, dry_run: z.boolean().optional() },
		async ({ token, instance_id, binding_name, profile_id, connector: conn, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, binding_name, profile_id, connector: conn ?? "http" };
			const denied = await requirePermission(safetyFor(token), "write", "bind_http_profile", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/http-bindings/${encodeURIComponent(binding_name)}`;
			if (dry_run) return dryRun(safetyFor(token), "bind_http_profile", `bind an HTTP credential profile to an instance as "${binding_name}"`, input, { endpoint, method: "PUT" });
			const data = await authedCall(endpoint, session, { method: "PUT", body: JSON.stringify({ profileId: profile_id, connector: conn }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "bind_http_profile", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"unbind_http_profile",
		"Remove a binding: the instance immediately stops being able to use that profile. The profile itself is kept. Call with dry_run first.",
		{ token: tokenArg, instance_id: z.string(), binding_name: bindingName, connector, dry_run: z.boolean().optional() },
		async ({ token, instance_id, binding_name, connector: conn, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, binding_name, connector: conn ?? "http" };
			const denied = await requirePermission(safetyFor(token), "write", "unbind_http_profile", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/http-bindings/${encodeURIComponent(binding_name)}${conn ? `?connector=${encodeURIComponent(conn)}` : ""}`;
			if (dry_run) return dryRun(safetyFor(token), "unbind_http_profile", `remove HTTP credential binding "${binding_name}"`, input, { endpoint, method: "DELETE" });
			const data = await authedCall(endpoint, session, { method: "DELETE" }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "unbind_http_profile", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
