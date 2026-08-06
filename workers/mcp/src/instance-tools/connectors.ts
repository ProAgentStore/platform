import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Drive / WorkDrive connector-grant tools (#15).
 *
 * A `sync_connector` trigger needs a `grantId`, and grant ids were only obtainable from the
 * console or a hand-rolled REST call — so an MCP-first operator could create the trigger but
 * never find the value it requires. That is the gap: the account-level connection is made once
 * in a browser (it is an OAuth flow, so it has to be), but everything after it should be
 * reachable from here.
 *
 * Thin proxies over the existing owner-scoped routes; all validation, folder-vs-file checking
 * and token minting stay server-side where they already are.
 */

/** The two providers that have a grant model, and where their routes live. */
const PROVIDERS = {
	google_drive: { base: "/v1/drive", label: "Google Drive" },
	zoho_workdrive: { base: "/v1/workdrive", label: "Zoho WorkDrive" },
} as const;
type ProviderId = keyof typeof PROVIDERS;

const providerSchema = z
	.enum(["google_drive", "zoho_workdrive"])
	.describe("Which connector: google_drive or zoho_workdrive.");

export function registerConnectorGrantTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"connector_status",
		"Is a file connector connected for your account, and is this deployment configured for it? Returns `{connected, configured}` for Google Drive or Zoho WorkDrive. `configured:false` means the deployment has no OAuth client for it — no amount of clicking will connect it. Connecting itself is an OAuth flow and must be done once in the console; everything after that is available here.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			provider: providerSchema,
		},
		async ({ token, provider }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`${PROVIDERS[provider as ProviderId].base}/status`, sessionToken, {}, env);
			return jsonText({ provider, ...(data as Record<string, unknown>) });
		},
	);

	server.tool(
		"list_instance_connector_grants",
		"List the folders one of your instances has been granted on a file connector. Each grant carries the `id` that a `sync_connector` trigger needs, plus the resource name, type and URL. An agent can only ever read a folder that appears here — the grant IS the permission, so this is also how you audit what an agent can see.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			provider: providerSchema,
		},
		async ({ token, instance_id, provider }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`${PROVIDERS[provider as ProviderId].base}/instances/${encodeURIComponent(instance_id)}/grants`,
				sessionToken,
				{},
				env,
			);
			return jsonText({ provider, ...(data as Record<string, unknown>) });
		},
	);

	server.tool(
		"grant_instance_connector_folder",
		"Grant one of your instances access to a folder on a file connector, by share URL or resource id. Returns the created grant including its `id` — the value a `sync_connector` trigger needs. Folders only: a file grant is refused server-side. WRITE: this widens what the agent can read.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			provider: providerSchema,
			url: z.string().optional().describe("The folder's share URL. Either this or resource_id is required."),
			resource_id: z.string().optional().describe("The provider's own folder id, if you have it."),
			name: z.string().optional().describe("Override the display name (defaults to the folder's real name)."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, provider, url, resource_id, name, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, provider, url, resource_id, name };
			const denied = await requirePermission(safetyFor(token), "write", "grant_instance_connector_folder", input);
			if (denied) return denied;
			if (!url && !resource_id) return text("Provide either `url` or `resource_id` for the folder to grant.");
			const endpoint = `${PROVIDERS[provider as ProviderId].base}/instances/${encodeURIComponent(instance_id)}/grants`;
			if (dry_run) {
				return dryRun(safetyFor(token), "grant_instance_connector_folder", `grant a ${PROVIDERS[provider as ProviderId].label} folder`, input, {
					endpoint,
					method: "POST",
				});
			}
			const data = await authedCall(
				endpoint,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ url, resourceId: resource_id, name }) },
				env,
			);
			await audit(safetyFor(token), { tool: "grant_instance_connector_folder", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_connector_grant",
		"Revoke an instance's access to a granted folder. The agent immediately stops being able to read it, and any `sync_connector` trigger pointing at this grant will fail — check `list_instance_triggers` first. DESTRUCTIVE: requires confirm.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			provider: providerSchema,
			grant_id: z.string().describe("Grant id from list_instance_connector_grants."),
			confirm: z.string().optional().describe('Must be "delete_instance_connector_grant" to revoke.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, provider, grant_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, provider, grant_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_connector_grant", input);
			if (denied) return denied;
			const endpoint = `${PROVIDERS[provider as ProviderId].base}/instances/${encodeURIComponent(instance_id)}/grants/${encodeURIComponent(grant_id)}`;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_connector_grant", `revoke a ${PROVIDERS[provider as ProviderId].label} folder grant`, input, {
					endpoint,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_connector_grant", confirm, "delete_instance_connector_grant", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(endpoint, sessionToken, { method: "DELETE" }, env)) as { success?: boolean; error?: string };
			if (data.success) await audit(safetyFor(token), { tool: "delete_instance_connector_grant", action: "completed", input });
			return text(data.success ? "Grant revoked." : `Error: ${data.error || "revoke failed"}`);
		},
	);
}
