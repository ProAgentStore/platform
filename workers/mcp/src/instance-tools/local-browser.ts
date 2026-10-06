import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Local CLI browser research (#945) — the settings and read-only status of a general agent whose
 * browser research is driven by a Codex or Claude Code CLI signed in on the owner's machine.
 *
 * Start, cancel and resume (#944) drive a run on the owner's machine; reading a run pulls its latest
 * state from the runner first. Ungated: the API answers 409 for an agent that is not a local
 * browser agent.
 */
export function registerLocalBrowserTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	// Every path below is written out in full, never built by a helper: the MCP-parity check reads
	// these literals to prove each console capability has an MCP path (scripts/lib/api-calls.mjs).

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
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/preflight`, sessionToken, {}, env)) as { error?: string };
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
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/settings`, sessionToken, {}, env)) as { error?: string };
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
				return dryRun(safetyFor(token), "set_instance_local_browser_settings", `update local browser settings: ${Object.keys(patch).join(", ")}`, input, { endpoint: `/v1/instances/${encodeURIComponent(instance_id)}/local-browser/settings`, method: "PUT" });
			}
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/settings`, sessionToken, { method: "PUT", body: JSON.stringify(patch) }, env)) as { error?: string };
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
				const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs${limit ? `?limit=${limit}` : ""}`, sessionToken, {}, env)) as { error?: string };
				return data.error ? text(`Error: ${data.error}`) : jsonText(data);
			}
			const run = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs/${encodeURIComponent(run_id)}`, sessionToken, {}, env)) as { error?: string };
			if (run.error) return text(`Error: ${run.error}`);
			const q = new URLSearchParams();
			if (after) q.set("after", String(after));
			if (limit) q.set("limit", String(limit));
			const trace = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs/${encodeURIComponent(run_id)}/events${q.toString() ? `?${q}` : ""}`, sessionToken, {}, env)) as { error?: string };
			return jsonText({ run, trace: trace.error ? { error: trace.error } : trace });
		},
	);

	server.tool(
		"start_local_browser_run",
		"Start a research run on the owner's machine: the Codex or Claude Code CLI signed in there researches the objective in a real browser, read-only, within the instance's sites and limits, and records findings with the page each came from. Returns the run; follow it with list_local_browser_runs. A run that cannot reach a runner ends at once with errorCode saying why — runner_offline, runner_unsupported (update the CLI) or runner_rejected. Pass request_id to make a retry safe: the same request_id returns the same run. Call local_browser_preflight first, and this with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			objective: z.string().min(1).max(4000).describe("What to research, in plain words."),
			request_id: z.string().max(100).optional().describe("Your idempotency key — letters, digits, _ . : or -."),
			dry_run: z.boolean().optional().describe("Preview without starting anything."),
		},
		async ({ token, instance_id, objective, request_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, objective, request_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "start_local_browser_run", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "start_local_browser_run", "start a local browser research run on the owner's machine", input, { endpoint: `/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs`, method: "POST" });
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs`, sessionToken, { method: "POST", body: JSON.stringify({ objective, ...(request_id ? { requestId: request_id } : {}) }) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "start_local_browser_run", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	// No dry run, on `stop_instance_loop`'s reasoning: the call is fully determined by one run id,
	// `list_local_browser_runs` answers "which run is that?", and stopping is the safe direction —
	// research is read-only, and findings already recorded stay on the trace.
	server.tool(
		"cancel_local_browser_run",
		"Stop an active local browser research run: the run ends cancelled and the CLI on the owner's machine is told to stop. Findings already recorded stay on the run's trace. Refused once the run has ended.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			run_id: z.string().describe("The run's id, from start_local_browser_run or list_local_browser_runs. Copy it exactly."),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, run_id };
			const denied = await requirePermission(safetyFor(token), "write", "cancel_local_browser_run", input);
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs/${encodeURIComponent(run_id)}/cancel`, sessionToken, { method: "POST" }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "cancel_local_browser_run", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"resume_local_browser_run",
		"Continue a paused local browser research run once the owner has done what it waited for: allowed the site (allow_domains in set_instance_local_browser_settings), solved the captcha, or signed in, in the browser on that machine. The runner gets the owner's current decisions and carries on; a site still not allowed is skipped. Refused unless the run is paused. Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			run_id: z.string().describe("The paused run's id. Copy it exactly."),
			dry_run: z.boolean().optional().describe("Preview without resuming."),
		},
		async ({ token, instance_id, run_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, run_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "resume_local_browser_run", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "resume_local_browser_run", "resume a paused local browser research run", input, { endpoint: `/v1/instances/${instance_id}/local-browser/runs/${run_id}/resume`, method: "POST" });
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs/${encodeURIComponent(run_id)}/resume`, sessionToken, { method: "POST" }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "resume_local_browser_run", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_local_browser_consent",
		"The owner's live decisions for a local browser research agent: which sites a run may open without pausing (navigate, allow), which it must never open (deny), and whether research may use the owner's signed-in browser profile (scope signed_in_profile, domain *). Expired decisions are not listed. Read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_local_browser_consent", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/consent`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_local_browser_consent",
		"Record the owner's decision for local browser research: allow or deny opening a site (scope navigate, with domain — it covers the site's subdomains), or allow or deny using their signed-in browser profile (scope signed_in_profile). decision null withdraws a decision. A paused run does not pick this up by itself: call resume_local_browser_run after it. Only record a decision the owner actually made. Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			scope: z.enum(["navigate", "signed_in_profile"]).describe("navigate is one site; signed_in_profile is the owner's own browser profile."),
			domain: z.string().optional().describe('The site, e.g. "seek.com.au". Required for navigate.'),
			decision: z.enum(["allow", "deny"]).nullable().describe("allow, deny, or null to withdraw the decision."),
			ttl_days: z.coerce.number().int().optional().describe("Let the decision expire after this many days, 1 to 365. Omit to keep it until withdrawn."),
			dry_run: z.boolean().optional().describe("Preview without recording anything."),
		},
		async ({ token, instance_id, scope, domain, decision, ttl_days, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const body = { scope, ...(domain ? { domain } : {}), decision, ...(ttl_days !== undefined ? { ttlDays: ttl_days } : {}) };
			const input = { instance_id, ...body };
			const denied = await requirePermission(safetyFor(token), "write", "set_local_browser_consent", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "set_local_browser_consent", `record ${decision ?? "no"} decision for ${scope === "navigate" ? domain : "the signed-in profile"}`, input, { endpoint: `/v1/instances/${instance_id}/local-browser/consent`, method: "PUT" });
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/consent`, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_local_browser_consent", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"review_local_browser_finding",
		"Save or skip one finding of a finished local browser research run, as the owner decided. save writes it to the results collection the agent is set up with — unless that collection already holds the same key, which comes back as a duplicate review instead of a write; pass force true to save it anyway. skip records the decision and writes nothing. index is the finding's position in the run's result.findings, from 0. Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			run_id: z.string().describe("The run's id, from list_local_browser_runs. Copy it exactly."),
			index: z.coerce.number().int().min(0).describe("The finding's position in result.findings, from 0."),
			decision: z.enum(["save", "skip"]).describe("save writes it to the collection; skip writes nothing."),
			force: z.boolean().optional().describe("With save: save even though the collection already holds this key."),
			dry_run: z.boolean().optional().describe("Preview without saving or skipping."),
		},
		async ({ token, instance_id, run_id, index, decision, force, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, run_id, index, decision, ...(force ? { force } : {}) };
			const denied = await requirePermission(safetyFor(token), "write", "review_local_browser_finding", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "review_local_browser_finding", `${decision} finding ${index}`, input, { endpoint: `/v1/instances/${instance_id}/local-browser/runs/${run_id}/findings/${index}/${decision}`, method: "POST" });
			const data = (
				decision === "save"
					? await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs/${encodeURIComponent(run_id)}/findings/${index}/save`, sessionToken, { method: "POST", body: JSON.stringify(force ? { force: true } : {}) }, env)
					: await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/local-browser/runs/${encodeURIComponent(run_id)}/findings/${index}/skip`, sessionToken, { method: "POST" }, env)
			) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "review_local_browser_finding", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
