import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Local CLI browser research (#945) — the settings and read-only status of a general agent whose
 * browser research is driven by a Codex or Claude Code CLI signed in on the owner's machine.
 *
 * Starting and cancelling a run are not here yet: the runner half (#944) does not exist, so a
 * started run could only fail `runner_unsupported`. They join this module with it. Ungated: the
 * API answers 409 for an agent that is not a local browser agent.
 */
export function registerLocalBrowserTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const base = (id: string) => `/v1/instances/${encodeURIComponent(id)}/local-browser`;

	server.tool(
		"local_browser_preflight",
		"Is this local browser research agent ready to run, and if not, the one step that fixes it? Checks the saved settings against the agent's limits, whether a runner is connected, whether that runner supports local browser research, and consent for the signed-in browser profile. Each check is ok true, false, or null when it cannot be known before a run — engine sign-in is checked by the runner per run. Read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "local_browser_preflight", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`${base(instance_id)}/preflight`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"get_instance_local_browser_settings",
		"A local browser research agent's settings: what this instance chose (settings), the policy a run would start with (effective — engine, sign-in mode, workspace, browser profile, sites, limits, retention, result collection), the agent's ceilings (capability) and the runner it is pinned to. problem is set when saved settings no longer fit the agent. Contains no credential, cookie or key. Read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_local_browser_settings", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`${base(instance_id)}/settings`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	const limits = z
		.object({
			max_minutes: z.coerce.number().int().optional(),
			max_pages: z.coerce.number().int().optional(),
			max_actions: z.coerce.number().int().optional(),
			max_concurrent: z.coerce.number().int().optional(),
		})
		.nullable()
		.optional();

	server.tool(
		"set_instance_local_browser_settings",
		"Change a local browser research agent's settings. Only the fields you pass change; null resets one to the agent's default. Refused with the reason when a value is outside what the agent allows: an engine it does not offer, api-key sign-in on a subscription-only agent, a workspace path that is not under the runner's home written ~/…, a site outside the agent's list, or a limit above its ceiling. The runner machine is chosen with set_instance_runner_node, not here. Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			engine: z.enum(["claude", "codex"]).nullable().optional().describe("Which signed-in CLI drives the browser."),
			auth_mode: z.enum(["subscription", "machine", "api-key"]).nullable().optional().describe("How that CLI signs in. subscription and machine never use a provider API key."),
			workspace_path: z.string().nullable().optional().describe('A folder under the runner\'s home, e.g. "~/jobs". null returns to a managed scratch folder per run.'),
			browser_profile: z.enum(["isolated", "default"]).nullable().optional().describe("isolated is a throwaway profile; default is your signed-in profile and needs your consent."),
			allow_domains: z.array(z.string()).nullable().optional().describe("Hostnames the research may visit, each covering its subdomains. Must be within the agent's own list when it has one."),
			deny_domains: z.array(z.string()).nullable().optional().describe("Hostnames never to visit. Always wins over an allowed one."),
			limits: limits.describe("Per-run limits, each at most the agent's ceiling. null resets all of them."),
			trace_retention_days: z.coerce.number().int().nullable().optional().describe("How long a run's trace is kept, 1 to 90 days."),
			collection: z.object({ name: z.string(), key_field: z.string().optional() }).nullable().optional().describe("The collection accepted findings are stored in, and the field that marks a duplicate."),
			dry_run: z.boolean().optional().describe("Preview the change without saving it."),
		},
		async ({ token, instance_id, dry_run, ...fields }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const patch: Record<string, unknown> = {};
			if (fields.engine !== undefined) patch.engine = fields.engine;
			if (fields.auth_mode !== undefined) patch.authMode = fields.auth_mode;
			if (fields.workspace_path !== undefined) patch.workspace = fields.workspace_path === null ? { kind: "scratch" } : { kind: "path", path: fields.workspace_path };
			if (fields.browser_profile !== undefined) patch.browserProfile = fields.browser_profile;
			if (fields.allow_domains !== undefined || fields.deny_domains !== undefined) {
				patch.access = {
					...(fields.allow_domains !== undefined ? { allowDomains: fields.allow_domains } : {}),
					...(fields.deny_domains !== undefined ? { denyDomains: fields.deny_domains } : {}),
				};
			}
			if (fields.limits !== undefined) {
				const l = fields.limits;
				patch.limits = l === null ? null : { ...(l.max_minutes !== undefined ? { maxMinutes: l.max_minutes } : {}), ...(l.max_pages !== undefined ? { maxPages: l.max_pages } : {}), ...(l.max_actions !== undefined ? { maxActions: l.max_actions } : {}), ...(l.max_concurrent !== undefined ? { maxConcurrent: l.max_concurrent } : {}) };
			}
			if (fields.trace_retention_days !== undefined) patch.traceRetentionDays = fields.trace_retention_days;
			if (fields.collection !== undefined) patch.collection = fields.collection === null ? null : { name: fields.collection.name, ...(fields.collection.key_field ? { keyField: fields.collection.key_field } : {}) };
			const input = { instance_id, ...patch };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_local_browser_settings", input);
			if (denied) return denied;
			if (!Object.keys(patch).length) return text("Error: pass at least one setting to change.");
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_local_browser_settings", `update local browser settings: ${Object.keys(patch).join(", ")}`, input, { endpoint: `${base(instance_id)}/settings`, method: "PUT" });
			}
			const data = (await authedCall(`${base(instance_id)}/settings`, sessionToken, { method: "PUT", body: JSON.stringify(patch) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_instance_local_browser_settings", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_local_browser_runs",
		"A local browser research agent's runs, newest first — or, with run_id, one run with its trace: each browser page, consent request, pause and finding, in order, redacted of cookies, passwords, form values and keys. A paused run says why in pauseReason; a failed one gives errorCode and error, which name the step that fixes it. Page a long trace with after, the nextAfter of the previous call. Read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			run_id: z.string().optional().describe("One run's id, as this tool listed it. Copy it exactly."),
			after: z.coerce.number().int().optional().describe("With run_id: return trace events after this sequence number."),
			limit: z.coerce.number().int().optional().describe("How many runs, or trace events with run_id, to return."),
		},
		async ({ token, instance_id, run_id, after, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_local_browser_runs", { instance_id, run_id });
			if (denied) return denied;
			if (!run_id) {
				const data = (await authedCall(`${base(instance_id)}/runs${limit ? `?limit=${limit}` : ""}`, sessionToken, {}, env)) as { error?: string };
				return data.error ? text(`Error: ${data.error}`) : jsonText(data);
			}
			const runPath = `${base(instance_id)}/runs/${encodeURIComponent(run_id)}`;
			const run = (await authedCall(runPath, sessionToken, {}, env)) as { error?: string };
			if (run.error) return text(`Error: ${run.error}`);
			const q = new URLSearchParams();
			if (after) q.set("after", String(after));
			if (limit) q.set("limit", String(limit));
			const trace = (await authedCall(`${runPath}/events${q.toString() ? `?${q}` : ""}`, sessionToken, {}, env)) as { error?: string };
			return jsonText({ run, trace: trace.error ? { error: trace.error } : trace });
		},
	);
}
