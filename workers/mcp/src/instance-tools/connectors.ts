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
		"Grant one of your instances access to a folder on a file connector, by share URL or resource id. Returns the created grant including its `id` — the value a `sync_connector` trigger needs. Folders only: a file grant is refused server-side. An instance whose agent cannot read a knowledge base is also refused (403), because that is the only place an imported document ever lands — check `list_instance_tools` before assuming the folder is the problem. WRITE: this widens what the agent can read.",
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

	// ── Connector catalogue + per-instance verdict + write consent (#613) ──────
	//
	// `connector_status` above answers "is Drive connected" for the two file connectors.
	// These answer the general questions the console's Settings tab asks: what connectors
	// exist at all, what THIS agent's verdict on each is, and whether an agent may WRITE
	// through one. Without them a caller could create a trigger or call a connector tool
	// and only learn from the refusal that the agent was never offered that connector.

	server.tool(
		"list_connectors",
		"List every connector this deployment knows, resolved for the signed-in account: id, label, auth kind, scopes, grant model, the tools it contributes, whether the deployment is `configured` for it, and whether the account has `connected` one. `connected: null` means the connector holds no credential (a relay or no-auth one), which is not the same answer as false. Connecting is an OAuth flow and must be done once in a browser; everything after that is reachable from here. For one agent's verdict on these, use list_instance_connectors.",
		{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/connectors", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_connectors",
		"What THIS instance may do with each connector — the per-agent verdict, not the account-level connection. An account connects Drive once, but an agent is only offered a connector when it declares one of that connector's tools, so the same connection is available on one agent and refused on another. Each entry carries the refusal sentence when there is one, in the same words the grant routes refuse with. Read this before creating a grant, a sync trigger, or a call_instance_tool that depends on a connector.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/connectors`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_connector_consent",
		"Grant or revoke WRITE consent for one connector on one instance — the owner's separate yes to an agent changing things through it, on top of the connector being connected at all. Reads never need consent; without it, a connector's write tools are refused by call_instance_tool and by the agent itself. Granting is validated against the registry first, so an unknown connector 404s and a read-only one is refused rather than stored as consent that could never do anything. Revoking always works, including for a connector that has since become read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			connector: z.string().describe("Connector id from list_connectors or list_instance_connectors, e.g. github. Copy it exactly."),
			enabled: z.boolean().describe("true to grant write consent, false to revoke it."),
			dry_run: z.boolean().optional().describe("Preview without changing the consent."),
		},
		async ({ token, instance_id, connector, enabled, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, connector, enabled };
			// `write`, on the same reasoning as `set_instance_tool`: this changes what an agent is
			// PERMITTED to do, so a read-only MCP session must not be able to widen its reach. Not
			// `destructive`, because it is the reversible half of a pair whose other half (revoke)
			// must stay easy — classing the grant as destructive would leave revocation behind a
			// scope a caller may not hold, which is the wrong failure for a safety toggle.
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_connector_consent", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(
					safetyFor(token),
					"set_instance_connector_consent",
					enabled ? "grant a connector write consent on this instance" : "revoke a connector's write consent on this instance",
					input,
					{ endpoint: `/v1/instances/${instance_id}/connectors/${connector}/consent`, method: "PUT" },
				);
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/connectors/${encodeURIComponent(connector)}/consent`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ enabled }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_connector_consent", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	// ── Browsing and importing a granted folder's files (#613) ─────────────────
	//
	// The grant routes above hand out folder access; these are what that access is FOR. Until now
	// an MCP caller could grant an instance a Drive folder and then neither see inside it nor pull
	// anything out of it, which is the half of the capability that does something.
	//
	// NO `providerSchema` here, deliberately — unlike every tool above, these are per-provider.
	// The two import routes are NOT symmetrical: Drive takes `fileId` and answers `driveFile`
	// with a `webViewLink`, WorkDrive takes `resourceId` and answers `workdriveFile` with a
	// `permalink`. One tool switching on `provider` would have to silently re-key the caller's
	// file argument, and sending Drive's key to WorkDrive is a 400 the caller cannot see coming.
	// Browsing is asymmetrical too: Drive's file list is `GET …/instances/:id/files`, while
	// WorkDrive's is `GET …/instances/:id/folder`, which is ALREADY reachable over MCP and so is
	// not duplicated here. Keep them separate.

	server.tool(
		"list_instance_drive_files",
		"List the files inside a Google Drive folder one of your instances has been granted. `grant_id` is required and comes from list_instance_connector_grants — the grant IS the permission, and a folder outside its subtree is refused (403) rather than listed. Omit `folder` to list the granted folder itself; pass a subfolder id from a previous call to walk down. Returns `{files, grant, folder}`. For Zoho WorkDrive use the workdrive folder endpoint instead — this tool is Drive-only, because the two providers do not share a browse route. Import a file you find here with import_instance_drive_file.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			grant_id: z.string().describe("Grant id from list_instance_connector_grants. Required — the route refuses without it."),
			folder: z.string().optional().describe("A folder id inside the grant. Defaults to the granted folder itself."),
			q: z.string().optional().describe("Google Drive search query, to narrow the listing."),
			limit: z.coerce.number().optional().describe("How many files to return. Defaults to 50."),
		},
		async ({ token, instance_id, grant_id, folder, q, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const params = new URLSearchParams({ grantId: grant_id });
			if (folder) params.set("folder", folder);
			if (q) params.set("q", q);
			if (limit !== undefined) params.set("limit", String(limit));
			const data = await authedCall(
				`${PROVIDERS.google_drive.base}/instances/${encodeURIComponent(instance_id)}/files?${params.toString()}`,
				sessionToken,
				{},
				env,
			);
			return jsonText({ provider: "google_drive", ...(data as Record<string, unknown>) });
		},
	);

	server.tool(
		"import_instance_drive_file",
		"Copy one Google Drive file into an instance's knowledge base, where it is vectorized like any other document. Identify the file by `file_id` (from list_instance_drive_files) or by its share `url`; `grant_id` is required either way, and a file outside that grant's folder is refused (403) — the grant is the permission, not the id you hold. `title` defaults to the file's own name. This ADDS a document: it does not sync, and importing the same file twice creates two. An instance whose agent cannot read a knowledge base is refused (403), since that is the only place an import lands. WRITE.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			grant_id: z.string().describe("Grant id from list_instance_connector_grants. Required — the route refuses without it."),
			file_id: z.string().optional().describe("Google Drive file id, from list_instance_drive_files. Either this or url is required."),
			url: z.string().optional().describe("The file's Drive share URL, if you do not have its id."),
			title: z.string().optional().describe("Override the document title (defaults to the file's own name, max 500 chars)."),
			dry_run: z.boolean().optional().describe("Report the import that would happen, without importing."),
		},
		async ({ token, instance_id, grant_id, file_id, url, title, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, grant_id, file_id, url, title };
			// `write`, matching `grant_instance_connector_folder` beside it: this adds a document to
			// the knowledge base — additive, and removable with delete_instance_knowledge — rather
			// than destroying anything. Not `runtime` either: the fetch happens server-side inside
			// the owner's own already-granted scope, and drives no machine.
			const denied = await requirePermission(safetyFor(token), "write", "import_instance_drive_file", input);
			if (denied) return denied;
			// Refused here rather than at the route, which answers the same 400 for both halves of
			// this either/or — a caller that sent neither reads "fileId or url required" and cannot
			// tell which name this tool actually takes.
			if (!file_id && !url) return text("Provide either `file_id` or `url` for the Drive file to import.");
			const endpoint = `${PROVIDERS.google_drive.base}/instances/${encodeURIComponent(instance_id)}/import`;
			if (dry_run) {
				return dryRun(safetyFor(token), "import_instance_drive_file", "copy a Google Drive file into an instance's knowledge base", input, {
					endpoint,
					method: "POST",
					effect: `${instance_id} would gain ONE knowledge document copied from ${file_id ?? url}. Nothing is synced afterwards, and a second import of the same file would add a second document.`,
				});
			}
			const data = await authedCall(
				endpoint,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ fileId: file_id, url, title, grantId: grant_id }) },
				env,
			);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "import_instance_drive_file", action: "completed", input, result: data });
			}
			return jsonText(data);
		},
	);

	server.tool(
		"import_instance_workdrive_file",
		"Copy one Zoho WorkDrive file into an instance's knowledge base, where it is vectorized like any other document. Identify the file by `resource_id` — WorkDrive's own name for it, NOT Drive's `file_id` — or by its share `url`; `grant_id` is required either way, and a file outside that grant's folder is refused (403). `title` defaults to the file's own name. This ADDS a document: it does not sync, and importing the same file twice creates two. Browse a granted WorkDrive folder with the workdrive folder endpoint; list_instance_drive_files is Google Drive only. WRITE.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			grant_id: z.string().describe("Grant id from list_instance_connector_grants. Required — the route refuses without it."),
			resource_id: z.string().optional().describe("Zoho WorkDrive resource id. Either this or url is required."),
			url: z.string().optional().describe("The file's WorkDrive share URL, if you do not have its resource id."),
			title: z.string().optional().describe("Override the document title (defaults to the file's own name, max 500 chars)."),
			dry_run: z.boolean().optional().describe("Report the import that would happen, without importing."),
		},
		async ({ token, instance_id, grant_id, resource_id, url, title, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, grant_id, resource_id, url, title };
			const denied = await requirePermission(safetyFor(token), "write", "import_instance_workdrive_file", input);
			if (denied) return denied;
			if (!resource_id && !url) return text("Provide either `resource_id` or `url` for the WorkDrive file to import.");
			const endpoint = `${PROVIDERS.zoho_workdrive.base}/instances/${encodeURIComponent(instance_id)}/import`;
			if (dry_run) {
				return dryRun(safetyFor(token), "import_instance_workdrive_file", "copy a Zoho WorkDrive file into an instance's knowledge base", input, {
					endpoint,
					method: "POST",
					effect: `${instance_id} would gain ONE knowledge document copied from ${resource_id ?? url}. Nothing is synced afterwards, and a second import of the same file would add a second document.`,
				});
			}
			const data = await authedCall(
				endpoint,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ resourceId: resource_id, url, title, grantId: grant_id }) },
				env,
			);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "import_instance_workdrive_file", action: "completed", input, result: data });
			}
			return jsonText(data);
		},
	);

}

// ── Which account an instance uses (#736) ───────────────────────────────────
//
// When the owner holds more than one account on a connector (two Gmail mailboxes), every call
// through it refuses with `ambiguous` until the instance is pinned to one — the server never picks,
// because reading the wrong mailbox answers from the wrong life (#715). The console picker shipped in
// #736; over MCP the state was unreadable and unresolvable, so `list_instance_tools` could report a
// Gmail tool as allowed while every call to it refused.
//
// Thin proxies over `GET`/`PUT /v1/instances/:id/connector-accounts`. The server's refusal text says
// "choose … in its Settings"; that string is shared with the console and is left alone — these tool
// descriptions name the MCP route to the same choice instead.

/** One row of `GET /v1/instances/:id/connector-accounts`, as far as these tools read it. */
interface ConnectorAccountsRow {
	connector?: string;
	pinned?: string | null;
	resolves?: string | null;
	blocked?: { reason: string; message: string } | null;
}

export function registerConnectorAccountTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"get_instance_connector_account",
		"Which of your accounts an instance uses, per connector you hold an account on (e.g. Gmail). Each row carries the `accounts` connected, the one this instance is `pinned` to, the account a call would use right now (`resolves`), and `blocked` — the server's own reason when it would use none. `resolves: null` means EVERY call through that connector refuses: with two or more accounts and no pin the reason is `ambiguous`, and a pin to an account that has since been disconnected is `pinned_account_gone` — neither falls back to another account. Fix either with set_instance_connector_account. A connector with no account connected is not listed at all.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			connector: z.string().optional().describe('Connector id, e.g. "gmail". Omit to list every connector you hold an account on.'),
		},
		async ({ token, instance_id, connector }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_connector_account", { instance_id, connector });
			if (denied) return denied;
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/connector-accounts`, sessionToken, {}, env);
			// An `{error}` body carries no `connectors` and passes through untouched, rather than being
			// reshaped into an empty list — "nothing connected" and "unreadable" are different answers.
			const rows = (data as { connectors?: ConnectorAccountsRow[] }).connectors;
			const wanted = connector?.trim();
			if (!Array.isArray(rows) || !wanted) return jsonText(data);
			const match = rows.filter((r) => r.connector === wanted);
			if (match.length) return jsonText({ connectors: match });
			const held = rows.map((r) => r.connector).filter(Boolean);
			return jsonText({
				connectors: [],
				note: `No "${wanted}" row: you hold no account on that connector, or it is not a connector id. ${held.length ? `Connectors you hold an account on: ${held.join(", ")}.` : "You hold no connector accounts."}`,
			});
		},
	);

	server.tool(
		"set_instance_connector_account",
		"Pin an instance to ONE of your accounts on a connector, so its calls through that connector stop refusing with `ambiguous` (or `pinned_account_gone`). `account_id` must be an `accountId` from get_instance_connector_account — the server refuses an account you have not connected. This only CHOOSES among accounts already connected; it cannot connect, disconnect or add one (that is the console's account page). Returns the connector's row read back after saving, so `resolves` and `blocked` show whether calls will now succeed. It cannot clear a pin: with two or more accounts, an unpinned instance refuses every call — clear it in the console if that is what you want. WRITE.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			connector: z.string().describe('Connector id from get_instance_connector_account, e.g. "gmail".'),
			account_id: z.string().describe("The `accountId` to pin, copied exactly from get_instance_connector_account's `accounts`. Required and non-blank."),
			dry_run: z.boolean().optional().describe("Report the pin that would be saved, without saving it."),
		},
		async ({ token, instance_id, connector, account_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const connectorId = connector.trim();
			const accountId = account_id.trim();
			const input = { instance_id, connector: connectorId, account_id: accountId };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_connector_account", input);
			if (denied) return denied;
			// The route treats a blank `accountId` as CLEAR, and with two or more accounts a cleared pin
			// makes every call refuse. A blank argument from a model is far likelier to be a mistake than a
			// request for that, so it is refused here, before any request.
			if (!connectorId || !accountId) {
				return text(
					`Error: nothing changed — ${!connectorId ? "`connector`" : "`account_id`"} is blank. Both are required; take them from get_instance_connector_account. This tool never clears a pin.`,
				);
			}
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/connector-accounts`;
			const body = { connector: connectorId, accountId };
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_connector_account", `pin an instance to one ${connectorId} account`, input, {
					endpoint,
					method: "PUT",
					body,
					effect: `Calls through ${connectorId} on this instance would use "${accountId}". Refused at save time if that account is not connected.`,
				});
			}
			const saved = await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env);
			// Only a SUCCESS is audited as completed — `apiCall` returns `{error}` rather than throwing (#325).
			if ((saved as { error?: string }).error) return jsonText(saved);
			await audit(safetyFor(token), { tool: "set_instance_connector_account", action: "completed", input, result: saved });
			// The PUT answers `{success, connector, pinned}` and nothing about what a call now does. The
			// read-back is what shows `resolves`/`blocked`, which is the thing the caller needs to know.
			const after = await authedCall(endpoint, sessionToken, {}, env);
			const rows = (after as { connectors?: ConnectorAccountsRow[] }).connectors;
			const row = Array.isArray(rows) ? rows.find((r) => r.connector === connectorId) : undefined;
			if (row) return jsonText(row);
			return jsonText({
				...(saved as Record<string, unknown>),
				note: `Saved, but reading it back did not return the ${connectorId} row${(after as { error?: string }).error ? ` (${(after as { error?: string }).error})` : ""}. Check with get_instance_connector_account.`,
			});
		},
	);
}
