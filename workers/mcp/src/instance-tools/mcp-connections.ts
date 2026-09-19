import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * PAGS as an MCP *client* — the outbound half (#262/#264/#266/#287, gap group #613).
 *
 * This server has always SERVED MCP. The other direction — an instance reaching a remote
 * Streamable-HTTP MCP server as a pipeline step — was configurable only in the console, which
 * is the loop #613 names as the one most worth closing: an operator driving PAGS over MCP could
 * see that an instance had an outbound connection and could neither test it, grant it, nor
 * answer the question a remote server had stopped to ask.
 *
 * THE THREE GATES, and why these tools do not bypass any of them. A real `mcp_call_tool` passes
 * the agent's declared tool allowlist, the connector-level write consent (#90), and the
 * per-(endpoint, tool) grant (#262). `test_instance_mcp_server` REPORTS all three rather than
 * standing in for them — a test that said "connected" while consent would refuse every real call
 * is the exact lie that route was written to avoid. `answer_instance_mcp_input_request` resumes
 * through `runRegistryTool`, so a grant revoked while the ask sat waiting stops the resume.
 *
 * Endpoints are normalized server-side and must be https; a URL that is not an MCP endpoint is
 * refused before anything is stored, so consent, credentials and the trace log all key on the
 * same string. Credentials are deliberately absent from this file: `EXCLUSIONS` in
 * `check-mcp-parity.mjs` records why an MCP server's bearer token is never read or written here.
 */
export function registerMcpConnectionTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"list_mcp_presets",
		"First-party MCP servers this deployment knows about, as prefilled URLs. A preset is a URL and nothing more: it carries no credential, grants no tool and skips no gate — the endpoint it names goes through the same test, the same per-tool consent and the same authorization as one typed by hand. A deployment that configures none simply returns an empty list.",
		{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/mcp/presets", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_mcp_grants",
		"The outbound-MCP grants on one instance: which remote tools, on which endpoints, this agent is allowed to CALL. Each grant is a (endpoint, tool) pair; `tool: \"*\"` covers every non-destructive tool on that server, and each row's `destructive` flag says whether the name would be excluded from such a wildcard. Distinct from the connector-level write consent, which permits MCP writes at all but names no server; read that one with `list_instance_connectors` and set it with `set_instance_connector_consent`. A real call needs both.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/mcp/consent`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_mcp_grant",
		"Grant or revoke ONE remote MCP tool on ONE endpoint for an instance. `tool` is a remote tool name, or \"*\" for every non-destructive tool on that server — a destructive name is never covered by the wildcard and must be granted by name. Granting also switches on the connector-level MCP write consent, because naming a server IS the decision to let this agent write through MCP; the implication runs one way only, and revoking a grant leaves that connector consent alone. The url must be an https MCP endpoint and is normalized before storage, so the grant keys on the same string the test and the trace log use.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			url: z.string().describe("The remote MCP endpoint, e.g. https://example.com/mcp. Must be https."),
			tool: z.string().describe('Remote tool name from test_instance_mcp_server, or "*" for every non-destructive tool on that server.'),
			enabled: z.boolean().describe("true to grant, false to revoke."),
			dry_run: z.boolean().optional().describe("Preview without changing the grant."),
		},
		async ({ token, instance_id, url, tool, enabled, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, url, tool, enabled };
			// `write`, matching `set_instance_connector_consent` and `set_instance_tool`: this
			// changes what an agent is PERMITTED to do, so a read-only session must not widen it.
			// Not `destructive` — revoking is the other half of this same tool and must not sit
			// behind a scope a caller may not hold.
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_mcp_grant", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(
					safetyFor(token),
					"set_instance_mcp_grant",
					enabled ? `grant ${tool} on ${url} to this instance` : `revoke ${tool} on ${url}`,
					input,
					{ endpoint: `/v1/instances/${instance_id}/mcp/consent`, method: "PUT" },
				);
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/mcp/consent`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ url, tool, enabled }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_mcp_grant", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"test_instance_mcp_server",
		"Connect to a remote MCP endpoint as this instance would and report what is actually true about it: whether it answered, what tools it publishes, and for each tool whether this agent could really CALL it — naming which of the three gates (the agent's tool allowlist, the connector write consent, the per-tool grant) is the one still shut. It answers the question that matters rather than \"did the HTTP call work\": a server can be perfectly reachable and still refuse every real call. A `status: \"blocked\"` means the SSRF guard refused the address, which is not the same as the server being down. This reaches a third party and is strictly rate-limited, so it is gated as runtime rather than as a read.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			url: z.string().describe("The remote MCP endpoint to test, e.g. https://example.com/mcp. Must be https."),
			auth: z.enum(["vault", "none"]).optional().describe("`vault` (default) uses the credential stored for this endpoint; `none` tests it as an open server."),
			dry_run: z.boolean().optional().describe("Preview without contacting the server."),
		},
		async ({ token, instance_id, url, auth, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, url, auth: auth ?? "vault" };
			const denied = await requirePermission(safetyFor(token), "runtime", "test_instance_mcp_server", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "test_instance_mcp_server", `contact ${url} and report what this agent could call there`, input, {
					endpoint: `/v1/instances/${instance_id}/mcp/test`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/mcp/test`,
				sessionToken,
				// `auth` is sent only when the caller narrowed it: the route reads anything other
				// than the string "none" as "use the vault", so an omitted value and "vault" mean
				// the same thing there and manufacturing one would be noise in the audit row.
				{ method: "POST", body: JSON.stringify(auth === "none" ? { url, auth: "none" } : { url }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "test_instance_mcp_server", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_mcp_input_requests",
		"Outbound MCP calls that PAUSED because the remote server asked the person for more (an `elicitation/create`). Each entry names the endpoint, the tool, the round, the fields being asked for and the deadline. A paused call is holding a run open, so this is the thing to check when an agent looks stuck on an MCP step — and an ask past its deadline reads as closed here whether or not the sweeper has run.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/mcp/input-requests`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"answer_instance_mcp_input_request",
		"Answer or cancel a paused outbound MCP call. `submit` sends `values` to the remote server by RETRYING the original call with them merged in — so the values leave this platform, and they must be the owner's own answer, never invented. `cancel` closes the ask and sends the server nothing. The claim is ONE-SHOT because a remote tool call is not idempotent: a rejected form does not burn it, but a successful submit or cancel cannot be repeated (409). The retry re-passes every gate the first attempt did, so a grant revoked while the ask was waiting stops it. Field names and a byte count are logged; the values themselves never are.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			request_id: z.string().describe("The paused ask's id, from list_instance_mcp_input_requests. Copy it exactly."),
			action: z.enum(["submit", "cancel"]).describe("`submit` answers the server; `cancel` declines and sends nothing."),
			values: z
				.record(z.unknown())
				.optional()
				.describe("Field name → the owner's answer, per the ask's declared fields. Required for submit; validated before the claim is spent."),
			dry_run: z.boolean().optional().describe("Preview without answering."),
		},
		async ({ token, instance_id, request_id, action, values, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Field NAMES and a count, never the values — the same rule the route's own audit row
			// follows, and for the same reason: an elicited value is likelier than an ordinary
			// argument to be a secret, and an audit trail is not a place to write one down.
			const input = { instance_id, request_id, action, fields: Object.keys(values ?? {}) };
			const denied = await requirePermission(safetyFor(token), "runtime", "answer_instance_mcp_input_request", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(
					safetyFor(token),
					"answer_instance_mcp_input_request",
					action === "cancel" ? "cancel a paused outbound MCP call, sending the server nothing" : "answer a paused outbound MCP call, sending the values to the remote server",
					input,
					{ endpoint: `/v1/instances/${instance_id}/mcp/input-requests/${request_id}`, method: "POST" },
				);
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/mcp/input-requests/${encodeURIComponent(request_id)}`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(action === "cancel" ? { action: "cancel" } : { action: "submit", values: values ?? {} }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "answer_instance_mcp_input_request", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
