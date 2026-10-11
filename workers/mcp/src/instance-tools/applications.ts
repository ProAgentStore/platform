import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { type McpScope, audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
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
 * `pinnedInstanceId`: the same tools on a session pinned to one Tailor or Runner (#783's
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
	application_runs: "read",
	application_run: "read",
	application_run_supervision: "read",
	application_handoff: "read",
	create_application_handoff: "runtime",
	application_reconciliation: "read",
	request_application_reconciliation: "runtime",
	tailoring_run: "read",
	get_application_tailor_uploaded_sources: "read",
	get_application_tailor_uploaded_source_readiness: "read",
	set_application_tailor_uploaded_source: "write",
	clear_application_tailor_uploaded_source: "write",
	triage_application: "write",
	approve_application: "destructive",
	cancel_application: "write",
	generate_application_materials: "runtime",
	start_application_fill: "runtime",
	request_application_review: "runtime",
	transfer_prepared_application: "runtime",
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
		"The job-application queue across the owner's Scout → Tailor → Runner pipeline: leads with no application yet (new, apply_requested, skipped, deferred, archived) and applications (tailoring, materials_ready, filling, awaiting_review, submitted, blocked, failed). Each application has `execution`, the ONE durable redacted projection shared with Board and Console: lifecycle, current run, checkpoint counts, directive delivery/runner acknowledgement, evidence-based progress, reconciliation state and permitted actions. It excludes page text, snapshots, typed values, credentials and artifact contents. `fillProgress` remains a compatibility alias; read `execution.progress` rather than inferring progress from `status`. The projection does not grant submission authority — actions remain fail-closed. Also returns counts, limits and connection outbox health. Read-only.",
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
		"One application (by application_id) or one lead with no application yet (by scout_instance_id + record_id), as it stands now. Applications include the shared durable `execution` projection (lifecycle, current run, redacted checkpoint/directive delivery state, progress and permitted actions) plus compatibility `fillProgress`; it never says a form is filled without durable counts and never exposes page/form/credential/artifact contents. Read-only.",
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

	// ── Live run visibility (#971) ────────────────────────────────────────────
	//
	// `application_trace` answers "what happened to this application" across the whole pipeline.
	// These four answer "what is THIS run doing" — the question `coding_session_capture` and
	// `coding_timeline` answer for a coding agent, and the one that had no MCP path at all: not a
	// single tool reached `/application-runs/*` or the Tailor's `/applications/:id`, so a run's
	// policy, its pause, its submit-gate verdicts, its per-event trace and its supervisor
	// checkpoints were readable over HTTP and from nowhere else.
	//
	// Two of them are LIVE in the strict sense: the route pulls the runner before it answers, so a
	// just-emitted event is in the reply without trusting a client to have polled for it.
	//
	// What they CANNOT show, said plainly in the descriptions rather than discovered: the engine is
	// a CLI on the owner's machine, and its stdout never crosses the runner contract — only the
	// `summary` the runner derives from it. A run whose CLI called no bridge tool therefore has no
	// page-by-page detail to return, and that absence is itself the finding (it is why such a run
	// ends `blocked`/`incomplete`). Claiming otherwise would send a reader looking for a record
	// that was never written.

	server.tool(
		"application_runs",
		"The Application Runner's fill runs, newest first: each run's status, which application it is for, the machine it ran on, its policy mode and submit-gate verdict, and its timings. Pass the RUNNER's instance_id. This is how you find the run that holds a concurrency slot — a dispatch refused with \"already filling N application(s) for this agent, limit N\" names no run id, and this lists the one that does. For what that run is DOING, read application_run. Read-only.",
		{ ...who, limit: z.coerce.number().int().min(1).max(200).optional().describe("How many of the newest runs to return (default 50, max 200).") },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const limit = input.limit === undefined ? undefined : Number(input.limit);
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "application_runs", { instance_id, limit });
			if (denied) return denied;
			const q = limit === undefined ? "" : `?limit=${limit}`;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-runs${q}`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"application_run",
		"ONE fill run as it stands RIGHT NOW — the live view of an Application Runner, the counterpart of coding_session_capture for a coding agent. Reading it pulls the owner's machine first, so a just-emitted event is already here. Returns the run (`status`, `pause` — what it is waiting for and the questions it asked, `policy` with the mode, limits, allowed domains and every submit-gate check with its verdict, `result` with the outcome, how many fields were filled, what was uploaded and whether a submit was attempted, `engineAuth`, `runnerNode`, `errorCode`/`error`, timings), its `trace` of runner-reported events (`browser.navigated`, `field.filled`, `artifact.uploaded`, `policy.decision`, `browser.blocked`, `submit.*`, `supervisor.*`) with `runnerSeq`, plus the application and its lifecycle audit. A trace holding only `engine.started`/`engine.ended` is a real finding, not a gap in this tool: the CLI called no browser tool, which is usually why such a run ends blocked and incomplete. The CLI's own output stays on the machine by contract — `result.summary` is the only part of it the platform receives. Read-only.",
		{ ...who, run_id: z.string().describe("The fill run's id (`id` from application_runs, or fillRunId from list_applications).") },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const run_id = String(input.run_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "application_run", { instance_id, run_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-runs/${encodeURIComponent(run_id)}`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"application_run_supervision",
		"The cloud-supervision state of one fill run: every checkpoint the runner reported — its phase (`initial`, `post_navigation`, `before_submit`, `uncertain`), the bounded facts it was decided on (actions, fields filled, uploads, blockers, domain) and its `runnerSeq` — each with the single immutable `directive` recorded for it (`continue`, `request_review`, `stop`) and when that directive was delivered. This is what a run paused at a checkpoint is waiting on, and why the Runner's own brain decided as it did. Reading it pulls the machine first. Facts only, never page text or typed values. Read-only.",
		{ ...who, run_id: z.string().describe("The fill run's id (`id` from application_runs).") },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const run_id = String(input.run_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "application_run_supervision", { instance_id, run_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-runs/${encodeURIComponent(run_id)}/supervision`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	// ── Exact Application Runner browser continuity (#1013) ──────────────────
	//
	// These deliberately expose only the cloud's safe projection: opaque handoff id/link, ids,
	// lifecycle/expiry reasons and reconciliation state.  Browser cookies, profile state, page
	// text, screenshots, typed values and any employer-site history do not cross this boundary.
	// A request cannot assert that a submission did not happen; only the Runner's structured,
	// read-only evidence can later make an audited transition.
	const runArg = { run_id: z.string().describe("The exact Application Runner fill run id (`id` from application_runs).") };
	const handoffArg = { handoff_id: z.string().describe("The opaque handoff id returned by create_application_handoff. It is not a browser URL, profile id, cookie or credential.") };
	server.tool(
		"application_handoff",
		"Read the bounded browser-handoff state for ONE Application Runner run (#1013): opaque continuity id/link, safe lifecycle state, expiry and closed reason only. It never returns a browser URL, profile id, cookie, token, page text, typed value, screenshot or employer-site history. A closed/lost/expired handoff is not a completed submission. Read-only.",
		{ ...who, ...runArg, ...handoffArg },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const run_id = String(input.run_id ?? "");
			const handoff_id = String(input.handoff_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "application_handoff", { instance_id, run_id, handoff_id });
			if (denied) return denied;
			// Console resolves its canonical deep link by opaque id.  Keep MCP on that same
			// owner-scoped resolver (while retaining run_id in the tool schema/audit scope).
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-handoffs/${encodeURIComponent(handoff_id)}`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
	server.tool(
		"create_application_handoff",
		"Explicitly request ONE short-lived, exact-owner browser handoff for ONE live Application Runner run (#1013). It reuses only the already-authorized local browser profile for that run; it never signs in, stores credentials, expands profile lifetime, changes OAuth/security settings, submits, resets submit_attempted/submit_unconfirmed, or creates approval. Idempotent while that exact live run/profile remains valid; returns a mobile-usable authenticated Console link. Use dry_run first.",
		{ ...who, ...runArg, dry_run: z.boolean().optional().describe("Describe the bounded handoff request without contacting the Runner or creating it.") },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const run_id = String(input.run_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const auditInput = { instance_id, run_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "create_application_handoff", auditInput);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/application-runs/${encodeURIComponent(run_id)}/handoff`;
			if (input.dry_run) return dryRun(safetyFor(token), "create_application_handoff", "request one short-lived exact-run browser handoff", auditInput, {
				endpoint, method: "POST", effect: "The Runner would be asked for an owner-bound live handoff only if this exact run, application and already-authorized profile remain valid. No sign-in, submission, approval, browser-profile change or credential storage would occur.",
			});
			const data = (await authedCall(endpoint, t, { method: "POST", body: "{}" }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "create_application_handoff", action: "completed", input: auditInput, result: data });
			return jsonText(data);
		},
	);
	server.tool(
		"application_reconciliation",
		"Read the durable, secret-safe reconciliation state for ONE Application Runner run (#1013): whether a runner-authoritative read-only reconciliation was requested/completed and its closed-vocabulary outcome. It never exposes site history, browser/profile state, screenshots, page text, credentials, typed answers or raw evidence. `submit_attempted` and `submit_unconfirmed` remain facts; a login redirect is never evidence of no submission. Read-only.",
		{ ...who, ...runArg },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const run_id = String(input.run_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "application_reconciliation", { instance_id, run_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-runs/${encodeURIComponent(run_id)}/reconciliation`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
	server.tool(
		"request_application_reconciliation",
		"Explicitly ask the exact Application Runner to perform its supported read-only reconciliation for an uncertain attempt (#1013). This does not accept an owner assertion as proof, does not log in, replay a submit, mint an approval, reset submit_attempted/submit_unconfirmed, or infer no submission from a redirect. The Runner may record only its structured authoritative outcome and audited transition. Use dry_run first.",
		{ ...who, ...runArg, dry_run: z.boolean().optional().describe("Describe the read-only reconciliation request without contacting the Runner.") },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const run_id = String(input.run_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const auditInput = { instance_id, run_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "request_application_reconciliation", auditInput);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/application-runs/${encodeURIComponent(run_id)}/reconciliation`;
			if (input.dry_run) return dryRun(safetyFor(token), "request_application_reconciliation", "request read-only authoritative reconciliation for one uncertain attempt", auditInput, {
				endpoint, method: "POST", effect: "The Runner would inspect only its supported structured evidence for this exact run. It would not sign in, submit/retry, replace approval, or treat a login redirect as proof.",
			});
			const data = (await authedCall(endpoint, t, { method: "POST", body: "{}" }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "request_application_reconciliation", action: "completed", input: auditInput, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"tailoring_run",
		"ONE application's tailoring run as it stands RIGHT NOW — the live view of an Application Tailor, and the answer to \"how far along is the run holding my limit-1 slot\". Pass the TAILOR's instance_id and the application_id. A run still `running` is pulled from the owner's machine before answering. Returns the application (status, artifact handles, profile version, block reason and questions) and the run: its `policy` (engine, auth mode, workspace, which of the owner's source files it may read, retention), `result`, `engineAuth`, `runnerNode`, `errorCode`/`error`, timings, and its `trace` of runner-reported events with `runnerSeq`. Artifact HANDLES and claim counts only — never résumé or cover-letter text. Read-only.",
		{ ...who, application_id: z.string().describe("The application's id (applicationId from list_applications).") },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const application_id = String(input.application_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "tailoring_run", { instance_id, application_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/applications/${encodeURIComponent(application_id)}`, t, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"get_application_tailor_uploaded_sources",
		"The Application Tailor's explicit uploaded résumé and profile selections. Each selection is an exact owner-scoped Instance File snapshot, never inferred from a filename or a historical/local résumé. Returns metadata and provenance only — never file or extracted text — and does not start tailoring. Read-only.",
		{ ...who },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_application_tailor_uploaded_sources", { instance_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-tailor/uploaded-sources`, t, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"get_application_tailor_uploaded_source_readiness",
		"Whether the Application Tailor's selected uploaded résumé and profile are safe to use. Returns live owner-scoped file provenance (filename, file id, version, original/extracted hashes and extraction time) and every blocker, including stale, missing, unreadable or runner-materialization blockers. Read this before starting tailoring: an uploaded selection fails closed and never falls back to a local or historical résumé. Read-only.",
		{ ...who },
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_application_tailor_uploaded_source_readiness", { instance_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/application-tailor/uploaded-sources/readiness`, t, {}, env);
			return jsonText(data);
		},
	);

	const uploadedSourceRole = z.enum(["resume", "profile"]);

	server.tool(
		"set_application_tailor_uploaded_source",
		"Select ONE exact uploaded Instance File as the Application Tailor's résumé or profile source. The API verifies the file belongs to this owner and snapshots its version, hashes and extraction metadata; it never selects by filename and never reads bytes through MCP. This changes selection only — it does not start tailoring. Call get_application_tailor_uploaded_source_readiness afterwards, and use dry_run first.",
		{
			...who,
			role: uploadedSourceRole.describe("Which required source this File becomes."),
			file_id: z.string().describe("Exact File id from list_instance_files for this same instance; copy it unchanged."),
			dry_run: z.boolean().optional().describe("Describe the selection without saving it."),
		},
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const role = input.role as "resume" | "profile";
			const file_id = String(input.file_id ?? "");
			const t = tokenFor(token);
			if (!t) return authRequired();
			const auditInput = { instance_id, role, file_id };
			const denied = await requirePermission(safetyFor(token), "write", "set_application_tailor_uploaded_source", auditInput);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/application-tailor/uploaded-sources/${encodeURIComponent(role)}`;
			if (input.dry_run) {
				return dryRun(safetyFor(token), "set_application_tailor_uploaded_source", "select an exact uploaded Tailor source", auditInput, {
					endpoint,
					method: "PUT",
					body: { fileId: file_id },
				});
			}
			const data = (await authedCall(endpoint, t, { method: "PUT", body: JSON.stringify({ fileId: file_id }) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_application_tailor_uploaded_source", action: "completed", input: auditInput });
			return jsonText(data);
		},
	);

	server.tool(
		"clear_application_tailor_uploaded_source",
		"Clear the selected uploaded résumé or profile source for the Application Tailor. This removes only the source selection record — it never deletes the uploaded File or its extracted text. With no uploaded selections, local-source mode remains explicit and unchanged. Call with dry_run first.",
		{
			...who,
			role: uploadedSourceRole.describe("Which uploaded source selection to clear."),
			dry_run: z.boolean().optional().describe("Describe the clear without saving it."),
		},
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const role = input.role as "resume" | "profile";
			const t = tokenFor(token);
			if (!t) return authRequired();
			const auditInput = { instance_id, role };
			const denied = await requirePermission(safetyFor(token), "write", "clear_application_tailor_uploaded_source", auditInput);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/application-tailor/uploaded-sources/${encodeURIComponent(role)}`;
			if (input.dry_run) {
				return dryRun(safetyFor(token), "clear_application_tailor_uploaded_source", "clear an uploaded Tailor source selection", auditInput, {
					endpoint,
					method: "DELETE",
				});
			}
			const data = (await authedCall(endpoint, t, { method: "DELETE" }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "clear_application_tailor_uploaded_source", action: "completed", input: auditInput });
			return jsonText(data);
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
	const decision = (name: keyof typeof APPLICATION_TOOL_SCOPES, actions: readonly [string, ...string[]], effect: string, extra: z.ZodRawShape = {}, confirmWith?: string) => {
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
			// A destructive decision is confirmed, the convention every other destructive tool in this
			// surface keeps — and the MCP counterpart of the board's own confirmation dialog, so the
			// two surfaces ask for the same deliberateness rather than one being the quiet path.
			// Checked AFTER the dry run below is NOT an option: a dry run describes, so it is allowed
			// unconfirmed; the real call is not.
			if (confirmWith && !input.dry_run) {
				const unconfirmed = await requireConfirmation(safetyFor(token), name, input.confirm as string | undefined, confirmWith, auditInput);
				if (unconfirmed) return unconfirmed;
			}
			const body: Record<string, unknown> = { action };
			for (const k of ["application_id", "scout_instance_id", "record_id", "expected_status", "expected_version", "runner_instance_id", "note", "defer_until", "answers", "idempotency_key"]) {
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

	const approve = decision(
		"approve_application",
		["approve_and_proceed"],
		"A single-use authorization would be recorded for THIS application. Before the fill, the Runner would then fill it and submit it once; after the fill — `awaiting_review`, parked at a checkpoint, or `blocked` because the run reached a control it may not press under fill-and-review (a one-click apply, #991) — the exact run would be continued where it can be, and otherwise the approval is HELD and `retry_application` starts the fresh run that spends it. No daily cap is required or consumed, and the account's auto-submit setting is not changed.",
		{
			idempotency_key: z.string().optional().describe("Your own key for this approval, so a retry you cannot tell succeeded reuses the same authorization instead of granting a second one. Omit it and the server derives one from the application and the state version you approved."),
			confirm: z.string().optional().describe('Must be "approve_application": this authorizes a real submission to an employer, which cannot be recalled.'),
		},
		"approve_application",
	);
	server.tool(
		"approve_application",
		"Approve ONE job application and let it be submitted — the owner's per-application decision (#973, #981), the same command the Applications board's \"Approve & proceed\" / \"Approve & continue\" button sends. It records a durable, single-use authorization bound to this application and the exact state version you pass; the reply carries the authorization, the run and the next action. This is NOT a global auto-submit toggle: it requires no daily cap, consumes none, and authorizes nothing but this one application. It cannot be replayed — for another lead, after the materials are re-tailored, or after the run that holds it. WHAT IT THEN DOES depends on where the application is, and the reply says which happened. `materials_ready`: it dispatches the fill that spends the authorization. `awaiting_review`, an application parked at a supervisor checkpoint (#981), or one `blocked` because its fill reached a control it may not press under fill-and-review — a genuine one-click apply, which the runner refuses and must (#991): the run stopped and nothing was sent, so it continues THAT run — releasing the exact checkpoint it is parked at (`resumable: true`, with `checkpointId`) when the run is still open. When the run has ended its browser session is gone with it, so nothing is resumed and nothing is recreated: the reply is `resumable: false` with a closed-vocabulary `reason` and `recovery: \"retry_fill\"`, and the approval is HELD for that retry (retry_application), which spends it and may submit once. The Runner still has to pass its own submit gate (complete materials, an allow-listed domain, no blocker, nothing else running) and its browser safety checks, so an approval permits a submission rather than forcing one. A `blocked` application that never filled (its TAILORING stopped) is not approvable: there is no form and no final control, so retry_application is the answer there. Accepted only when the item's `actions` include approve_and_proceed. Pass `dry_run` first to see what would happen.",
		approve.shape,
		approve.handler,
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

	server.tool(
		"transfer_prepared_application",
		"Deliver ONE already-reviewed Tailor résumé and cover-letter set to ONE selected Application Runner through ONE existing PAUSED materials_ready connection. The edge remains paused and unrelated events remain untouched. Exact hashes and the application state version are required; the receipt survives retries and drives the existing Runner in fill-and-review mode only. It does not enable auto-submit, change a cap, or submit anything.",
		{
			...who,
			application_id: z.string().describe("The reviewed Application Tailor application id."),
			expected_status: z.enum(["materials_ready"]).describe("The reviewed application must still be materials_ready."),
			expected_version: z.coerce.number().int().min(0).describe("The application stateVersion you reviewed."),
			resume_sha256: z.string().describe("Exact reviewed résumé SHA-256 (64 hex characters; the API validates it)."),
			cover_letter_sha256: z.string().describe("Exact reviewed cover-letter SHA-256 (64 hex characters; the API validates it)."),
			destination_runner_instance_id: z.string().describe("The selected Application Runner instance."),
			connection_id: z.string().describe("The existing paused Tailor → Runner materials_ready connection id."),
			idempotency_key: z.string().min(1).max(300).describe("Stable caller key: retry an uncertain response with this exact key."),
			dry_run: z.boolean().optional(),
		},
		async (input: Record<string, unknown>) => {
			const token = tokenOf(input);
			const instance_id = instanceOf(input);
			const t = tokenFor(token);
			if (!t) return authRequired();
			const auditInput = { instance_id, application_id: input.application_id, destination_runner_instance_id: input.destination_runner_instance_id, connection_id: input.connection_id, expected_version: input.expected_version, idempotency_key: input.idempotency_key };
			const denied = await requirePermission(safetyFor(token), "runtime", "transfer_prepared_application", auditInput);
			if (denied) return denied;
			if (input.dry_run) return dryRun(safetyFor(token), "transfer_prepared_application", "transfer one reviewed material set for Runner review", auditInput, { endpoint: `/v1/instances/${instance_id}/applications/${input.application_id}/transfer`, method: "POST", effect: "A receipt-backed review-only delivery would be created; the paused connection and all auto-submit policy remain unchanged." });
			const body = {
				expected_status: input.expected_status, expected_version: input.expected_version, resume_sha256: input.resume_sha256,
				cover_letter_sha256: input.cover_letter_sha256, destination_runner_instance_id: input.destination_runner_instance_id,
				connection_id: input.connection_id, idempotency_key: input.idempotency_key,
			};
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/applications/${encodeURIComponent(String(input.application_id))}/transfer`, t, { method: "POST", body: JSON.stringify(body) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "transfer_prepared_application", action: "completed", input: auditInput, result: data });
			return jsonText(data);
		},
	);

	const retry = decision("retry_application", ["retry_fill", "retry_tailoring"], "A fresh run of that stage would start, under a new key. If this application holds an unspent approval (#981), that run is the one that spends it and may submit once.", runnerArg);
	server.tool(
		"retry_application",
		"Retry the stage that stopped. retry_fill: a fill that ended blocked, failed or awaiting_review — refused after any submit attempt, which needs checking on the employer's site instead. This is the path approve_application names when a filled application's browser session has already closed (#981): the fresh run spends the approval that is being held and may submit once, and without an approval it fills and stops for review again. retry_tailoring: tailoring that stopped.",
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
