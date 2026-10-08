/**
 * An application execution as a generic board card (#978) — the third domain after coding (#206)
 * and pipelines (#207A), written the same way for the same reason.
 *
 * The problem: the Board renders `instance_runtime_tasks`, and the Tailor and Runner wrote only
 * their own run tables. So a Runner that was actively filling an employer's form had an EMPTY
 * board, and the only place the work appeared was a separate Applications surface — which made one
 * workflow look like two systems, and left a supervisor (`subordinate_status`, which reads exactly
 * these rows) unable to see any of it.
 *
 * The product model #978 states, and the shape that follows from it:
 *
 *   An APPLICATION is durable data — lead, job URL, artifacts, authorization, outcome.
 *   A RUN is one execution against it: tailoring, a fill, a retry, a submit.
 *   One application has MANY runs.
 *
 * So the card is keyed on the application's JOB URL, not on the run. The board's generic grouping
 * then does the rest for free: every run of one application collapses into one card whose
 * `attempts` are the runs, which is already how the board treats "one job, several tries". Keying
 * on the run id instead would have produced a new card per retry and buried the application.
 *
 * What the domain puts on the card, because only the domain can: the application's identity, the
 * stage it is in, the checkpoint or terminal reason, the trace to read, and the actions the
 * APPLICATION ACTION SERVICE currently permits (`applications/control.ts`). The actions are
 * computed here at write time rather than derived by a reader, which is what keeps Console and MCP
 * showing the same controls — both read this one record.
 */
import { type ApplicationCardPayload, parseApplicationCard } from "./application-card-payload.js";
import type { FillProgress } from "./fill-progress.js";
import type { JobApplication } from "../local-artifact/store.js";
import { upsertWorkCard } from "../work-card.js";
import type { Env } from "../../types.js";

/** The two execution kinds an application has. */
export type ApplicationRunKind = "tailor" | "fill";

// Re-exported so a domain reader has one import; the SHAPE lives in the leaf, which imports
// nothing, so the generic board can read it without touching this module's graph (#978).
export { type ApplicationCardPayload, parseApplicationCard };

export const APPLICATION_RUN_TASK_TYPE = "application.run";

/**
 * The card id, keyed on the APPLICATION — one card per application, whatever ran.
 *
 * Not the run id: a retry must land on the same card, and the board's own vocabulary for "another
 * try at the same job" is an attempt, not a second card.
 */
export const applicationCardId = (applicationId: string): string => `app-${applicationId}`;

/**
 * The board status for an application run.
 *
 * Mapped rather than passed through, for the reason `pipelineCardStatus` gives: a domain's own word
 * that no board column claims reads as uncategorised. `paused` is the one that matters — a run
 * waiting for a person is `needs_human`, which is the status every board column set has a home for
 * and the one the console's "needs you" column reads.
 */
export function applicationCardStatus(runStatus: string): string {
	if (runStatus === "paused") return "needs_human";
	if (runStatus === "awaiting_review") return "needs_human";
	if (runStatus === "queued") return "queued";
	if (runStatus === "submitted") return "completed";
	return runStatus;
}

/**
 * What the owner is told the run is doing — the stage, in their words.
 *
 * A FILL's stage is the runner's own facts (`fill-progress.ts`), never the status word. The
 * sentence this used to return for `awaiting_review` was "Filled — waiting for your review before
 * anything is sent", and the runner reports that outcome both for a complete form and for a run
 * that stopped before touching one: live, an application whose checkpoint said `filled: 0,
 * uploaded: 0` was presented as a populated form waiting to be approved and sent (#986) — and the
 * one action that reading invites would have sent an empty application to an employer.
 *
 * Tailoring keeps its own two words: it has no fields to count.
 */
export function applicationStageLabel(kind: ApplicationRunKind, runStatus: string, pauseReason?: string | null, progress?: FillProgress | null): string {
	if (kind === "tailor") {
		if (pauseReason) return `Paused — ${pauseReason.replace(/_/g, " ")}`;
		return runStatus === "running" ? "Tailoring the résumé and cover letter" : runStatus === "queued" ? "Waiting for the machine to tailor it" : `Tailoring ${runStatus}`;
	}
	if (progress) return progress.label;
	// No facts in hand: say what the run's status is, and never infer filled work from it.
	if (pauseReason) return `Paused — ${pauseReason.replace(/_/g, " ")}`;
	if (runStatus === "submitted") return "Submitted to the employer";
	return `Fill ${runStatus}`;
}

/** The application's identity and current state, as the card carries it. */
export interface ApplicationCardFacts {
	applicationId: string;
	/** The application's own lifecycle status, which outlives any one run. */
	applicationStatus: string;
	/** Compare-and-set token, so an action taken from the card is refused when stale. */
	stateVersion: number;
	/** What the action service currently permits — the SAME list the Applications service computes. */
	actions: readonly string[];
	kind: ApplicationRunKind;
	runId: string;
	stage: string;
    /** The checkpoint a paused run is waiting on, when it is waiting on one (#971's vocabulary). */
	checkpoint?: { checkpointId: string; phase: string; directive: string | null } | null;
	/**
	 * How far the fill actually got, from the runner's own facts (#986) — the same object the
	 * Applications/Data queue item carries, so two surfaces cannot describe one run differently.
	 */
	progress?: FillProgress | null;
	/** Where the correlated history is: the application's own trace (#958). */
	traceUrl: string;
	/** The terminal reason, when the run ended on one. */
	blockReason?: string | null;
	/** The runner CLI that executed it (#977), when known. */
	runnerVersion?: string | null;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The lead's own words for the job this application is for. */
export function applicationCardLabel(app: Pick<JobApplication, "lead">): { title: string; subtitle: string; url: string } {
	const envelope = (app.lead ?? {}) as { leadUrl?: string; lead?: Record<string, unknown> };
	const lead = envelope.lead ?? {};
	const str = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
	const role = str(lead.title) || "(untitled job)";
	const company = str(lead.company);
	return {
		title: clip(company ? `${role} — ${company}` : role, 200),
		subtitle: clip(str(lead.location), 120),
		url: str(envelope.leadUrl) || str(lead.url),
	};
}

/**
 * The card record. Pure, so what the board will show is assertable without a database — the thing
 * #978's acceptance turns on ("the card visibly moves to awaiting-review with the directive").
 */
export function applicationRunTaskRecord(opts: { app: Pick<JobApplication, "id" | "lead">; facts: ApplicationCardFacts; runStatus: string; now: string }): Record<string, unknown> {
	const label = applicationCardLabel(opts.app);
	const status = applicationCardStatus(opts.runStatus);
	const detail = [opts.facts.stage, opts.facts.blockReason ? `reason: ${opts.facts.blockReason}` : "", opts.facts.checkpoint ? `checkpoint ${opts.facts.checkpoint.checkpointId} (${opts.facts.checkpoint.phase})${opts.facts.checkpoint.directive ? ` → ${opts.facts.checkpoint.directive}` : " — awaiting a directive"}` : ""]
		.filter(Boolean)
		.join(" · ");
	return {
		id: applicationCardId(opts.facts.applicationId),
		type: APPLICATION_RUN_TASK_TYPE,
		status,
		title: label.title,
		subtitle: label.subtitle,
		description: clip(detail, 300),
		// `input.url` is what the board reads for a card's url, and for an apply agent it is also the
		// per-job key — which is what makes every run of this application one card.
		input: { url: label.url },
		application: {
			applicationId: opts.facts.applicationId,
			applicationStatus: opts.facts.applicationStatus,
			stateVersion: opts.facts.stateVersion,
			actions: [...opts.facts.actions],
			kind: opts.facts.kind,
			runId: opts.facts.runId,
			stage: opts.facts.stage,
			traceUrl: opts.facts.traceUrl,
			...(opts.facts.checkpoint ? { checkpoint: opts.facts.checkpoint } : {}),
			...(opts.facts.progress ? { progress: opts.facts.progress } : {}),
			...(opts.facts.blockReason ? { blockReason: opts.facts.blockReason } : {}),
			...(opts.facts.runnerVersion ? { runnerVersion: opts.facts.runnerVersion } : {}),
		},
		createdAt: opts.now,
		updatedAt: opts.now,
		...(status === "running" || status === "needs_human" || status === "queued" ? {} : { completedAt: opts.now }),
	};
}

/** Write (or refresh) the application's card. Best-effort, like every card write (`work-card.ts`). */
export async function upsertApplicationRunCard(
	env: Env,
	opts: { instanceId: string; userId: string; app: Pick<JobApplication, "id" | "lead">; facts: ApplicationCardFacts; runStatus: string },
): Promise<void> {
	const task = applicationRunTaskRecord({ app: opts.app, facts: opts.facts, runStatus: opts.runStatus, now: new Date().toISOString() });
	await upsertWorkCard(env, { instanceId: opts.instanceId, userId: opts.userId, id: applicationCardId(opts.facts.applicationId), task });
}

/**
 * Refresh the card for one application from the state the ACTION SERVICE sees (#978).
 *
 * The actions come from `getQueueItem` — the very read the Applications surface and the typed MCP
 * tools make — so the card cannot offer a control the service would refuse, and Console and MCP
 * cannot drift into showing different ones. That is the parity requirement, met by construction
 * rather than by two lists kept in step.
 *
 * Imported lazily because `applications/control.ts` imports the apply and tailor domains that call
 * this, and a static import would close the cycle. Best-effort throughout: a missing card is a
 * visibility bug, and failing the run that triggered the write is strictly worse.
 */
export async function syncApplicationCard(
	env: Env,
	userId: string,
	run: { id: string; instanceId: string; applicationId: string; status: string; pause?: { reason?: string } | null; runnerVersion?: string | null },
	kind: ApplicationRunKind,
	opts: { checkpoint?: ApplicationCardFacts["checkpoint"] } = {},
): Promise<void> {
	try {
		const { getQueueItem } = await import("./control.js");
		const { item, pipeline } = await getQueueItem(env, userId, run.instanceId, { applicationId: run.applicationId });
		const { getOwnedApplication } = await import("../local-artifact/store.js");
		const app = await getOwnedApplication(env, userId, run.applicationId);
		if (!app) return;
		// The SAME object the Applications/Data queue item carries, not a second projection of the
		// same facts (#986): the card and the queue item are then one claim, and the drift that put
		// "Filled — waiting for your review" on a card whose run had filled nothing cannot recur.
		// A tailoring card has no fields to count, so it keeps its own two words.
		const progress = kind === "fill" ? item.fillProgress : null;
		await upsertApplicationRunCard(env, {
			// ONE home per application: the Runner of its pipeline when it has one, else the Tailor
			// (#987). An application is one card by id, and its stages run on two instances, so a home
			// chosen per-WRITE meant the card sat wherever the first stage put it — which is how the
			// Runner's board reported one card against a queue of three. The Runner's board is where
			// the pipeline's work is read, and the queue that board is compared against is pipeline-
			// wide from any member, so this is the home that makes the two agree.
			instanceId: pipeline.runners[0] ?? run.instanceId,
			userId,
			app,
			runStatus: run.status,
			facts: {
				applicationId: run.applicationId,
				applicationStatus: item.status,
				stateVersion: item.stateVersion ?? 0,
				actions: item.actions,
				kind,
				runId: run.id,
				stage: applicationStageLabel(kind, run.status, run.pause?.reason ?? null, progress),
				...(progress ? { progress } : {}),
				traceUrl: `/instances/${run.instanceId}/applications/${run.applicationId}/trace`,
				...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
				blockReason: item.blockReason,
				runnerVersion: run.runnerVersion ?? null,
			},
		});
	} catch {
		/* visibility only — never fail the run that triggered it */
	}
}

/**
 * Project every durable application onto the board it belongs to — bounded, idempotent (#987).
 *
 * ── The gap
 *
 * The card was written only when a transition happened. The Runner's board therefore showed the
 * applications that had moved since #978 deployed and nothing else: live, `jobCount: 1` against an
 * authoritative queue of three (BusinessAI awaiting_review, DAI awaiting_review, Gentrack blocked).
 * The two older applications had no card and no way to acquire one — their lifecycle was finished,
 * so no future transition would ever write them.
 *
 * ── The shape of the fix
 *
 * A reconciliation that finds applications whose card is MISSING or STALE and writes it through the
 * very same path a transition uses (`syncApplicationCard`), so a backfilled card and a live one
 * cannot differ in content — the parity the issue asks for, met by construction rather than by a
 * second projection written for the backfill.
 *
 * - **Idempotent**: the card id is `app-<applicationId>` and the write is `ON CONFLICT(id) DO
 *   UPDATE`, so a repeated pass rewrites the same row. There is no path to a duplicate card.
 * - **Bounded**: at most {@link RECONCILE_LIMIT} applications per pass, newest first. A backlog
 *   heals over consecutive passes instead of turning one board read into a migration.
 * - **Cheap when there is nothing to do**: ONE indexed anti-join decides whether any work exists,
 *   and the steady state is zero rows, which is what keeps a 2.5s board poll a board poll.
 * - **Lifecycle-safe**: it writes CARDS only. It never moves an application, never touches a run,
 *   and takes no decision — `syncApplicationCard` reads the queue item and projects it.
 */
export const RECONCILE_LIMIT = 25;

export interface ApplicationCardReconciliation {
	/** Cards written by this pass. */
	reconciled: number;
	/** Applications still missing or stale after it — a later pass will take them. */
	remaining: number;
}

/**
 * The applications of this pipeline whose card is missing or behind, newest first.
 *
 * Staleness is `state_version`: every lifecycle move bumps it and re-syncs the card, so a card
 * carrying an older version is one whose write was lost (or never happened). The third clause heals
 * cards written before #986: a FILL card always carries `progress` now, and one that does not is
 * still showing the sentence that claimed a filled form for a run that had filled nothing. It is
 * self-limiting — after the pass the block exists.
 */
async function applicationsNeedingCards(env: Env, userId: string, tailors: readonly string[], limit: number): Promise<{ ids: string[]; total: number }> {
	if (!tailors.length) return { ids: [], total: 0 };
	const inList = tailors.map((_, i) => `?${i + 2}`).join(",");
	const { results } = await env.DB.prepare(
		`SELECT a.id
		   FROM job_applications a
		   LEFT JOIN instance_runtime_tasks t ON t.id = 'app-' || a.id AND t.user_id = a.user_id
		  WHERE a.user_id = ?1 AND a.instance_id IN (${inList})
		    AND (t.id IS NULL
		         OR COALESCE(json_extract(t.payload, '$.application.stateVersion'), -1) < a.state_version
		         OR (a.fill_run_id IS NOT NULL AND json_extract(t.payload, '$.application.progress') IS NULL))
		  ORDER BY a.updated_at DESC, a.id`,
	)
		.bind(userId, ...tailors)
		.all<{ id: string }>()
		.catch(() => ({ results: [] as Array<{ id: string }> }));
	const ids = (results ?? []).map((r) => r.id);
	return { ids: ids.slice(0, limit), total: ids.length };
}

/**
 * Reconcile the application cards visible from ONE instance of the pipeline.
 *
 * Takes any member — Scout, Tailor or Runner — because `pipelineOf` resolves the graph from any of
 * them, which is what makes the Runner's own board heal when the owner opens it. An instance in no
 * apply pipeline is a no-op after one cheap read, so this is safe to call from the generic board
 * route for every instance.
 */
export async function reconcileApplicationCards(env: Env, userId: string, instanceId: string, opts: { limit?: number } = {}): Promise<ApplicationCardReconciliation> {
	const limit = Math.max(1, Math.min(opts.limit ?? RECONCILE_LIMIT, 100));
	try {
		const { pipelineOf } = await import("./control.js");
		const pipeline = await pipelineOf(env, userId, instanceId);
		const { ids, total } = await applicationsNeedingCards(env, userId, pipeline.tailors, limit);
		if (!ids.length) return { reconciled: 0, remaining: 0 };
		const { getOwnedApplication } = await import("../local-artifact/store.js");
		const { getApplyRun } = await import("../local-apply/store.js");
		let reconciled = 0;
		for (const id of ids) {
			const app = await getOwnedApplication(env, userId, id);
			if (!app) continue;
			// WHICH board, and which execution the card speaks for: the fill run when the application
			// has one (the Runner's board, where its owner looks for it), else the tailoring run on the
			// Tailor's. An application with neither has no execution to show and no board to be on —
			// it is a lead the Tailor has not started, and the queue is where it belongs.
			const fill = app.fillRunId ? await Promise.all(pipeline.runners.map((r) => getApplyRun(env, r, userId, app.fillRunId as string))).then((rs) => rs.find((r) => r)) : null;
			if (fill) {
				// The checkpoint a paused run is parked at, exactly as the live sync path passes it —
				// otherwise a backfilled card would omit the one thing a paused application is about.
				const { listSupervisorCheckpoints } = await import("../local-apply/supervision.js");
				const latest = fill.status === "paused" && fill.pause?.reason === "supervisor_checkpoint" ? (await listSupervisorCheckpoints(env, fill).catch(() => [])).at(-1) ?? null : null;
				await syncApplicationCard(env, userId, fill, "fill", {
					...(latest ? { checkpoint: { checkpointId: latest.checkpointId, phase: latest.facts.phase, directive: latest.directive?.directive ?? null } } : {}),
				});
				reconciled++;
				continue;
			}
			if (!app.tailoringRunId) continue;
			// `syncApplicationCard` resolves the home itself (the pipeline's Runner, else the Tailor),
			// so this passes the run's OWN instance and the home rule stays in one place.
			await syncApplicationCard(env, userId, { id: app.tailoringRunId, instanceId: app.instanceId, applicationId: app.id, status: tailoringCardStatus(app.status) }, "tailor");
			reconciled++;
		}
		return { reconciled, remaining: Math.max(0, total - reconciled) };
	} catch {
		// Visibility only, like every other card write in this file: a board that is one pass behind
		// is a far better outcome than a board route that 500s.
		return { reconciled: 0, remaining: 0 };
	}
}

/**
 * The run status a tailoring card is written with when the RUN is not what is being read.
 *
 * A backfill knows the application's lifecycle, not the Tailor run's own row, and the two agree on
 * everything a card shows: an application past `tailoring` has a finished run behind it, and one
 * still in it has a live one. `blocked` is the one that matters — it is what puts the card in the
 * board's "needs you" column.
 */
function tailoringCardStatus(applicationStatus: string): string {
	if (applicationStatus === "tailoring") return "running";
	if (applicationStatus === "blocked") return "paused";
	if (applicationStatus === "failed" || applicationStatus === "cancelled") return "failed";
	return "completed";
}
