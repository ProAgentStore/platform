// How an agent reads back its OWN runs (#256).
//
// `start_work` gave an agent a way to act. Nothing gave it a way to look. Its resolved tool set —
// after `drive:false` correctly removed `read_terminal` / `send_to_cli` / `list_coding_repos`, so a
// chat could not become a second uncoordinated driver — contained no tool that takes the run id
// `start_work` returns, and `get_activity` is a generic event feed, not an answer to "did the thing
// I started finish?".
//
// That is the mechanism behind #254, not a separate problem. Asked "did YOU pull it or did the
// agent?", the agent had nothing that could settle the question: it could not check the run, read
// the terminal, or see the session. With no evidence it deferred to a system prompt that said it
// could not act, and denied work it had really done.
//
// **An agent that can act but cannot observe its own actions is structurally forced to either
// fabricate or deny.** Both were observed on the same instance within two days. So the fix is a way
// to LOOK, not another instruction to be careful.
//
// Pure and exported: the same rendering serves the `check_work` tool result and the automatic
// "recent work" context block, so the two can never tell different stories about one run.
import { formatInZone } from "./agent-clock.js";
import type { LoopRunView } from "./agent-loop-store.js";
import { type TerminalView } from "./terminal-label.js";

/**
 * A run's wall-clock time, in the OWNER's zone, formatted here (#329).
 *
 * The reported symptom of #329 was a Lead saying *"the run completed at 22:34:19 UTC"* — a different
 * claim from the one its reader heard. Relative times (`ago`) were always safe because they carry no
 * zone; the moment an absolute time is wanted, the honest place to produce it is here, where the
 * epoch millisecond and the zone are both in hand, rather than in a model asked to do DST arithmetic
 * on an ISO string. Absent zone ⇒ absent clause: no zone means no local time, never a guessed one.
 */
function at(ms: number, zone?: string): string {
	if (!zone) return "";
	try {
		return ` (${formatInZone(ms, zone)})`;
	} catch {
		// A stored zone this runtime cannot resolve must not take down a chat turn. The relative time
		// beside it is still true, so degrading to it loses precision and nothing else.
		return "";
	}
}

/** Round to a human interval. Exact ms in a prompt invites the model to quote it back as precision. */
function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/**
 * How long a `running` run may go quiet before it should be reported as possibly stalled.
 *
 * A Workflow that dies mid-step leaves `status = 'running'` forever, so "running" alone is not
 * evidence that anything is happening — reporting it as live is the same over-claim in a new place.
 * 15 minutes is well past a normal engine step and well short of a long build.
 */
export const STALLED_AFTER_MS = 15 * 60 * 1000;

/** Is this run's `running` status believable right now? */
export function isStalled(run: LoopRunView, now: number): boolean {
	if (run.status !== "running") return false;
	const last = run.lastProgressAt ?? run.startedAt;
	return now - last > STALLED_AFTER_MS;
}

/**
 * Liveness, stated POSITIVELY (#459).
 *
 * The report used to say something about liveness only when a run was stalled. A healthy run got
 * silence, and a model fills silence with an inference — on a live instance it read "step 3/50
 * after 9 minutes" as a stuck progress bar and told the owner the run was stalled and that there
 * was "nothing I can do", while the engine was mid-edit patching tests. The owner's next question
 * was "why is it blocked?", and the intervention that invites — restart the session, kill the
 * engine — destroys work that was progressing normally.
 *
 * `isStalled` is the platform's answer to "is this run stuck?". This makes it say the NEGATIVE
 * answer out loud, so the agent has a verdict to quote instead of a counter to interpret.
 *
 * What it deliberately does NOT claim: that the ENGINE is working. `lastProgressAt` is the
 * orchestrator's last recorded iteration, not the engine's last output — the live `runState` lives
 * behind `/capture`, on the coding surface, and `work-report.ts` describes loop runs that may have
 * no engine at all. Asserting "engine: working" from this column would replace a false stall with
 * a false all-clear, which is the same defect facing the other way.
 */
const NOT_STALLED = `NOT stalled — a run counts as stalled only after ${Math.round(STALLED_AFTER_MS / 60_000)}m with no progress, and this one is inside that window`;

/**
 * The engine clause from a live terminal capture (#465).
 *
 * Pure so it is unit-testable without I/O. The ABSENCE of a clause (no session) is a real
 * answer — never render "unknown" or blank for a non-coding run.
 *
 * The four cases mirror `describeTerminal`'s `TerminalKind`:
 *   live-active  → the engine is visibly working right now
 *   live-idle    → the engine is not producing output this turn
 *   capture-failed → could not read the engine; the caller must NOT infer idle or done
 *   runner-offline → the machine is offline; nothing is running
 *   empty-pane / none / absent → omit the clause entirely
 */
export function engineClause(view: TerminalView | null | undefined): string | null {
	if (!view) return null;
	switch (view.kind) {
		case "live-active":
			return "engine: working (as of this turn)";
		case "live-idle":
			return "engine: idle — not producing output right now";
		case "capture-failed":
			return "engine: could not be read this turn — do NOT infer idle or finished";
		case "runner-offline":
			return "engine: the machine running it is offline";
		default:
			// empty-pane, none — not enough signal to make a claim either way
			return null;
	}
}

/**
 * One run, in the words the agent should use about it.
 *
 * The outcome is stated FIRST and unhedged. The whole point is that when the user asks "did that
 * actually happen?", the agent has a sentence it can quote instead of a belief it has to form.
 *
 * `engineView` is an optional pre-resolved terminal capture for a RUNNING coding run (#465).
 * The caller (check_work handler) fetches it live so this function stays pure and its unit tests
 * stay self-contained. Absent for non-coding runs, in which case no engine clause is rendered.
 */
export function describeLoopRun(run: LoopRunView, now: number = Date.now(), timeZone?: string, engineView?: TerminalView | null): string {
	const parts: string[] = [];
	const stalled = isStalled(run, now);
	const status = stalled ? "running but STALLED (no progress reported recently — it may have died)" : run.status;
	parts.push(`run ${run.runId}: ${status}`);
	parts.push(`objective: ${run.objective}`);
	// "step N/M" read as a progress bar and is not one: it counts the instructions the orchestrator
	// has SENT, and one instruction is a whole engine turn — reading files, editing, running a test
	// suite — which legitimately takes ten minutes. "step 3/50 after 9 minutes" looks like 6% done;
	// it was one long healthy step. Naming it an instruction, capping it with "up to", and pairing
	// it with the elapsed time IN the current step leaves a long step legible as a long step.
	const inStep = run.status === "running" ? ` (this one has been running ${ago(now - (run.lastProgressAt ?? run.startedAt)).replace(" ago", "")})` : "";
	parts.push(`instruction ${run.iteration} of up to ${run.maxIterations}${inStep}`);
	if (!stalled && run.status === "running") parts.push(NOT_STALLED);
	// #465: the engine clause is only present for a running coding run with a resolved capture.
	// Absent for non-coding runs and for completed/failed runs (the engine is no longer running).
	if (run.status === "running") {
		const clause = engineClause(engineView);
		if (clause) parts.push(clause);
	}
	if (run.stopReason) parts.push(`stopped because: ${run.stopReason}`);
	if (run.detail) parts.push(`result: ${run.detail}`);
	parts.push(`started ${ago(now - run.startedAt)}${at(run.startedAt, timeZone)}`);
	if (run.finishedAt) parts.push(`finished ${ago(now - run.finishedAt)}${at(run.finishedAt, timeZone)}`);
	if (run.cancelRequested && run.status === "running") parts.push("a cancel has been requested");
	return parts.join(" · ");
}

/**
 * What ELSE counts as this agent's work (#318).
 *
 * A supervisor's runs are not on its own instance — `delegate_goal` starts them on the subordinate
 * — so for a delegator the instance-scoped list is structurally empty and says nothing about what
 * it has done.
 */
export interface WorkCheckContext {
	/** Runs this instance started on agents it supervises, newest first. */
	delegated?: readonly LoopRunView[];
	/**
	 * Does this instance supervise anyone at all?
	 *
	 * Read ONLY in the nothing-to-report case, where it decides what the answer is entitled to
	 * assert. See {@link describeWorkCheck}.
	 */
	supervises?: boolean;
	/**
	 * The OWNER's IANA timezone (#329), when they have set one.
	 *
	 * Optional and unset-by-default on purpose: it is the account preference from #211, and an
	 * account that has never set one gets relative times only — the same output as before this
	 * existed — rather than a wall-clock in a zone nobody chose.
	 */
	timeZone?: string;
	/**
	 * Live terminal views for running coding runs, keyed by `runId` (#465).
	 *
	 * Resolved by the `check_work` handler via `/coding/capture` so `describeLoopRun` stays pure.
	 * Absent (or missing a key) ⇒ no engine clause for that run, which is correct for non-coding
	 * runs and for runs whose capture failed at the handler level.
	 */
	engineViews?: ReadonlyMap<string, TerminalView>;
}

/** One delegated run, named with the agent it was handed to so the supervisor can cite both. */
function describeDelegatedRun(run: LoopRunView, now: number, timeZone?: string, engineViews?: ReadonlyMap<string, TerminalView>): string {
	return `${describeLoopRun(run, now, timeZone, engineViews?.get(run.runId))} · delegated to instance ${run.instanceId}`;
}

/**
 * The `check_work` tool result.
 *
 * The empty case is a real answer, not an error: "you have not started any work" is exactly what an
 * agent needs to hear before it agrees with a user who thinks it did something. An error would be
 * read as "could not tell", which is the state that produces a guess.
 *
 * But there are TWO empty cases and they license different sentences. For an agent that runs its
 * own work, an empty record IS the whole record, so #254's correction stands unchanged: it was
 * written for an agent that ran nothing and claimed it had. For a DELEGATOR the same emptiness is
 * expected — its work lives on its subordinates — and the correction fired on a Lead that had
 * delegated 90 seconds earlier and reported it truthfully, instructing it to retract a true
 * statement. Asserting the user was misled is an inference this record cannot support unless it
 * can see everything the agent could have done, which for a supervisor it cannot.
 */
export function describeWorkCheck(
	runs: readonly LoopRunView[],
	now: number = Date.now(),
	ctx: WorkCheckContext = {},
): string {
	const delegated = ctx.delegated ?? [];
	const ev = ctx.engineViews;
	const sections: string[] = [];
	if (runs.length) {
		sections.push(
			`${runs.length === 1 ? "The run" : `Your ${runs.length} most recent runs`} on this instance, newest first:\n` +
				runs.map((r) => `- ${describeLoopRun(r, now, ctx.timeZone, ev?.get(r.runId))}`).join("\n"),
		);
	}
	if (delegated.length) {
		sections.push(
			`${delegated.length === 1 ? "One run" : `${delegated.length} runs`} YOU started by delegating to an agent you` +
				" supervise, newest first. You started these — the work runs on them, and saying you did it is accurate:\n" +
				delegated.map((r) => `- ${describeDelegatedRun(r, now, ctx.timeZone, ev)}`).join("\n"),
		);
	}
	if (!sections.length) {
		return ctx.supervises
			? "No runs on this instance, and none you delegated to the agents you supervise. Your own work would be" +
					" delegated, so check `check_delegation` and `subordinate_status` before agreeing that nothing happened —" +
					" and do not tell the user you were wrong on the strength of this answer alone."
			: "You have not started any work on this instance — there are no runs. If you told the user you did something, that was wrong; say so.";
	}
	return (
		`${sections.join("\n\n")}\n\nThis is the record of what you actually started. Report it as-is; do not soften or retract it.`
	);
}

/**
 * The automatic context block — what the agent knows about its own work WITHOUT calling a tool.
 *
 * #256 asks for this explicitly, and it is the stronger half of the fix: the denial happened in a
 * single turn, in reply to a direct challenge, and a model that has to decide to call a tool before
 * it can defend a true statement will often just apologise instead. Having the answer already in
 * the prompt removes the decision.
 *
 * Capped at a few runs — this is orientation, not a log; `check_work` is there for the rest.
 *
 * `ctx.delegated` is the same fix as in `describeWorkCheck` and for the stronger reason: the Lead
 * in #318 DID call `check_work` and still recanted, so a supervisor's delegations belong in the
 * prompt before the challenge arrives, not only in a tool it has to decide to reach for.
 */
export function recentWorkPrompt(
	runs: readonly LoopRunView[],
	now: number = Date.now(),
	ctx: WorkCheckContext = {},
): string {
	const delegated = ctx.delegated ?? [];
	if (!runs.length && !delegated.length) return "";
	const lines = [
		...runs.map((r) => `- ${describeLoopRun(r, now, ctx.timeZone)}`),
		...delegated.map((r) => `- ${describeDelegatedRun(r, now, ctx.timeZone)}`),
	];
	return (
		"\n\n## Your recent work\nRuns YOU started — with `start_work`, or by delegating to an agent you supervise" +
		" (newest first). This is fact, from the run record: if the user asks whether you did something, answer from" +
		" here, and call `check_work` for more. Never deny one of these because you do not remember it:\n" +
		lines.join("\n")
	);
}
