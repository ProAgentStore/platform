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
		"Turn a coder instance's brain on or off, and its scheduled product-owner triage (#1027), and set the brain's knobs (#1025). Set `pilot_model` separately for the controller that drives the coding CLI: Sonnet is the default; claude-haiku-5-5 is an experimental canary with fixed Sonnet fallback. The default uses Anthropic when configured, otherwise keeps the inherited Cloudflare route. The Haiku canary and its Sonnet fallback require your Anthropic API key; provider token charges are separate from the coding CLI subscription; it never changes the advisory Brain or CLI model. Both switches default OFF and need a coding instance; triage needs the brain on. With the brain on, a question the coder stops on waits `human_timeout_minutes` (default 30) for a person; then the brain may decide — only inside its hard guardrails (never owner-only choices, permissions/tokens/secrets, payments/payouts, deletions or delivery mode) and at or above `confidence_threshold` (default 0.8), at most `max_decisions_per_run` (default 3) per run, with `model` on the owner's own provider key — or escalate; after `escalation_timeout_minutes` (default 60) more, the coder finishes what it can and closes the issue with what is left. A person's answer wins at any point. Turning triage on creates a `run_po_triage` cron trigger if the instance has none — hourly at a minute derived from the instance (never :00), Australia/Melbourne, and live: it comments and queues ready issues. Pass `po_dry_run: true` to create it as a dry run instead (reports and digests only, no comments, no queueing); an existing trigger keeps its own setting. Change its schedule, timezone or `dryRun` with set_instance_trigger, or add more windows with create_instance_trigger (windows firing in the same minute run one wake). Turning the brain or triage off disables every `run_po_triage` trigger; nothing is deleted. Never touches permissions, tokens, secrets, payments or delivery mode. Call with dry_run first.",
		{
			token: z.string().optional(),
			instance_id: z.string(),
			enabled: z.boolean().optional(),
			po_enabled: z.boolean().optional(),
			model: z.string().optional().describe("This coder's Brain model (#1043) — the same setting as the console's Brain card: a brain-model catalogue id, e.g. claude-sonnet-4-6 or @cf/meta/llama-4-scout-17b-16e-instruct (Cloudflare needs stored Cloudflare credentials). Advisory and orchestration only; it never changes the coding engine or how it signs in."),
			pilot_model: z.string().optional().describe("Coding Pilot controller model, separate from advisory model and CLI engine: claude-sonnet-4-6 (default) or claude-haiku-5-5 (experimental canary). Default uses Anthropic when configured, otherwise the inherited Cloudflare route. The Haiku canary and fixed claude-sonnet-4-6 fallback require your Anthropic API key; provider charges are separate from the coding CLI subscription. Read back pilot.model, fallbackModel and options with po_triage_reports."),
			human_timeout_minutes: z.coerce.number().int().min(1).max(1440).optional(),
			escalation_timeout_minutes: z.coerce.number().int().min(1).max(1440).optional(),
			max_decisions_per_run: z.coerce.number().int().min(0).max(20).optional(),
			confidence_threshold: z.coerce.number().min(0.5).max(1).optional(),
			po_dry_run: z.boolean().optional().describe("Create the run_po_triage trigger as a dry run (reports only, no queueing). Default false: a newly created trigger queues for real. Only applies when this call creates the trigger."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, enabled, po_enabled, po_dry_run, model, pilot_model, human_timeout_minutes, escalation_timeout_minutes, max_decisions_per_run, confidence_threshold, dry_run: preview }) => {
			const session = auth(token);
			if (!session) return authRequired();
			const knobs = Object.fromEntries(
				Object.entries({ model, pilotModel: pilot_model, humanTimeoutMinutes: human_timeout_minutes, escalationTimeoutMinutes: escalation_timeout_minutes, maxDecisionsPerRun: max_decisions_per_run, confidenceThreshold: confidence_threshold }).filter(([, v]) => v !== undefined),
			);
			const input = { instance_id, ...(enabled !== undefined ? { enabled } : {}), ...(po_enabled !== undefined ? { po_enabled } : {}), ...(po_dry_run !== undefined ? { po_dry_run } : {}), ...knobs };
			const denied = await requirePermission(safetyFor(token), "write", "set_coder_brain", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/coder-brain`;
			if (preview) return dryRun(safetyFor(token), "set_coder_brain", "change the coder brain / product-owner triage switch", input, { endpoint, method: "PUT" });
			const data = (await authedCall(endpoint, session, { method: "PUT", body: JSON.stringify({ ...(enabled !== undefined ? { enabled } : {}), ...(po_enabled !== undefined ? { poEnabled: po_enabled } : {}), ...(po_dry_run !== undefined ? { poDryRun: po_dry_run } : {}), ...knobs }) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_coder_brain", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
	server.tool(
		"set_auto_pickup",
		"Turn a coder instance's brain-free auto-pickup on or off and set its rules (#1233). When a coding run ends and the coder has nothing queued, auto-pickup starts its next open GitHub issue — deterministically, with zero model calls: it leaves out issues labelled needs-human, blocked-on-serge, blocked, question or wontfix (plus `exclude_labels`), pull requests, issues assigned to a person, issues already queued or running, and an issue two auto-picked runs ended failed on (it comments on that issue once). It orders by `priority_labels` (default P0, P1, P2, P3; `P1: blocks users` counts as P1), then bug before enhancement, then the issue card's board order, then oldest. At most `max_per_day` auto-picked starts per 24 hours (default 10), each with `max_iterations` (default 30). When nothing qualifies the owner is told once. With the coder brain's product-owner triage on (set_coder_brain), triage picks instead and this stays idle. Needs a coding instance. Returns the settings, the built-in exclude labels and the last decisions; coding_loop_status shows `autoPickup` too. Call with dry_run first.",
		{
			token: z.string().optional(),
			instance_id: z.string(),
			enabled: z.boolean().optional(),
			priority_labels: z.array(z.string()).max(20).optional().describe("Priority labels, highest first. Default [\"P0\",\"P1\",\"P2\",\"P3\"]."),
			exclude_labels: z.array(z.string()).max(20).optional().describe("Labels that keep an issue out, on top of the built-in ones."),
			max_per_day: z.coerce.number().int().min(1).max(100).optional(),
			max_iterations: z.coerce.number().int().min(1).max(100).optional(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, enabled, priority_labels, exclude_labels, max_per_day, max_iterations, dry_run: preview }) => {
			const session = auth(token);
			if (!session) return authRequired();
			const patch = Object.fromEntries(Object.entries({ enabled, priorityLabels: priority_labels, excludeLabels: exclude_labels, maxPerDay: max_per_day, maxIterations: max_iterations }).filter(([, v]) => v !== undefined));
			const input = { instance_id, ...patch };
			const denied = await requirePermission(safetyFor(token), "write", "set_auto_pickup", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/auto-pickup`;
			if (preview) return dryRun(safetyFor(token), "set_auto_pickup", "change the brain-free auto-pickup switch and rules", input, { endpoint, method: "PUT" });
			const data = (await authedCall(endpoint, session, { method: "PUT", body: JSON.stringify(patch) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_auto_pickup", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
	server.tool(
		"get_auto_pickup",
		"Read a coder instance's brain-free auto-pickup (#1233): its settings (`enabled`, `priorityLabels`, `excludeLabels`, `maxPerDay`, `maxIterations`), the built-in exclude labels, which picker an empty queue wakes (`triage` when the coder brain's product-owner triage is on, else `auto_pickup`), and its ten most recent decisions — `started` (with the issue), `none_eligible`, `skipped_failed` (an issue two auto-picked runs ended failed on) or `capped` (the daily cap). Change it with set_auto_pickup. Read-only.",
		{ token: z.string().optional(), instance_id: z.string() },
		async ({ token, instance_id }) => {
			const session = auth(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_auto_pickup", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/auto-pickup`, session, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
	server.tool(
		"po_triage_reports",
		"Read a coder instance's product-owner triage (#1027): the brain switch, its `run_po_triage` triggers, and the most recent wake reports. Each report lists every open issue it read with its category (`waiting_on_human`, `blocked`, `needs_detail`, `ready`), a one-line reason and the action taken (`queued`, `would_queue`, `already_queued`, `held`, `commented`, …), plus counts and the digest sent (null when nothing changed), and `source` — what woke it: `cron` (its hourly window), `manual` (run by hand) or `queue_empty` (#1232: a coding run ended with nothing queued, so the coder was triaged at once; at most once per 15 minutes). No issue bodies or comments are stored. Read-only.",
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
	server.tool(
		"coder_questions",
		"Read the questions a coder instance's runs stopped on (#1025), newest first, each with its state (`waiting_human`, `brain_deciding`, `answered_human`, `answered_brain`, `escalated`, `unresolved`, `expired`), who answered, the brain's decision, confidence, reason and model, and the full state history — the audit trail. Plus the brain settings. Answer a waiting one with answer_instance_input. Read-only.",
		{
			token: z.string().optional(),
			instance_id: z.string(),
			state: z.enum(["waiting_human", "brain_deciding", "answered_human", "answered_brain", "escalated", "unresolved", "expired"]).optional(),
			limit: z.coerce.number().int().min(1).max(100).optional(),
		},
		async ({ token, instance_id, state, limit }) => {
			const session = auth(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "coder_questions", { instance_id });
			if (denied) return denied;
			const qs = new URLSearchParams({ ...(state ? { state } : {}), ...(limit ? { limit: String(limit) } : {}) }).toString();
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/coder-questions${qs ? `?${qs}` : ""}`, session, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
}
