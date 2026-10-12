import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/** The coder brain switch (#1025 §1) and the product-owner triage reports it gates (#1027). */
export function registerCoderBrainTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const auth = (token?: string) => tokenFor(token);
	server.tool(
		"set_coder_brain",
		"Turn a coder instance's brain on or off, and its scheduled product-owner triage (#1027). Both default OFF; triage needs the brain on and a coding instance. Turning triage on creates a `run_po_triage` cron trigger if the instance has none — hourly at a minute derived from the instance (never :00), Australia/Melbourne, dry run (reports and digests only, no comments, no queueing). Change its schedule, timezone or `dryRun` with set_instance_trigger, or add more windows with create_instance_trigger (windows firing in the same minute run one wake). Turning the brain or triage off disables every `run_po_triage` trigger; nothing is deleted. Never touches permissions, tokens, secrets, payments or delivery mode. Call with dry_run first.",
		{ token: z.string().optional(), instance_id: z.string(), enabled: z.boolean().optional(), po_enabled: z.boolean().optional(), dry_run: z.boolean().optional() },
		async ({ token, instance_id, enabled, po_enabled, dry_run: preview }) => {
			const session = auth(token);
			if (!session) return authRequired();
			const input = { instance_id, ...(enabled !== undefined ? { enabled } : {}), ...(po_enabled !== undefined ? { po_enabled } : {}) };
			const denied = await requirePermission(safetyFor(token), "write", "set_coder_brain", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/coder-brain`;
			if (preview) return dryRun(safetyFor(token), "set_coder_brain", "change the coder brain / product-owner triage switch", input, { endpoint, method: "PUT" });
			const data = (await authedCall(endpoint, session, { method: "PUT", body: JSON.stringify({ ...(enabled !== undefined ? { enabled } : {}), ...(po_enabled !== undefined ? { poEnabled: po_enabled } : {}) }) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_coder_brain", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
	server.tool(
		"po_triage_reports",
		"Read a coder instance's product-owner triage (#1027): the brain switch, its `run_po_triage` triggers, and the most recent wake reports. Each report lists every open issue it read with its category (`waiting_on_human`, `blocked`, `needs_detail`, `ready`), a one-line reason and the action taken (`queued`, `would_queue`, `already_queued`, `held`, `commented`, …), plus counts and the digest sent (null when nothing changed). No issue bodies or comments are stored. Read-only.",
		{ token: z.string().optional(), instance_id: z.string(), limit: z.coerce.number().int().min(1).max(50).optional() },
		async ({ token, instance_id, limit }) => {
			const session = auth(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "po_triage_reports", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/po-triage/reports${limit ? `?limit=${limit}` : ""}`, session, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
}
