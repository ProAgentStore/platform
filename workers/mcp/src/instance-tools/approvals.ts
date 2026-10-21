import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The account approval gate over MCP (#1268): read the gate, read where a held change stands, and change the gate's settings.
 *
 * What is deliberately NOT here is any way to approve or deny. A change the gate holds is decided by the OWNER in the console
 * or from the push link; the API refuses an approve or deny that arrives with MCP's client marker, so no tool — and no agent
 * holding the owner's token — can wave its own request through. Every other mutating tool already reaches the gate
 * transparently: a held call answers `{status: "approval_pending", approval_id, poll, ...}` and `approval_status` follows it.
 */
export function registerApprovalTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const token = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");

	server.tool(
		"approval_status",
		"Read-only. Where a change held by the account approval gate (#1268) stands. With approval_id (from an `approval_pending` answer, or the `poll` URL's last segment): `status` is pending | approved | applied | denied | cancelled | expired | failed, with the exact `diff` the owner is asked to approve, `expiresAt`, the audit `events` (request, notification, decision with the device, apply result) and, once it ran, `result` (what the change answered; a `failed` one says why, e.g. the target changed since it was requested). Without approval_id: the account's recent requests and how many are pending. Nothing is decided by this tool; the owner approves or denies from their phone or the console.",
		{ token, approval_id: z.string().optional().describe("The approval_id from an approval_pending response. Copy it exactly. Omit to list recent requests.") },
		async ({ token: t, approval_id }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(t), "read", "approval_status", { approval_id });
			if (denied) return denied;
			const path = approval_id ? `/v1/approvals/${encodeURIComponent(approval_id)}` : "/v1/approvals";
			const data = (await authedCall(path, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"get_approval_gate",
		"Read-only. The account's approval gate (#1268): `enabled`, the gated `actions` (coder_create, instance_create, repo_add, runner_repin, engine_model, connector_pin, grants_consent, instance_cancel_delete, tool_allowlist), `expirySeconds`, how many requests are `pending`, and every `available` action with its label. While enabled, a gated change made through any tool is held and answers `approval_pending`. Contains no credential.",
		{ token },
		async ({ token: t }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(t), "read", "get_approval_gate", {});
			if (denied) return denied;
			const data = (await authedCall("/v1/approval-gate", sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_approval_gate",
		"Change the account's approval gate (#1268): `enabled`, the gated `actions` (replaces the list) and `expiry_seconds` (60 to 604800; default 86400). Omitted fields keep their value; turning it on with no list gates the defaults (coder_create, instance_create, repo_add). Making the gate STRONGER applies at once. Making it WEAKER — turning it off or removing an action — while it is enabled is itself held: the answer is `approval_pending` and nothing changes until the owner approves it from their phone (follow it with approval_status). Read the result back with get_approval_gate. Call with dry_run first.",
		{
			token,
			enabled: z.boolean().optional().describe("Turn the gate on or off."),
			actions: z.array(z.string()).max(20).optional().describe("The action ids to gate; replaces the list. See get_approval_gate `available`."),
			expiry_seconds: z.coerce.number().int().min(60).max(604800).optional().describe("How long a held request stays open for approval."),
			dry_run: z.boolean().optional().describe("Report the change without making it."),
		},
		async ({ token: t, enabled, actions, expiry_seconds, dry_run }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const body = { ...(enabled !== undefined ? { enabled } : {}), ...(actions !== undefined ? { actions } : {}), ...(expiry_seconds !== undefined ? { expirySeconds: expiry_seconds } : {}) };
			const input = { ...(enabled !== undefined ? { enabled } : {}), ...(actions !== undefined ? { actions } : {}), ...(expiry_seconds !== undefined ? { expiry_seconds } : {}) };
			const denied = await requirePermission(safetyFor(t), "write", "set_approval_gate", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(t), "set_approval_gate", "change the account approval gate", input, { endpoint: "/v1/approval-gate", method: "PUT", body });
			const data = (await authedCall("/v1/approval-gate", sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(t), { tool: "set_approval_gate", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
}
