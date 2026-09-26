// Continue a run that stopped without reaching a verdict (#806 item 3(c)).
//
// A helper module for the same reason `loop-queue-routes.ts` is one: `routes/tools.ts` is the
// largest route file in the tree and pinned by the #302 ratchet, so what lands there is the two
// lines that register this.
//
// ── What "continue" is, and what it is not
//
// It is a NEW run, carrying the stopped run's objective onto the same repository, with the
// iteration ceiling the owner chose. It is not a resumed invocation: a finished `agent_loop_runs`
// row has no live Workflow to grant steps to, and #523's recorded choice — option (b), checkpoint
// the OBJECTIVE, not the transcript — means there is no transcript to reanimate even in principle.
// The continuity the owner actually gets is the resume note (`lib/coding-resume-note.ts`), which is
// composed at the start of the new run from what the old one left on the record.
//
// That is why this route is thin, and why it must be: every guarantee it appears to offer is
// already owned by something else. `driver.start()` picks the repo, opens or reuses the session,
// runs the admission checks and takes the single-flight claim; the workflow composes the briefing.
// A continue that assembled any of that itself would be a second, quieter copy of the start path —
// which is precisely how `delegate-instance.ts`'s duplicate lost `onBehalfOf` (see
// `LoopStartInput.onBehalfOf`).
//
// ── Why the note is not pinned to the run being continued
//
// The obvious design is to hand the new run the id of the run it continues and brief it on THAT.
// It is wrong in the one case that matters. `lastUnfinishedRunForRepo` deliberately takes the most
// recent finished run on the repo and only THEN asks what ended it, so that a run which reached a
// verdict in between ends the note's job (its header sets this out in full). Pinning would skip
// that check and brief the new run on a checkpoint another run has already consumed — re-doing work
// that is on the trunk, which is #523's opening complaint pointed the other way. So the continue
// widens the SEARCH ({@link CONTINUE_RESUME_LOOKBACK_MS}) and changes nothing about the choosing.
// In the ordinary case the run the owner pressed the button on IS the most recent finished run on
// its repo, and it is the one that gets quoted.
//
// ── What "with its prior context intact" means here (#806 items 1 and 3(b))
//
// Two things carry, and neither is a transcript. The stopped Pilot's own `learned` notes (#822)
// are already rows on its session's timeline, so the briefing quotes them — what it had worked out
// and where it had got to, in its words; `coding-resume-note.ts` records why that is still option
// (b). And the ENGINE's conversation is the platform's to restore already: a new session on the
// repo adopts the previous one's CLI conversation inside its four-day window, and is seeded from the
// timeline's record when it cannot (`coding-session-continuity.ts`, `coding-seed-brief.ts`). So the
// owner's half is the one thing nothing else could supply: what THEY know now that the run did
// not — `note` below.
//
// ── The budget is new
//
// Not the stopped run's. #184's rule is that every autonomous entry point admits separately, and
// `POST /:id/loop` says so twice in its own queue branch. Inheriting the spent pool of the run that
// just stopped would be a continue that cannot pay for itself, and inheriting an unspent one would
// let a single admission fund an unbounded chain of continues.

import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { CONTINUE_RESUME_LOOKBACK_MS, getLoopRun, isResumableStopReason, type LoopRunView } from "../lib/agent-loop-store.js";
import { sanitizeMaxIterations } from "../lib/agent-loop.js";
import { clampIterations, DEFAULT_MAX_OBJECTIVE_CHARS, effectiveMaxObjectiveChars } from "../lib/loop-limits.js";
import { readLoopLimits } from "../lib/loop-limits-store.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { getRepo, getSession } from "../lib/coding-store.js";
import { loopDriverFor } from "../lib/loop-drivers.js";
import { openBudget, resolveAccountCeilings } from "../lib/delegation-budget-store.js";
import { pendingCodingResumeCheckpoint } from "../lib/coding-resume-note.js";
import { continueBriefingPreview, continueBriefingSentence, type WorkingTreeRead } from "../lib/loop-continue-preview.js";
import { readRepoWorkingState } from "../lib/repo-state.js";
import { getBoundRunnerConn } from "../lib/runner-client.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * Why a run cannot be continued, in the owner's words rather than the enum's.
 *
 * Each of these is a DIFFERENT next step, which is the whole reason they are not one sentence: a
 * `done` run needs a new objective, a `failed` one needs the failure read first, a `cancelled` one
 * was the owner's own decision and continuing it silently would undo that decision. The set that
 * IS continuable is `RESUMABLE_STOP_REASONS`, and it is not restated here — one list, one place.
 */
const REFUSAL: Record<string, string> = {
	done: "that run finished its objective — start a new one rather than continuing it",
	failed: "that run failed and said why; read its outcome first, because repeating its steps may be exactly wrong",
	cancelled: "you stopped that run — start a fresh one, which is the clean start continuing would quietly skip",
	escalated: "that run asked a human a question and is answered through its own handoff, not by continuing it",
	no_progress: "that run was repeating itself; continuing it would repeat it again — change the objective instead",
	budget: "that run hit its spend limit; raise the limit before starting more work on it",
};

/**
 * Why this run may not be continued, or null when it may.
 *
 * One function so the POST's refusal and the preview's `canContinue` are the same decision rather
 * than two readings of it. A preview that offered a run the POST would refuse would be a button
 * that always errors — the thing `loopContinue.ts` on the console already exists to prevent, and
 * a second place to get it wrong is not an improvement.
 *
 * STILL GOING is kept distinct from "cannot be continued" because it sends the owner to a
 * different control (Stop, then Continue). `finishedAt`, not `status`: a run with `cancelRequested`
 * set is still running until it reaches the top of its next iteration, and starting a second run
 * against the same session in that window is the single-flight collision #208 is about.
 */
export function continueRefusal(run: LoopRunView): string | null {
	if (run.finishedAt === null) return "that run is still going — stop it first, then continue it";
	if (isResumableStopReason(run.stopReason)) return null;
	return REFUSAL[run.stopReason ?? ""] ?? "that run reached a verdict on its objective and cannot be continued";
}

/**
 * How many steps a continue would grant — the stopped run's own ceiling unless the owner names one.
 *
 * Shared with the preview so the number shown is the number granted. Both clamps apply for the
 * reasons the POST records below: the per-account ceiling (#477) because a continue must not be a
 * way around it, and the instance's own floor and ceiling (#820) because the empty-body default
 * inherits the stopped run's cap — and if that run was one of the short runs the floor exists to
 * prevent, granting it again reproduces the stall being continued past.
 */
async function continueCeiling(env: Env, userId: string, instanceId: string, run: LoopRunView, requested?: number): Promise<number> {
	const accountCeiling = (await resolveAccountCeilings(env, userId)).loopMaxIterations;
	const limits = await readLoopLimits(env, instanceId, userId).catch(() => ({}));
	return clampIterations(sanitizeMaxIterations(requested ?? run.maxIterations, accountCeiling), limits, accountCeiling);
}


/** How the owner's addition is introduced. Exported so the tests quote it rather than restate it. */
export const OWNER_NOTE_LEAD = "Added by the owner when continuing this run:";

/**
 * The objective the new run carries: the stopped run's, plus whatever the owner added (#806 3(b)).
 *
 * IN the objective rather than beside it, for durability. A hint is one round's message and the
 * workflow clears it; the objective is in every decision the Pilot makes, on the run's row, in the
 * timeline's "AI run started" line — and therefore in the objective a LATER continue of this run
 * inherits. A course correction that lasted one round, or that the next continue dropped, would be
 * the owner re-typing what they had already said, which is the re-deriving this issue is about.
 *
 * Attributed in the text itself: the stopped run's words stay verbatim and first, and the addition
 * is labelled as the owner's and as later, so a Pilot reading "merge each" followed by "do not
 * merge, open PRs" can tell which one is the correction.
 *
 * Refused, not truncated, past the column's bound. A note cut mid-sentence is an instruction the
 * owner did not give, and `createLoopRun` would cut it silently.
 */
export function continueObjective(objective: string, note: unknown, limit = DEFAULT_MAX_OBJECTIVE_CHARS): string {
	const added = typeof note === "string" ? note.trim() : "";
	if (!added) return objective;
	const combined = `${objective}\n\n${OWNER_NOTE_LEAD} ${added}`;
	if (combined.length > limit) {
		const room = Math.max(0, limit - objective.length - OWNER_NOTE_LEAD.length - 3);
		throw new HttpError(400, `note too long — the objective and your note share ${limit} characters, which leaves ${room} for the note`);
	}
	return combined;
}

/**
 * The repo the stopped run was on, so a multi-repo Coder continues the right checkout rather than
 * `repos[0]` (#374). Undefined for a chat run, which has no session and no repo — the chat driver
 * ignores `repoId`, so a chat loop continues correctly by doing nothing special. A session that
 * has since been deleted also lands on undefined, which degrades to "you pick" rather than to a
 * failure.
 */
async function continueRepoId(env: Env, instanceId: string, userId: string, run: LoopRunView): Promise<string | undefined> {
	if (!run.sessionId) return undefined;
	return (await getSession(env, instanceId, userId, run.sessionId).catch(() => null))?.repoId;
}

export function registerLoopContinueRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * Carry a stopped run's objective onto a fresh run with a new iteration ceiling.
	 *
	 * 409 rather than 400 throughout: the request is well-formed and the run exists, but its state
	 * says no. A caller that reads 400 for this goes looking for a bug in its own body.
	 */
	router.post("/:id/loop/:runId/continue", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("id");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runId = c.req.param("runId");

		// `getLoopRun` is user-scoped but not instance-scoped, so the instance is checked here —
		// otherwise an owner with two agents could continue one agent's run through the other's
		// URL and the new run would open on the wrong instance entirely. The same guard, for the
		// same reason, is on `GET /:id/loop/:runId`'s sibling in `tool-registry.ts`.
		const run = await getLoopRun(c.env, session.uid, runId);
		if (!run || run.instanceId !== instanceId) throw new HttpError(404, "loop run not found");

		const refusal = continueRefusal(run);
		if (refusal) throw new HttpError(409, refusal);

		const body = (await c.req.json().catch(() => ({}))) as {
			maxIterations?: number;
			note?: string;
			budget?: { costMicros?: number; delegations?: number; maxDepth?: number };
		};
		// Before anything is opened: a refused note must not leave a budget behind it.
		// The instance's own objective cap (#854) — the same one `POST /:id/loop` applies.
		const limits = await readLoopLimits(c.env, instanceId, session.uid).catch(() => ({}));
		const objective = continueObjective(run.objective, body.note, effectiveMaxObjectiveChars(limits));

		// The stopped run's own ceiling is the DEFAULT, not a floor to add to. "Grant more
		// iterations" is what the owner asks for by naming a number; pressing Continue with an
		// empty body asks for another run of the same size, which is the conservative reading and
		// the one that cannot surprise an account's spend. The two clamps, and why each is there,
		// are on {@link continueCeiling} — which the preview calls too, so the number the owner is
		// shown is the number they get.
		const maxIterations = await continueCeiling(c.env, session.uid, instanceId, run, body.maxIterations);
		const repoId = await continueRepoId(c.env, instanceId, session.uid, run);

		const budget = await openBudget(c.env, session.uid, instanceId, body.budget);
		const caps = await capabilitiesForInstance(c.env, instanceId, session.uid).catch(() => null);
		const driver = loopDriverFor(caps);
		const started = await driver.start({
			env: c.env,
			instanceId,
			userId: session.uid,
			objective,
			maxIterations,
			repoId,
			budgetId: budget.id,
			depth: 0,
			// The one thing that makes this a continue rather than a restart (#806 item 4).
			resumeLookbackMs: CONTINUE_RESUME_LOOKBACK_MS,
		});
		if (!started.ok) throw new HttpError(started.status, started.error);
		// `continuedFromRunId` is in the RESPONSE and not on the row: nothing reads it back, and a
		// column claiming a lineage the resume note may not have honoured (see the header on why
		// the note is not pinned) would be a stored fact that can be false.
		return c.json(
			{ runId: started.runId, driver: started.driver, budgetId: budget.id, maxIterations, status: "running", continuedFromRunId: run.runId, noteAdded: objective !== run.objective },
			201,
		);
	});

	/**
	 * What a Continue on this run would carry forward — read-only, spends nothing (#806 item 2).
	 *
	 * A GET beside the POST rather than a `dryRun` flag on it. The POST's preview question is
	 * "would this be refused, and how big would it be", which a dry run answers; this one is "what
	 * would the new run KNOW", which needs two reads the POST does not make (the resume checkpoint
	 * and the checkout) and which an owner wants repeatedly while deciding. A read with no body is
	 * also the shape a console can poll and a cache can hold, and neither is true of a POST.
	 *
	 * 200 even when the run cannot be continued. The refusal is the ANSWER to "what would happen",
	 * not a failure of the question — and an owner reading why Continue is not offered is exactly
	 * the person this surface is for. The POST still refuses with 409; the two agree because they
	 * call the same {@link continueRefusal}.
	 */
	router.get("/:id/loop/:runId/continue-preview", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("id");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runId = c.req.param("runId");

		// Same instance guard as the POST, for the same reason: `getLoopRun` is user-scoped but not
		// instance-scoped, and one agent's run must not be readable through another agent's URL.
		const run = await getLoopRun(c.env, session.uid, runId);
		if (!run || run.instanceId !== instanceId) throw new HttpError(404, "loop run not found");

		const refusal = continueRefusal(run);
		const maxIterations = await continueCeiling(c.env, session.uid, instanceId, run);
		const repoId = await continueRepoId(c.env, instanceId, session.uid, run);

		// The checkout, best effort. `getBoundRunnerConn` honours the instance's "Runs on" pin, so
		// the machine probed is the one a continue would actually run on (#691). A missing runner
		// is the EXPECTED case for this surface — item 4 is an owner checking back the next
		// morning — so it is reported as unknown rather than swallowed into a zero.
		const repo = repoId ? await getRepo(c.env, instanceId, session.uid, repoId).catch(() => null) : null;
		const conn = repo ? await getBoundRunnerConn(c.env, instanceId, session.uid).catch(() => null) : null;
		const state = conn && repo ? await readRepoWorkingState(conn, { repo, sessionId: run.sessionId }).catch(() => null) : null;
		const tree: { files: number | null; read: WorkingTreeRead } = state
			? { files: state.changedFiles, read: "read" }
			: { files: null, read: "unavailable" };

		// THE SAME CALL THE RUN MAKES. `pendingCodingResumeNote` is a projection of this, so the
		// `note` below is the text the successor would be handed, not a reconstruction of it — and
		// the lookback is the continue's, or the preview would report "nothing carries forward" for
		// every run older than six hours while the button it describes would have found one.
		//
		// `uncommittedFiles` is the count we just read, or 0 when we could not read it — which is
		// exactly what the workflow passes on its own failed read (`repoState?.changedFiles ?? 0`),
		// so an unreadable tree produces the same note in both places rather than two different ones.
		const checkpoint = run.sessionId
			? await pendingCodingResumeCheckpoint(c.env, {
					userId: session.uid,
					instanceId,
					sessionId: run.sessionId,
					uncommittedFiles: state?.changedFiles ?? 0,
					lookbackMs: CONTINUE_RESUME_LOOKBACK_MS,
				})
			: null;

		const briefing = continueBriefingPreview(run.runId, checkpoint, tree);
		return c.json({
			runId: run.runId,
			objective: run.objective,
			status: run.status,
			stopReason: run.stopReason,
			detail: run.detail,
			iteration: run.iteration,
			canContinue: refusal === null,
			refusal,
			maxIterations,
			repoId: repoId ?? null,
			briefing,
			summary: continueBriefingSentence(briefing),
		});
	});
}
