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

/**
 * What a `running` row actually means right now (#580).
 *
 * `status` has three states hiding inside it, and until 0127 the record could only express two of
 * them — badly. The distinction is not cosmetic: each licenses a different sentence to the owner and
 * a different intervention, and the two wrong ones are both destructive.
 *
 *   working  — the orchestrator is ticking. It may be many minutes into ONE instruction; a large
 *              refactor legitimately is. Nothing is wrong and nothing is wanted.
 *   waiting  — it is deliberately parked, until a stated instant or a stated event. This is the
 *              state run 70ea298e was in for 4.35 hours while every surface said "running".
 *   stalled  — nothing has ticked. The Workflow is gone and the row will say `running` forever.
 *   ended    — the run is CLOSED. No liveness claim is made in either direction (#459's rule),
 *              and `status`/`stopReason` are the answer to what happened.
 *
 * ── Why `ended` is a member and not an absence (#588)
 *
 * The first three describe a `running` row, so the original enum simply had no word for a closed
 * one and the classifier fell through to `working`. Measured live 2026-08-15: `health` was
 * `"working"` on ALL 89 runs across 7 instances, including runs that had failed days earlier. The
 * intent was right — a closed run makes no liveness claim — but "no claim" was folded onto the
 * member that reads as the strongest possible POSITIVE claim, which is strictly worse than the two
 * timestamps it replaced, because those at least disagreed visibly.
 *
 * Omitting the field on a closed run was the alternative and is rejected, on this batch's own
 * evidence: #594 records two supervision legends telling the model to read `acts[].ok`, a key the
 * payload never carried, and the failure mode it names is that **a model reads an absent key as
 * "fine"**. An absence cannot carry a meaning; a word can.
 */
export const RUN_HEALTH_STATES = ["working", "waiting", "stalled", "ended"] as const;

/**
 * The verdict, as a type — DERIVED from the runtime list above rather than declared beside it.
 *
 * A `type` union is erased, and this repo does not typecheck its Worker tests: `workers/api` and
 * `workers/mcp` both `exclude: ["src/**\/*.test.ts"]`, and vitest transpiles without checking. So a
 * guard written as `Record<RunHealth, true>` — the shape #588's own first pass used, and the shape
 * this file's legend guard used until now — compiles nowhere and fails never. It reads like an
 * exhaustiveness check and is decorative.
 *
 * One `as const` array makes the domain a VALUE, so the guards can iterate it at run time and go
 * red for real. It is also what lets `workers/mcp` back its copy: that worker cannot import from
 * here, so `state-vocabulary.test.ts` parses this declaration out of the source — the same shape,
 * and the same reason, as `coding-run-state.ts`'s `ENGINE_RUN_STATES`.
 */
export type RunHealth = (typeof RUN_HEALTH_STATES)[number];

/**
 * What `health` claims, said in the payload — because the payload is what the model reads (#259).
 *
 * Exported so every surface that ships the verdict ships the same explanation of it. A legend
 * restated by hand at each call site is the #585/#594 failure: prose that describes a field the
 * code has since changed, believed because it is right next to the data.
 */
export const RUN_HEALTH_LEGEND =
	// #596: `waitNote` says what a park is FOR in every case; it says when it ends only sometimes,
	// and the exception is the one that matters most. `coding-pause.ts:146` deliberately writes no
	// `waiting_until` for a HUMAN handoff, because that park's 15-minute deadline is the moment the
	// run GIVES UP, not the moment it resumes — and `waitClause` renders the field under "expected
	// to resume in". Promising "until when" unconditionally would tell an owner to sit and wait for
	// something that is about to stop waiting for them. State what is true for every park reason.
	// The COUNT is computed, not typed. "three values" is the exact sentence that went stale in two
	// MCP descriptions when `ended` arrived (#588); a hand-written number restating the size of an
	// enum is the same claim as a hand-written list of it, and drifts the same way.
	`\`health\` is the PLATFORM'S OWN verdict on a run and there are ${RUN_HEALTH_STATES.length} values: \`working\` (the orchestrator is ticking — it may legitimately be many minutes into ONE instruction), ` +
	"`waiting` (deliberately parked — `waitNote` says what for, and gives a resume time only when one is knowable; read it, because one park is waiting for a PERSON and will not clear itself), `stalled` (nothing has ticked; the row will say `running` forever and the workflow is probably gone), " +
	"and `ended` (the run is CLOSED — read `status` and `stopReason` for what happened; `ended` makes NO claim that anything is running). " +
	"Quote `health` rather than deriving your own from `status` or the timestamps: a fresh heartbeat beside a stale advance is equally what a long engine turn, a park and a stall look like, and that inference has told an owner a run was stuck while the engine was mid-edit. " +
	"None of these speaks for the ENGINE — `health` is the orchestrator's state, never the CLI's output.";

/**
 * The fields a verdict is read from — a STRUCTURAL subset of `LoopRunView`, not that type (#589).
 *
 * `LoopRunView` is what `agent-loop-store` returns, and only two of the five readers of
 * `agent_loop_runs` hold one. The supervision path reads its own narrower row shape
 * (`instance-work.ts`'s `RunItem`, a cross-instance `UNION ALL`), and because it could not satisfy
 * `LoopRunView` it derived activity from the raw `status` column instead — reporting a run parked
 * 4.35 hours as `activity:"working"` while `check_instance_loop` said `waiting` about the same row
 * at the same instant.
 *
 * So the input is the SIGNALS rather than a producer's record type. Anything holding these four
 * fields gets the platform's verdict; nothing has an excuse to compute a second one. Every field
 * but `status` is optional-and-nullable so a caller that genuinely has not read a column is a
 * missing signal (falling back exactly as an unwritten column does) rather than a type error that
 * pushes the caller into hand-rolling the rule again.
 */
export interface RunHealthInput {
	status: string;
	waitingReason?: string | null;
	lastAliveAt?: number | null;
	lastProgressAt?: number | null;
	startedAt: number;
}

/**
 * Classify a run, from the run record alone.
 *
 * ── Why the test is LIVENESS and not progress
 *
 * #580's own comment proposed classifying a run stalled when "liveness is fresh but progress is
 * stale". That signature is real, and it is also produced by the two healthiest things a coding run
 * does: one long engine turn (ten minutes of editing and a test suite, with no new instruction), and
 * a deliberate park. Calling either of them stalled is #459 exactly — a Lead read "step 3/50 after 9
 * minutes" as a stuck progress bar, told the owner there was "nothing I can do", and the
 * intervention that invites destroys work that was progressing normally.
 *
 * So progress-staleness is reported as a FACT (how long the current instruction has been running,
 * which `describeLoopRun` already prints) and never as a verdict, while the verdict is read off the
 * two signals that can actually carry it: the heartbeat, and the park.
 *
 * The heartbeat is what makes this stronger than what it replaces rather than merely different.
 * Before 0127 the only column was written per INSTRUCTION, so a healthy long turn crossed the 15
 * minute line and read as stalled; `last_alive_at` is written by the pause tick and by the capture
 * poll, at most a minute apart, so silence on it is evidence rather than a slow step.
 */
export function runHealth(run: RunHealthInput, now: number): RunHealth {
	// A CLOSED run makes no liveness claim in either direction (#459's rule, #588's member).
	if (run.status !== "running") return "ended";
	// A park OUTRANKS the heartbeat test, and deliberately so: a run parked on a platform
	// interruption (#583) is mid-resume and has nothing ticking BY DESIGN, so reading its silence as
	// death would report a recovery in progress as a failure.
	if (run.waitingReason) return "waiting";
	const last = run.lastAliveAt ?? run.lastProgressAt ?? run.startedAt;
	return now - last > STALLED_AFTER_MS ? "stalled" : "working";
}

/** Is this run's `running` status believable right now? */
export function isStalled(run: RunHealthInput, now: number): boolean {
	return runHealth(run, now) === "stalled";
}

/**
 * The clause a parked run gets instead of a stall or a false all-clear.
 *
 * Takes {@link RunHealthInput} plus the park's end, for the same reason `runHealth` does: the
 * supervision reader holds these columns and nothing else, and a signature it cannot satisfy is
 * what sent it off to derive its own answer.
 */
export function waitClause(run: RunHealthInput & { waitingUntil?: number | null }, now: number): string | null {
	// A FINISHED run makes no liveness claim in either direction (#459) — and `finishLoopRun` does
	// not clear the park columns, so a run that ended while parked still carries them. Reading them
	// on a closed row would announce a wait that is over.
	if (run.status !== "running" || !run.waitingReason) return null;
	const why =
		run.waitingReason === "engine_limit"
			? "the coding CLI's own usage limit has to reset"
			: run.waitingReason === "human"
				? "it is waiting for YOU to answer a handoff"
				: "a platform update interrupted it and it is being resumed";
	const until = run.waitingUntil && run.waitingUntil > now ? `, expected to resume in ${ago(run.waitingUntil - now).replace(" ago", "")}` : "";
	// Said out loud, because the whole defect is that this state was indistinguishable from working:
	// nothing has advanced and that is CORRECT, so neither "stalled" nor a bare "running" is honest.
	return `WAITING, not stalled and not working — ${why}${until}. No instruction has advanced since it parked, which is expected`;
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
 * What it deliberately does NOT claim: that the ENGINE is working. `lastAliveAt` is the
 * ORCHESTRATOR's heartbeat and `lastProgressAt` its last advance — neither is the engine's last
 * output. The live `runState` lives behind `/capture`, on the coding surface, and `work-report.ts`
 * describes loop runs that may have no engine at all. Asserting "engine: working" from these columns
 * would replace a false stall with a false all-clear, which is the same defect facing the other way.
 *
 * #580 measured that gap from the other end: `check_instance_loop` reported `running` with a fresh
 * timestamp at the same moment `coding_session_capture.runState` said `idle` and the pane showed the
 * engine's own limit message. The caveat written here was correct and was confined to this file.
 */
// The word "engine" is deliberately absent from this sentence: #465's guards assert that a run with
// no live capture renders NO engine clause by matching /engine/i over the whole report, and a
// caveat that names it here would satisfy that match and quietly disarm them.
const NOT_STALLED = `NOT stalled — a run counts as stalled only after ${Math.round(STALLED_AFTER_MS / 60_000)}m with nothing ticking, and this one is inside that window`;

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
	const health = runHealth(run, now);
	const stalled = health === "stalled";
	const status =
		health === "stalled"
			? "running but STALLED (nothing has ticked recently — it may have died)"
			: health === "waiting"
				? "running but PARKED (deliberately waiting — see below)"
				: run.status;
	parts.push(`run ${run.runId}: ${status}`);
	parts.push(`objective: ${run.objective}`);
	// "step N/M" read as a progress bar and is not one: it counts the instructions the orchestrator
	// has SENT, and one instruction is a whole engine turn — reading files, editing, running a test
	// suite — which legitimately takes ten minutes. "step 3/50 after 9 minutes" looks like 6% done;
	// it was one long healthy step. Naming it an instruction, capping it with "up to", and pairing
	// it with the elapsed time IN the current step leaves a long step legible as a long step.
	const inStep = run.status === "running" ? ` (this one has been running ${ago(now - (run.lastProgressAt ?? run.startedAt)).replace(" ago", "")})` : "";
	parts.push(`instruction ${run.iteration} of up to ${run.maxIterations}${inStep}`);
	// The park clause REPLACES the not-stalled clause rather than joining it (#580). Both are true
	// of a parked run and printing them together is what produced the reported confusion: "NOT
	// stalled" beside a four-hour-old instruction reads as an all-clear, which is the same over-claim
	// facing the other way.
	const waiting = waitClause(run, now);
	if (waiting) parts.push(waiting);
	else if (!stalled && run.status === "running") parts.push(NOT_STALLED);
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
