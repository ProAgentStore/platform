import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/** Exact website questions and remembered decisions, shared by all browser agents (#1480). */
export function registerWebsiteAccessTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const address = { token: z.string().optional(), instance_id: z.string().describe("Exact private instance ID.") };
	const request = { ...address, request_id: z.string().describe("Immutable website request ID returned by a run or list_instance_website_requests.") };
	const base = (id: string) => `/v1/instances/${encodeURIComponent(id)}`;
	server.tool("list_instance_website_requests", "List this agent's durable website questions, their exact hostnames, saved answers and unique owner links. Read-only; opening a link or reading a request never grants access.", { ...address, cursor: z.string().optional() }, async ({ token, instance_id, cursor }) => {
		const session = tokenFor(token); if (!session) return authRequired();
		const denied = await requirePermission(safetyFor(token), "read", "list_instance_website_requests", { instance_id }); if (denied) return denied;
		return jsonText(await authedCall(`${base(instance_id)}/website-requests${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, session, {}, env));
	});
	server.tool("get_instance_website_request", "Read one exact website question and its saved answer. The request binds its owner, agent, hostname and original run; this read changes nothing.", request, async ({ token, instance_id, request_id }) => {
		const session = tokenFor(token); if (!session) return authRequired();
		const denied = await requirePermission(safetyFor(token), "read", "get_instance_website_request", { instance_id, request_id }); if (denied) return denied;
		return jsonText(await authedCall(`${base(instance_id)}/website-requests/${encodeURIComponent(request_id)}`, session, {}, env));
	});
	server.tool("list_instance_website_decisions", "Read remembered allow and deny decisions for this agent's exact hostnames. Decisions apply in ask_once mode; changing submission permissions is separate.", address, async ({ token, instance_id }) => {
		const session = tokenFor(token); if (!session) return authRequired();
		const denied = await requirePermission(safetyFor(token), "read", "list_instance_website_decisions", { instance_id }); if (denied) return denied;
		return jsonText(await authedCall(`${base(instance_id)}/website-grants`, session, {}, env));
	});
	server.tool("answer_instance_website_request", "Record the owner's explicit approval or denial of the exact website in this request and remember it for this agent. Approval may resume only the original run if it still waits on that question; it never starts a new run or approves submission. Requires runtime and write scopes. Read the request first; use only when the owner authorized this website decision, otherwise give them its unique link. Repeated answers never restore a revoked decision.", { ...request, decision: z.enum(["approve", "deny"]), dry_run: z.boolean().optional() }, async ({ token, instance_id, request_id, decision, dry_run }) => {
		const session = tokenFor(token); if (!session) return authRequired();
		const input = { instance_id, request_id, decision };
		const denied = await requirePermission(safetyFor(token), "runtime", "answer_instance_website_request", input) ?? await requirePermission(safetyFor(token), "write", "answer_instance_website_request", input); if (denied) return denied;
		const endpoint = `${base(instance_id)}/website-requests/${encodeURIComponent(request_id)}/answer`;
		const body = { decision };
		if (dry_run) return dryRun(safetyFor(token), "answer_instance_website_request", "record the website decision and resume only its original waiting run", input, { endpoint, method: "POST", body });
		const data = await authedCall(endpoint, session, { method: "POST", body: JSON.stringify(body) }, env) as { error?: unknown };
		if (data.error) return jsonText(data);
		await audit(safetyFor(token), { tool: "answer_instance_website_request", action: "completed", input, result: data });
		return jsonText(data);
	});
	server.tool("revoke_instance_website_decision", "Forget one remembered exact-host allow or deny decision for this agent. A future ask_once visit asks again; this does not cancel an active run or change submission policy. An old answered link cannot restore the revoked decision.", { ...address, hostname: z.string(), dry_run: z.boolean().optional() }, async ({ token, instance_id, hostname, dry_run }) => {
		const session = tokenFor(token); if (!session) return authRequired();
		const input = { instance_id, hostname };
		const denied = await requirePermission(safetyFor(token), "write", "revoke_instance_website_decision", input); if (denied) return denied;
		if (!hostname.trim()) return text("Error: hostname is required");
		const endpoint = `${base(instance_id)}/website-grants/${encodeURIComponent(hostname)}`;
		if (dry_run) return dryRun(safetyFor(token), "revoke_instance_website_decision", "forget the exact-host website decision", input, { endpoint, method: "DELETE" });
		const data = await authedCall(endpoint, session, { method: "DELETE" }, env) as { error?: unknown };
		if (data.error) return jsonText(data);
		await audit(safetyFor(token), { tool: "revoke_instance_website_decision", action: "completed", input, result: data });
		return jsonText(data);
	});
}
