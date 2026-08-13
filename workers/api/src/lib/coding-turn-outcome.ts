/**
 * What the cloud may assert when the Engine reports a failed turn (#545).
 *
 * The runner now carries `lastTurn` on every snapshot — `{verdict, exitCode, signal, at, detail}`,
 * see `packages/browser-runner/src/coding/engine-turn.ts`. This module holds the JUDGEMENT over
 * it, which is a separate question from the measurement and is the part that will be argued with
 * later:
 *
 *   * ONE non-zero exit is not a dead session. A CLI can exit and be relaunched; `codex exec` can
 *     exit non-zero having done real work (a test suite it ran failed). Ending a run on the first
 *     one would strand work exactly the way a false `ready` does — the opposite error, and the
 *     more expensive of the two, because the run is killed rather than merely mis-described.
 *   * THREE consecutive failures with no successful turn between them is not a healthy session by
 *     any reading. That was the production shape: three turns, three exit-1s, the same refusal
 *     printed each time, and fifteen minutes spent on a signal the runner had at the first one.
 *
 * So: report every failure to the brain, and bound the streak. The bound is CONSECUTIVE and reset
 * by any turn the engine says worked — the same shape, and for the same reason, as
 * `MAX_EMPTY_INSTRUCTIONS` in coding-loop.ts: the production run that motivated that one recovered
 * on its own eleven times, and a total counter would have killed it.
 *
 * Pure, so the table below is testable without a runner, a Workflow or an LLM.
 */

/** The runner's report, widened to what arrives over HTTP from a machine we do not control. */
export interface EngineTurnReport {
	verdict?: string;
	exitCode?: number | null;
	signal?: string | null;
	at?: number;
	detail?: string;
}

/**
 * How many consecutive failed turns end the run.
 *
 * Three, matching {@link MAX_EMPTY_INSTRUCTIONS}'s reasoning and the sentence above: one is a
 * mishap, three in a row with nothing working in between is the engine refusing to run.
 */
export const MAX_ENGINE_FAILURES = 3;

/**
 * The CLI release that first reports `lastTurn`. Named rather than "update the CLI", the pattern
 * `SWITCH_BRANCH_MIN_CLI` and `REPO_SEARCH_MIN_CLI` set — a version without a number is one
 * somebody has to go and find.
 */
export const TURN_REPORT_MIN_CLI = "0.4.51";

/**
 * What one report means.
 *
 * `unknown` is the load-bearing member: an older runner sends no field at all, and a session on
 * which no turn has completed has none either. Neither is evidence of anything, so `unknown`
 * neither counts toward the bound NOR resets it — the same rule `verdictFromCheck` applies to
 * `checked !== true` in coding-workdir.ts. A cloud that read absence as failure would end runs on
 * every machine that has not updated.
 */
export type TurnClass = "ok" | "failed" | "killed" | "unknown";

export function classifyTurn(report: EngineTurnReport | null | undefined): TurnClass {
	if (!report || typeof report.at !== "number") return "unknown";
	switch (report.verdict) {
		case "ok":
			return "ok";
		case "failed":
			return "failed";
		case "killed":
			return "killed";
		default:
			// A verdict this build does not recognise is not a failure. The runner is a published
			// npm package on someone else's machine and may be NEWER than this Worker.
			return "unknown";
	}
}

/**
 * The streak, carried across steps of one run.
 *
 * `lastAt` is the turn's IDENTITY: the loop sees the same report on every poll — the top-of-step
 * snapshot, the `waitIdle` result, the next step's snapshot — and counting a report rather than a
 * TURN would reach the bound on a single failure in three polls.
 */
export interface TurnStreak {
	/** `at` of the most recently OBSERVED turn, whatever its verdict. */
	lastAt: number | null;
	/** Consecutive failed turns, reset by any `ok`. */
	consecutive: number;
	/** The engine's own last words on the most recent failure, for the report to the human. */
	lastDetail?: string;
	/** The exit code of the most recent failure, when there was one. */
	lastExitCode?: number | null;
}

export const EMPTY_STREAK: TurnStreak = { lastAt: null, consecutive: 0 };

export interface TurnObservation {
	streak: TurnStreak;
	/** True only on the poll that FIRST sees a given failed turn — never on a re-read of it. */
	newFailure: boolean;
}

/**
 * Fold one snapshot's report into the streak.
 *
 * The table, in full:
 *   report absent / unrecognised → nothing changes (see {@link TurnClass}).
 *   `at` already observed        → nothing changes. Same turn, seen again.
 *   `ok`                         → streak resets to 0. The engine works.
 *   `killed`                     → observed, counted as neither. WE ended it.
 *   `failed`                     → +1, and `newFailure` for the caller to report.
 */
export function observeTurn(streak: TurnStreak, report: EngineTurnReport | null | undefined): TurnObservation {
	const kind = classifyTurn(report);
	if (kind === "unknown") return { streak, newFailure: false };
	const at = report?.at as number;
	if (streak.lastAt !== null && at <= streak.lastAt) return { streak, newFailure: false };
	if (kind === "ok") return { streak: { lastAt: at, consecutive: 0 }, newFailure: false };
	if (kind === "killed") return { streak: { ...streak, lastAt: at }, newFailure: false };
	return {
		streak: {
			lastAt: at,
			consecutive: streak.consecutive + 1,
			...(report?.detail ? { lastDetail: report.detail } : {}),
			lastExitCode: typeof report?.exitCode === "number" ? report.exitCode : null,
		},
		newFailure: true,
	};
}

/** How the engine's exit reads in a sentence. `exit 1` when it exited; vaguer when it did not. */
function howItEnded(exitCode: number | null | undefined): string {
	return typeof exitCode === "number" ? `exited with code ${exitCode}` : "reported the turn as failed";
}

/**
 * The note pushed into `actionLog` on a failed turn, i.e. what the BRAIN is told.
 *
 * It goes through `actionLog` because that is the channel the loop already talks to itself
 * through — the same one carrying the empty-instruction note (#504) and the merge refusal (#314),
 * both of which the brain demonstrably reacts to. It names the CLASS of problem, because the
 * production failure was the brain reading "Not inside a trusted directory" as a path problem and
 * trying three path variants in eight seconds: an engine that refuses to start is not an answer to
 * the instruction, and no rephrasing of the instruction addresses it.
 *
 * Per ADR 0002 it states the size of what it measured — which turn, and how many in a row.
 */
export function engineFailureNote(streak: TurnStreak): string {
	const said = streak.lastDetail ? ` It said: "${streak.lastDetail}"` : "";
	const count = streak.consecutive === 1 ? "" : ` — ${streak.consecutive} consecutive failed turns now`;
	return `the engine ${howItEnded(streak.lastExitCode)} and produced no result${count}.${said} This is the ENGINE refusing to run, not an answer to your instruction — rephrasing or re-pathing the same instruction will not change it. Address why the engine cannot run, or finish with status "failed".`;
}

/**
 * The run's own failure detail when the bound is reached, i.e. what the HUMAN is told.
 *
 * `failed`, deliberately, and NOT `stuck`: a stuck handoff waits 15 minutes for a human who cannot
 * fix a CLI that refuses on every invocation, and the production run ended
 * "failed — stuck not resolved in time" for exactly that reason. The engine's own last line is
 * quoted, because it is invariably the actionable part ("--skip-git-repo-check was not specified"),
 * and the count is stated so the reader can tell this from a single unlucky exit.
 */
export function engineFailureDetail(streak: TurnStreak, repo?: string): string {
	const where = repo ? ` in ${repo}` : "";
	const said = streak.lastDetail ? ` Its last words were: "${streak.lastDetail}".` : "";
	return `The coding engine${where} ${howItEnded(streak.lastExitCode)} on ${streak.consecutive} consecutive turns, with no successful turn in between.${said} Nothing a further instruction can say will change that — fix why the engine cannot run on this checkout, then start the run again.`;
}
