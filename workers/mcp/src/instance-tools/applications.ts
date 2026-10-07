import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { type McpScope, audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The Applications control surface (#958) — the job-application lifecycle as TYPED tools, so a
 * connected AI discusses the queue and acts through schemas, never through free-text instructions.
 *
 * Every tool calls the routes the console's Applications tab calls (`routes/instances-applications.ts`
 * → `lib/applications/control.ts`), with the same request body the tab builds — so a decision made
 * here and one made in the console land the same transition and the same audit row.
 *
 * `instance_id` may be ANY member of the owner's pipeline — the Job Search Scout, the Application
 * Tailor or the Application Runner; the API finds the rest through the owner's connections.
 * Every state change carries the `expected_status` (and `expected_version`) the caller read, and is
 * refused as stale when the item has moved since. Defer and archive change PAGS records only.
 *
 * `pinnedInstanceId`: the same ten tools on a session pinned to one Tailor or Runner (#783's
 * `/mcp/i/<id>`, registered from `pinned.ts`) — bound to that instance, so they take no
 * `instance_id` and no `token` (a pinned session is its OAuth grant).
 */
/**
 * Each tool's scope — what its handler demands, and what a pinned session annotates it with.
 * `runtime` for the five that start or continue a run on the owner's machine.
 */
export const APPLICATION_TOOL_SCOPES = {
	list_applications: "read",
	get_application: "read",
	application_trace: "read",
	triage_application: "write",
	cancel_application: "write",
	generate_application_materials: "runtime",
	start_application_fill: "runtime",
	request_application_review: "runtime",
	retry_application: "runtime",
	resume_application: "runtime",
	get_application_runner_settings: "read",
	set_application_runner_settings: "write",
} as const satisfies Record<string, McpScope>;

export function registerApplicationTools(server: McpServer, ctx: Pick<InstanceToolsCtx, "env" | "tokenFor" | "safetyFor">, opts: { pinnedInstanceId?: string } = {}): void {
	const { env, tokenFor, safetyFor } = ctx;
	const pinned = opts.pinnedInstanceId;
	// Every path is written out in full: the MCP-parity check reads these literals to prove each
	// console capability has an MCP path (scripts/lib/api-calls.mjs).

	const tokenArg = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const instanceArg = z.string().describe("Any instance of the pipeline — the Scout, the Application Tailor or the Application Runner — from my_instances. Copy it exactly.");
	/** The caller's identity and instance — absent on a pinned session, which is bound to both. */
	const who: z.ZodRawShape = pinned ? {} : { token: tokenArg, instance_id: instanceArg };
	const instanceOf = (input: Record<string, unknown>) => pinned ?? String(input.instance_id);
	const tokenOf = (input: Record<string, unknown>) => (pinned ? undefined : (input.token as string | undefined));
	const target = {
		application_id: z.string().optional().describe("The application's id (applicationId from list_applications)."),
		scout_instance_id: z.string().optional().describe("For a lead with no application yet: scoutInstanceId from list_applications."),
		record_id: z.string().optional().describe("For a lead with no application yet: its leadId from list_applications."),
		expected_status: z.string().describe("Compare-and-set: the item's status as you read it. A changed item is refused as stale (409)."),
		expected_version: z.coerce.number().int().min(0).optional().describe("Compare-and-set: stateVersion (an application) or leadVersion (a lead) as you read it."),
	};

	server.tool(
		"list_applications",
		"The job-application queue across the owner's Scout → Tailor → Runner pipeline: leads with no application yet (new, apply_requested, skipped, deferred, archived) and applications (tailoring, materials_ready, filling, awaiting_review, submitted, blocked, failed). Each item has its status, its compare-and-set version, artifact handles (path + sha256, never content), the submit-policy verdict, any pause reason and questions, and the ACTIONS it allows. Also counts per status, today's auto-submit allowance and connection outbox health. Read-only.",
		{
			...who,
			status: z.enum(["new", "apply_requested", "tailoring", "materials_ready", "filling", "awaiting_review", "submitted", "blocked", "deferred", "skipped", "archived", "failed"]).optional().describe("Only this status."),
			sort: z.enum(["updated", "title"]).optional(),
			company: z.string().optional().describe("Only items whose company contains this (case-insensitive)."),
			role: z.string().optional().describe("Only items whose job title contains this."),
			source: z.string().optional().describe("Only items from a source containing this."),
			url: z.string().optional().describe("Only items whose job URL contains this."),
			since: z.string().optional().describe("ISO date/time: only items updated at or after it."),
			until: z.string().optional().describe("ISO date/time: only items updated before it."),
		},
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const { status, sort } = input as { status?: string; sort?: string };
			const filters = ["company", "role", "source", "url", "since", "until"] as const;
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_applications", { instance_id });
			if (denied) return denied;
			const q = new URLSearchParams();
			if (status) q.set("status", status);
			if (sort) q.set("sort", sort);
			for (const k of filters) if (typeof input[k] === "string" && input[k]) q.set(k, input[k] as string);
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-queue?${q}`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"get_application",
		"One application (by application_id) or one lead with no application yet (by scout_instance_id + record_id), as it stands now: status, versions, artifacts, submit-policy verdict, pause reason and the actions it allows. Read-only.",
		{ ...who, application_id: target.application_id, scout_instance_id: target.scout_instance_id, record_id: target.record_id },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const { application_id, scout_instance_id, record_id } = input as { application_id?: string; scout_instance_id?: string; record_id?: string };
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_application", { instance_id });
			if (denied) return denied;
			const q = new URLSearchParams();
			if (application_id) q.set("application_id", application_id);
			if (scout_instance_id) q.set("scout_instance_id", scout_instance_id);
			if (record_id) q.set("record_id", record_id);
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-queue/item?${q}`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"application_trace",
		"One application's history on a single timeline: the Scout's triage of the lead, the outbox deliveries, the Tailor run, the Runner run(s) and every lifecycle move, with the ids that correlate them (lead event, tailoring runs, materials_ready event, fill runs). Classes, decisions and handles only — never typed values or document text. Read-only.",
		{ ...who, application_id: z.string().describe("The application's id.") },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const application_id = String(input.application_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "application_trace", { instance_id, application_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-queue/${encodeURIComponent(application_id)}/trace`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"get_application_runner_settings",
		"An Application Runner's handoff and submission policy (#953): which signed-in CLI fills applications, from which of the owner's files, on which sites, and the auto-submit policy (off by default — every application stops for review). Pass the Runner's instance_id. Read-only.",
		{ ...who },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_application_runner_settings", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-runner/settings`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_application_runner_settings",
		"Change an Application Runner's handoff and submission policy. Only the fields you pass change. Auto-submit is REFUSED until a profile source, at least one approved role, at least one allowed site and a daily cap of at least 1 exist — and even then each application is submitted only when it matches every rule. Never takes a provider API key. Call with dry_run first.",
		{
			...who,
			settings: z
				.object({
					engine: z.enum(["claude", "codex"]).optional(),
					authMode: z.enum(["machine", "subscription"]).optional(),
					browserProfile: z.enum(["isolated", "default"]).optional(),
					workspace: z.string().optional(),
					sources: z.object({ profile: z.string().nullable().optional(), answers: z.string().nullable().optional() }).optional(),
					allowDomains: z.array(z.string()).optional(),
					maxMinutes: z.coerce.number().int().optional(),
					maxPages: z.coerce.number().int().optional(),
					maxActions: z.coerce.number().int().optional(),
					autoSubmit: z
						.object({
							enabled: z.boolean().optional(),
							roles: z.array(z.string()).optional(),
							locations: z.array(z.string()).optional(),
							exclude: z.array(z.string()).optional(),
							minSalary: z.coerce.number().int().nullable().optional(),
							dailyCap: z.coerce.number().int().optional(),
						})
						.optional(),
				})
				.describe("The fields to change, as GET returns them."),
			dry_run: z.boolean().optional().describe("Describe the change without saving it."),
		},
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const t = tokenFor(token);
			if (!t) return authRequired();
			const auditInput = { instance_id };
			const denied = await requirePermission(safetyFor(token), "write", "set_application_runner_settings", auditInput);
			if (denied) return denied;
			if (input.dry_run) {
				return dryRun(safetyFor(token), "set_application_runner_settings", "change an Application Runner's submission policy", auditInput, {
					endpoint: `/v1/instances/${instance_id}/application-runner/settings`,
					method: "PUT",
					effect: "The Runner's settings would be patched with the fields given; auto-submit stays refused until its prerequisites exist.",
				});
			}
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-runner/settings`, t, { method: "PUT", body: JSON.stringify(input.settings ?? {}) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_application_runner_settings", action: "completed", input: auditInput });
			return jsonText(data);
		},
	);

	/**
	 * One typed decision: its input shape, and a handler that POSTs the console's action body to the
	 * console's action route. Each tool below is still registered with its name LITERALLY at the call
	 * — `scripts/docs-drift.mjs` and the README table read registered names from the source.
	 */
	const decision = (name: keyof typeof APPLICATION_TOOL_SCOPES, actions: readonly [string, ...string[]], effect: string, extra: z.ZodRawShape = {}) => {
		const many = actions.length > 1;
		const shape: z.ZodRawShape = {
			...who,
			...(many ? { action: z.enum(actions).describe(`One of: ${actions.join(", ")}.`) } : {}),
			...target,
			...extra,
			dry_run: z.boolean().optional().describe("Describe what would happen without doing it."),
		};
		const handler = async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const t = tokenFor(token);
			if (!t) return authRequired();
			const instance_id = instanceOf(input);
			const action = many ? String(input.action) : actions[0];
			const auditInput = { instance_id, action, application_id: input.application_id, record_id: input.record_id };
			const denied = await requirePermission(safetyFor(token), APPLICATION_TOOL_SCOPES[name], name, auditInput);
			if (denied) return denied;
			const body: Record<string, unknown> = { action };
			for (const k of ["application_id", "scout_instance_id", "record_id", "expected_status", "expected_version", "runner_instance_id", "note", "defer_until", "answers"]) {
				if (input[k] !== undefined) body[k] = input[k];
			}
			if (input.dry_run) {
				return dryRun(safetyFor(token), name, `${action.replace(/_/g, " ")} one job application`, auditInput, {
					endpoint: `/v1/instances/${instance_id}/application-queue/actions`,
					method: "POST",
					effect,
				});
			}
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-queue/actions`, t, { method: "POST", body: JSON.stringify(body) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: name, action: "completed", input: auditInput });
			return jsonText(data);
		};
		return { shape, handler };
	};
	const runnerArg = { runner_instance_id: z.string().optional().describe("A specific Application Runner, when the pipeline has more than one.") };

	const triage = decision("triage_application", ["apply", "skip", "defer", "archive", "mark_not_interested"], "The item would move to the decided status, with an audit row; apply on a lead would also deliver its job.lead.apply_requested handoff.", {
		note: z.string().optional(),
		defer_until: z.string().optional(),
	});
	server.tool(
		"triage_application",
		"Decide a lead or an application. apply: a lead goes to the Tailor (the Scout's own triage, emitting its handoff once — refused when another lead for the same job was already applied for), a deferred application goes back in the queue. skip: a lead. mark_not_interested: a skip (lead) or an archive (application) recorded as not interested. defer / archive: either — PAGS records only, nothing on an employer's site is touched. Only actions listed in the item's `actions` are accepted. Pass expected_status (and expected_version) as you read them.",
		triage.shape,
		triage.handler,
	);

	const generate = decision("generate_application_materials", ["generate_materials", "retry_tailoring"], "A tailoring run would start on the owner's runner.");
	server.tool(
		"generate_application_materials",
		"Tailor a résumé and cover letter on the owner's machine. generate_materials: a lead already apply_requested (hands its stored handoff to the Tailor). retry_tailoring: an application whose tailoring stopped (blocked/failed/cancelled, never filled).",
		generate.shape,
		generate.handler,
	);

	const fill = decision("start_application_fill", ["start_fill"], "The Runner would fill the application and, as its auto-submit policy allows, submit it once.", runnerArg);
	server.tool(
		"start_application_fill",
		"Fill a materials_ready application with the Runner UNDER ITS POLICY, which may submit it: accepted only when the item's submitPolicy.allowed is true (its `actions` then include start_fill). Under the default fill-and-review policy it is refused — use request_application_review.",
		fill.shape,
		fill.handler,
	);

	const review = decision("request_application_review", ["request_review"], "The Runner would fill the application and stop before submitting.", runnerArg);
	server.tool(
		"request_application_review",
		"Fill a materials_ready application with the Runner and STOP before the final submit, whatever the policy allows. The run ends awaiting_review for the owner.",
		review.shape,
		review.handler,
	);

	const retry = decision("retry_application", ["retry_fill", "retry_tailoring"], "A fresh run of that stage would start, under a new key.", runnerArg);
	server.tool(
		"retry_application",
		"Retry the stage that stopped. retry_fill: a fill that ended blocked/failed — refused after any submit attempt, which needs checking on the employer's site instead. retry_tailoring: tailoring that stopped.",
		retry.shape,
		retry.handler,
	);

	const resume = decision("resume_application", ["resume"], "The paused fill would continue.", {
		answers: z.array(z.object({ question: z.string(), answer: z.string() })).optional().describe("Answers to the item's questions."),
	});
	server.tool(
		"resume_application",
		"Release a paused fill once the owner has handled what it waits on (a captcha, a sign-in, a consent box in the runner's browser) — optionally with answers to its question, which become usable for that run only and are not stored by PAGS.",
		resume.shape,
		resume.handler,
	);

	const cancel = decision("cancel_application", ["cancel"], "The running tailoring or fill would stop.");
	server.tool(
		"cancel_application",
		"Stop an application's running tailoring or fill. The local CLI stops; nothing on an employer's site is touched. The application is left blocked (cancelled_by_owner).",
		cancel.shape,
		cancel.handler,
	);
}
