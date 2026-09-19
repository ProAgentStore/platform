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
// ── The budget is new
//
// Not the stopped run's. #184's rule is that every autonomous entry point admits separately, and
// `POST /:id/loop` says so twice in its own queue branch. Inheriting the spent pool of the run that
// just stopped would be a continue that cannot pay for itself, and inheriting an unspent one would
// let a single admission fund an unbounded chain of continues.

import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { CONTINUE_RESUME_LOOKBACK_MS, getLoopRun, isResumableStopReason } from "../lib/agent-loop-store.js";
import { sanitizeMaxIterations } from "../lib/agent-loop.js";
import { clampIterations } from "../lib/loop-limits.js";
import { readLoopLimits } from "../lib/loop-limits-store.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { getSession } from "../lib/coding-store.js";
import { loopDriverFor } from "../lib/loop-drivers.js";
import { openBudget, resolveAccountCeilings } from "../lib/delegation-budget-store.js";
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

		// STILL GOING is a different fact from "cannot be continued", and conflating them sends the
		// owner to the wrong control. `finishedAt`, not `status`: a run with `cancelRequested` set
		// is still running until it reaches the top of its next iteration, and starting a second
		// run against the same session in that window is the single-flight collision #208 is about.
		if (run.finishedAt === null) throw new HttpError(409, "that run is still going — stop it first, then continue it");
		if (!isResumableStopReason(run.stopReason)) {
			throw new HttpError(409, REFUSAL[run.stopReason ?? ""] ?? "that run reached a verdict on its objective and cannot be continued");
		}

		const body = (await c.req.json().catch(() => ({}))) as {
			maxIterations?: number;
			budget?: { costMicros?: number; delegations?: number; maxDepth?: number };
		};

		// The stopped run's own ceiling is the DEFAULT, not a floor to add to. "Grant more
		// iterations" is what the owner asks for by naming a number; pressing Continue with an
		// empty body asks for another run of the same size, which is the conservative reading and
		// the one that cannot surprise an account's spend. Clamped by the same per-account ceiling
		// `POST /:id/loop` uses (#477) — a continue must not be a way around it.
		// …and the instance's floor and ceiling (#820). A continue is the path most likely to be
		// pressed with an empty body, which inherits the stopped run's own ceiling — and if that run
		// was one of the 10-iteration runs the floor exists to prevent, continuing it without the
		// clamp would grant another 10 and reproduce exactly the stall being continued past.
		const accountCeiling = (await resolveAccountCeilings(c.env, session.uid)).loopMaxIterations;
		const limits = await readLoopLimits(c.env, instanceId, session.uid).catch(() => ({}));
		const maxIterations = clampIterations(
			sanitizeMaxIterations(body.maxIterations ?? run.maxIterations, accountCeiling),
			limits,
			accountCeiling,
		);

		// The repo the stopped run was on, so a multi-repo Coder continues the right checkout
		// rather than `repos[0]` (#374). Null for a chat run, which has no session and no repo —
		// the chat driver ignores `repoId`, so a chat loop continues correctly by doing nothing
		// special here. A session that has since been deleted also lands on undefined, which
		// degrades to "you pick" rather than to a failure.
		const repoId = run.sessionId ? (await getSession(c.env, instanceId, session.uid, run.sessionId).catch(() => null))?.repoId : undefined;

		const budget = await openBudget(c.env, session.uid, instanceId, body.budget);
		const caps = await capabilitiesForInstance(c.env, instanceId, session.uid).catch(() => null);
		const driver = loopDriverFor(caps);
		const started = await driver.start({
			env: c.env,
			instanceId,
			userId: session.uid,
			objective: run.objective,
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
			{ runId: started.runId, driver: started.driver, budgetId: budget.id, maxIterations, status: "running", continuedFromRunId: run.runId },
			201,
		);
	});
}
