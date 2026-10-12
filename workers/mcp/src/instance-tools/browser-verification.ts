import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Browser verification, per instance (#1031) — the same settings and state the console's Browser
 * verification card shows, from the same routes (`workers/api/src/routes/instances-browser-verification.ts`).
 *
 * Capability, attachment and consent stay separate: the capability is the agent's declaration (an
 * owner can only turn a declared one on), the machine is pinned with set_instance_runner_node, and
 * site consent is set_local_browser_consent. Which events push is the instance's notification policy.
 */
export function registerBrowserVerificationTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"get_instance_browser_verification",
		"Read one instance's browser verification settings (#1031): `enabled`, `runtime` (pinned — only the machine it is pinned to; any_eligible — any eligible machine of yours), `fallback` when no eligible machine is available (wait up to `waitLimitMinutes`, or mark_unverifiable at once), `takeover` when a run needs a person (prompt — request a takeover; never — end the attempt instead) and `allowMobile`. Also `capability.declared` (does the agent declare a local browser — only then can verification be on), the `runnerNode` it is pinned to, and `notificationEvents`, the events it raises — whether those push is decided by get_instance_notification_policy, not here. Read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_browser_verification", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-verification`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_instance_browser_verification",
		"Change one instance's browser verification settings (#1031). Only the fields you pass change. Turning it on needs an agent that DECLARES a local browser — this activates a declared capability, it cannot add one — and is refused with the reason otherwise; any value out of range is refused, never clamped. It does not pin a machine (set_instance_runner_node), grant site consent (set_local_browser_consent) or change notifications (set_instance_notification_policy). Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			enabled: z.boolean().optional().describe("Turn browser verification on or off for this instance."),
			runtime: z.enum(["pinned", "any_eligible"]).optional().describe("pinned: only the machine this agent is pinned to. any_eligible: any eligible machine, the pinned one first."),
			fallback: z.enum(["wait", "mark_unverifiable"]).optional().describe("When no eligible machine is available: wait up to wait_limit_minutes, or mark the item unverifiable at once."),
			wait_limit_minutes: z.coerce.number().int().optional().describe("How long `wait` waits, 1 to 1440 minutes."),
			takeover: z.enum(["prompt", "never"]).optional().describe("When a run needs a person (sign-in, captcha): prompt requests a takeover; never ends the attempt instead."),
			allow_mobile: z.boolean().optional().describe("May a takeover be answered from a phone, or only at the machine."),
			dry_run: z.boolean().optional().describe("Preview the change without saving it."),
		},
		async ({ token, instance_id, dry_run, ...fields }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const patch: Record<string, unknown> = {};
			if (fields.enabled !== undefined) patch.enabled = fields.enabled;
			if (fields.runtime !== undefined) patch.runtime = fields.runtime;
			if (fields.fallback !== undefined) patch.fallback = fields.fallback;
			if (fields.wait_limit_minutes !== undefined) patch.waitLimitMinutes = fields.wait_limit_minutes;
			if (fields.takeover !== undefined) patch.takeover = fields.takeover;
			if (fields.allow_mobile !== undefined) patch.allowMobile = fields.allow_mobile;
			const input = { instance_id, ...patch };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_browser_verification", input);
			if (denied) return denied;
			if (!Object.keys(patch).length) return text("Error: pass at least one setting to change.");
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/browser-verification`;
			if (dry_run) return dryRun(safetyFor(token), "set_instance_browser_verification", `update browser verification: ${Object.keys(patch).join(", ")}`, input, { endpoint, method: "PUT" });
			const data = (await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify(patch) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_instance_browser_verification", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_eligible_browser_runtimes",
		"Which of your machines could run this instance's browser verification now (#1031), each with the facts apart: `heartbeat` (is `pags up` reporting in), `attached` (does the relay hold this agent's socket there — transport only), `health` (did the runner behind it answer /health), `runnerVersion`, and `eligible` with `reason` (not_attached | unhealthy | runner_too_old | not_probed) and `detail` naming the fix. `selected` is the machine the instance's `runtime` setting would use; null means the `fallback` applies. Probes each machine live; read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_eligible_browser_runtimes", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-verification/runtimes`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	// ── Durable takeovers (#1031) — the same rows the console's takeover banner and list read ──
	const TAKEOVER_STATES = ["requested", "active", "resumed", "ended", "expired"] as const;
	const TAKEOVER_SUBJECTS = ["local_browser_run", "runtime_task", "manual"] as const;
	const TAKEOVER_REASONS = ["login_required", "captcha", "consent_required", "access_blocked", "paywall", "write_affordance", "manual"] as const;

	server.tool(
		"browser_takeover_list",
		"List one instance's browser takeovers, newest first (#1031). A takeover is recorded BEFORE any remote control is shown, and moves requested → active (opened) → resumed (handed back to the run), or ended (declined, or the run finished) / expired (nobody came before expiresAt). Each row carries its subject (local_browser_run / runtime_task / manual and its id), reason, mobileAllowed, endReason and times — ids only, never a page URL, frame, cookie, token or session. Filter by state or subject. Read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			state: z.enum(TAKEOVER_STATES).optional().describe("Only takeovers in this state."),
			subject_kind: z.enum(TAKEOVER_SUBJECTS).optional().describe("Only takeovers about this kind of thing."),
			subject_id: z.string().optional().describe("Only takeovers about this run or task id."),
			limit: z.coerce.number().int().min(1).max(100).optional(),
		},
		async ({ token, instance_id, state, subject_kind, subject_id, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "browser_takeover_list", { instance_id });
			if (denied) return denied;
			const q = new URLSearchParams();
			if (state) q.set("state", state);
			if (subject_kind) q.set("subject_kind", subject_kind);
			if (subject_id) q.set("subject_id", subject_id);
			if (limit) q.set("limit", String(limit));
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-takeovers${q.size ? `?${q}` : ""}`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"browser_takeover_get",
		"One browser takeover by id (#1031): its state (requested | active | resumed | ended | expired), subject, reason, mobileAllowed, endReason and times. Read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			takeover_id: z.string().describe("Takeover id from browser_takeover_list or browser_takeover_request."),
		},
		async ({ token, instance_id, takeover_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "browser_takeover_get", { instance_id, takeover_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-takeovers/${encodeURIComponent(takeover_id)}`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"browser_takeover_request",
		"Ask the owner to take over a browser (#1031): records a `requested` takeover and notifies them with a link to it (their notification policy decides whether it pushes). Idempotent per subject — while one is live, asking again answers it with created:false. subject_kind local_browser_run needs a PAUSED run (its pause reason is used); runtime_task needs the runner task id; manual needs neither. Refused when the instance's browser verification takeover is \"never\". Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			subject_kind: z.enum(TAKEOVER_SUBJECTS).optional().describe("What is waiting: a local browser run, a runner task, or manual (default)."),
			subject_id: z.string().optional().describe("The run id or runner task id it is about."),
			reason: z.enum(TAKEOVER_REASONS).optional().describe("Why a person is needed. Defaults to the run's pause reason, else manual."),
			dry_run: z.boolean().optional().describe("Preview the request without recording it."),
		},
		async ({ token, instance_id, subject_kind, subject_id, reason, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, subject_kind, subject_id, reason };
			const denied = await requirePermission(safetyFor(token), "write", "browser_takeover_request", input);
			if (denied) return denied;
			const body = { ...(subject_kind ? { subjectKind: subject_kind } : {}), ...(subject_id ? { subjectId: subject_id } : {}), ...(reason ? { reason } : {}) };
			if (dry_run) return dryRun(safetyFor(token), "browser_takeover_request", "ask the owner to take over a browser", input, { endpoint: `/v1/instances/${encodeURIComponent(instance_id)}/browser-takeovers`, method: "POST", body });
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-takeovers`, sessionToken, { method: "POST", body: JSON.stringify(body) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "browser_takeover_request", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"browser_takeover_transition",
		"Move a browser takeover (#1031): `active` — it is being taken over now (pass device \"mobile\" from a phone; refused when the owner turned mobile takeover off); `resumed` — hand it back, which RESUMES the paused run or runner task; `ended` — decline it (a runner task's takeover session is ended too; a paused local browser run stays paused until resumed or cancelled). `expired` is set only when a request runs out of time. Repeating a move already made is a no-op. Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			takeover_id: z.string().describe("Takeover id from browser_takeover_list."),
			state: z.enum(["active", "resumed", "ended"]).describe("The state to move it to."),
			device: z.enum(["mobile", "desktop"]).optional().describe("Where it is being taken over from, for the owner's mobile preference."),
			dry_run: z.boolean().optional().describe("Preview the move without making it."),
		},
		async ({ token, instance_id, takeover_id, state, device, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, takeover_id, state, device };
			// `runtime`: resuming hands a paused run or task back to the machine.
			const denied = await requirePermission(safetyFor(token), "runtime", "browser_takeover_transition", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/browser-takeovers/${encodeURIComponent(takeover_id)}`;
			if (dry_run) return dryRun(safetyFor(token), "browser_takeover_transition", `move takeover ${takeover_id} to ${state}`, input, { endpoint, method: "PATCH" });
			const data = (await authedCall(endpoint, sessionToken, { method: "PATCH", body: JSON.stringify({ state, ...(device ? { device } : {}) }) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "browser_takeover_transition", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
