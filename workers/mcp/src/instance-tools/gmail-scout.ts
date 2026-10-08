import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/** Console parity for a source that only reads Gmail and only writes private Scout records. */
export function registerGmailScoutTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const auth = (token?: string) => tokenFor(token);
	server.tool("gmail_scout_config_get", "Read this Job Search Scout's read-only Gmail source configuration. No mailbox content is returned.", { token: z.string().optional(), instance_id: z.string() }, async ({ token, instance_id }) => {
		const session = auth(token); if (!session) return authRequired(); const denied = await requirePermission(safetyFor(token), "read", "gmail_scout_config_get", { instance_id }); if (denied) return denied;
		const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/gmail-scout/config`, session, {}, env) as { error?: string }; return data.error ? text(`Error: ${data.error}`) : jsonText(data);
	});
	server.tool("gmail_scout_status", "Read Gmail Scout mailbox binding and scan status, including last scan, candidate and dedupe counts, failures, and private-lead counts. Read-only.", { token: z.string().optional(), instance_id: z.string() }, async ({ token, instance_id }) => {
		const session = auth(token); if (!session) return authRequired(); const denied = await requirePermission(safetyFor(token), "read", "gmail_scout_status", { instance_id }); if (denied) return denied;
		const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/gmail-scout/status`, session, {}, env) as { error?: string }; return data.error ? text(`Error: ${data.error}`) : jsonText(data);
	});
	server.tool("gmail_scout_config_set", "Configure or disable a Gmail job-alert source. The mailbox must already be connected; this source declares only read tools. Call with dry_run first.", { token: z.string().optional(), instance_id: z.string(), pinned_email: z.string().nullable().optional(), enabled: z.boolean().optional(), dry_run: z.boolean().optional() }, async ({ token, instance_id, pinned_email, enabled, dry_run: preview }) => {
		const session = auth(token); if (!session) return authRequired(); const input = { instance_id, ...(pinned_email !== undefined ? { pinned_email } : {}), ...(enabled !== undefined ? { enabled } : {}) }; const denied = await requirePermission(safetyFor(token), "write", "gmail_scout_config_set", input); if (denied) return denied;
		if (preview) return dryRun(safetyFor(token), "gmail_scout_config_set", "configure the Gmail Scout source", input, { endpoint: `/v1/instances/${encodeURIComponent(instance_id)}/gmail-scout/config`, method: "PUT" });
		const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/gmail-scout/config`, session, { method: "PUT", body: JSON.stringify({ ...(pinned_email !== undefined ? { pinnedEmail: pinned_email } : {}), ...(enabled !== undefined ? { enabled } : {}) }) }, env) as { error?: string }; if (data.error) return text(`Error: ${data.error}`); await audit(safetyFor(token), { tool: "gmail_scout_config_set", action: "completed", input, result: data }); return jsonText(data);
	});
	server.tool("gmail_scout_scan", "Read Gmail job alerts and add newly discovered leads to this Scout's private job_leads collection as new. It never sends, archives, marks, or modifies mail; explicit lead apply remains required. Call with dry_run first.", { token: z.string().optional(), instance_id: z.string(), dry_run: z.boolean().optional() }, async ({ token, instance_id, dry_run: preview }) => {
		const session = auth(token); if (!session) return authRequired(); const input = { instance_id }; const denied = await requirePermission(safetyFor(token), "write", "gmail_scout_scan", input); if (denied) return denied;
		if (preview) return dryRun(safetyFor(token), "gmail_scout_scan", "scan the configured Gmail mailbox for job alerts", input, { endpoint: `/v1/instances/${encodeURIComponent(instance_id)}/gmail-scout/scan`, method: "POST" });
		const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/gmail-scout/scan`, session, { method: "POST" }, env) as { error?: string }; if (data.error) return text(`Error: ${data.error}`); await audit(safetyFor(token), { tool: "gmail_scout_scan", action: "completed", input, result: data }); return jsonText(data);
	});
}
