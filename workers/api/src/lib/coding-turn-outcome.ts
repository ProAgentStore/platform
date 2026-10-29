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
import type { LoopEffect } from "./coding-loop-state.js";
import type { EngineAuthPrompt } from "./engine-auth-prompt.js";
import { engineProviderError, type ProviderErrorRecord, providerTurnVerdict, type ProviderTurnVerdict } from "./engine-provider-error.js";
import { redactText } from "./redact.js";

/** The runner's report, widened to what arrives over HTTP from a machine we do not control. */
export interface EngineTurnReport {
	verdict?: string;
	exitCode?: number | null;
	signal?: string | null;
	at?: number;
	detail?: string;
	/** The turn's own last lines of output (#889) — `[]` when it printed nothing; absent from an older runner. */
	tail?: string[];
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

/** The CLI release whose failed-turn report carries the engine's own output, `tail` (#889). */
export const TURN_TAIL_MIN_CLI = "0.4.68";

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
	/**
	 * The engine's own last lines on the most recent failure, redacted (#889). `[]` is the runner
	 * stating the engine printed nothing; absent means the runner did not measure it (CLI < the
	 * release that sends `tail`), which is a different claim and is worded differently.
	 */
	lastTail?: string[];
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
			...(report?.detail ? { lastDetail: redactText(report.detail) } : {}),
			lastExitCode: typeof report?.exitCode === "number" ? report.exitCode : null,
			...(Array.isArray(report?.tail) ? { lastTail: tailLines(report.tail as unknown[]) } : {}),
		},
		newFailure: true,
	};
}

/** Most lines of a tail ever kept, and the longest one — the runner bounds it too, but it is a machine we do not control. */
const MAX_TAIL_LINES = 60;
const MAX_TAIL_LINE = 400;

/** A reported tail made safe to quote: strings only, bounded, and secret-shaped values masked. */
function tailLines(tail: unknown[]): string[] {
	return tail
		.filter((l): l is string => typeof l === "string" && l.trim() !== "")
		.slice(-MAX_TAIL_LINES)
		.map((l) => redactText(l.length > MAX_TAIL_LINE ? `${l.slice(0, MAX_TAIL_LINE)}…` : l));
}

/**
 * The newest lines of the tail that fit in `budget` characters, as an indented verbatim block —
 * or the explicit "printed nothing" sentence when the runner measured an empty one (#889).
 *
 * NEWEST lines, because the end is where an engine says why it stopped. Bounded by a character
 * budget because the run's detail is stored in a column the store cuts at 2,000 characters
 * (`finishLoopRun`), and a cut there would remove the end of the block — the part that matters.
 */
function quotedTail(streak: TurnStreak, budget: number): string {
	const tail = streak.lastTail;
	if (!tail) return "";
	if (tail.length === 0) return "\n\nThe engine printed nothing at all on stdout or stderr on its last turn — there is no error text to show; the exit code is the only evidence.";
	const kept: string[] = [];
	let used = 0;
	for (let i = tail.length - 1; i >= 0; i--) {
		const cost = tail[i].length + 3; // the indent and the newline
		if (kept.length > 0 && used + cost > budget) break;
		kept.unshift(tail[i].length + 3 > budget ? `${tail[i].slice(0, Math.max(0, budget - 4))}…` : tail[i]);
		used += cost;
	}
	const of = kept.length < tail.length ? `last ${kept.length} of ${tail.length} lines` : `${kept.length} line${kept.length === 1 ? "" : "s"}`;
	return `\n\nThe engine's own output on its last turn (${of}, verbatim):\n${kept.map((l) => `  ${l}`).join("\n")}`;
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
	return `the engine ${howItEnded(streak.lastExitCode)} and produced no result${count}.${said} This is the ENGINE refusing to run, not an answer to your instruction — rephrasing or re-pathing the same instruction will not change it. Address why the engine cannot run, or finish with status "failed".${quotedTail(streak, NOTE_TAIL_BUDGET)}`;
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
	const head = `The coding engine${where} ${howItEnded(streak.lastExitCode)} on ${streak.consecutive} consecutive turns, with no successful turn in between.${said} Nothing a further instruction can say will change that — fix why the engine cannot run on this checkout, then start the run again.`;
	return head + quotedTail(streak, Math.max(200, DETAIL_BUDGET - head.length - 80));
}

/** What the brain's per-failure note may spend on the tail: it rides in the action log on every later step. */
const NOTE_TAIL_BUDGET = 2500;
/** The stored run detail's ceiling (`finishLoopRun` keeps 2,000 characters), less headroom. */
const DETAIL_BUDGET = 1950;

/**
 * The engine CLI crashed (#1200): an `engine_error` ending carrying the CLI's own words (`engineFailureDetail` — the
 * exit code and its last output), never a park on a person. Before, a turn that exited 1 on an invalid model left the
 * Pilot reading the error off the pane and escalating, and the run sat `waiting`/`human` with a countdown,
 * indistinguishable from a real question, with nothing in its ask, ticket or action log.
 */
export function engineErrorEnding(turns: TurnStreak, repo: string, transcript: string[]): { outcome: "engine_error"; detail: string } {
	const detail = engineFailureDetail(turns, repo);
	transcript.push(`finish: engine_error — ${detail}`);
	return { outcome: "engine_error", detail };
}

/**
 * The failed-turn streak, held by the workflow ACROSS rounds like `evidence` (#1344). A round used to start from an empty
 * streak, so the first snapshot after a park or a question re-read the turn before it as a new failure.
 */
export interface TurnCarry {
	turns: TurnStreak;
	/** Consecutive failed turns the engine's AI provider blamed on itself (#1326) — retried, not counted as strikes. */
	transientStreak: number;
	/**
	 * A turn worked since the last transient park (#1362). The workflow resets the transient-wait ladder on it, so the
	 * ladder bounds one outage: three short outages hours apart used to spend it, and the fourth ended the run.
	 */
	okTurnSeen?: boolean;
	/** The run is on its configured fallback model and no turn has worked on it yet (#1392). The first one that does is recorded as the fallback recovering. */
	fallbackModel?: string;
}

/** How a snapshot's failed turn ends the run, if it does. `reauth` carries the prompt the loop words itself (#881). */
export type TurnEnding =
	| { kind: "reauth"; block: EngineAuthPrompt }
	| { kind: "result"; outcome: "engine_error" | "waiting"; detail: string; waitKind?: ProviderTurnVerdict["waitKind"]; resetHint?: ProviderTurnVerdict["resetHint"]; providerError?: ProviderErrorRecord };

export interface TurnVerdict {
	/** The carry after this snapshot. The loop copies it onto the workflow's object, which outlives the round. */
	carry: TurnCarry;
	/** Notes to say, in order, before the ending (if any) is returned. */
	effects: LoopEffect[];
	ending: TurnEnding | null;
}

/**
 * The engine's own verdict on its last turn, folded into the run (#545, #1326, #1344): the loop's failed-turn handling as a
 * pure reducer. Same table as before it was lifted out of `runCodingLoop` — a NEW failed turn is reported once (the same
 * turn is re-read on every poll), a dead login ends in `reauth`, the provider's own words park / retry / end, and anything
 * else spends one of {@link MAX_ENGINE_FAILURES} consecutive strikes.
 *
 * `signInBlock` is read only when a new failure needs it.
 */
export function foldTurn(carry: TurnCarry, snap: { lastTurn?: EngineTurnReport | null }, ctx: { repo: string; signInBlock: () => EngineAuthPrompt | null }): TurnVerdict {
	const effects: LoopEffect[] = [];
	const seen = observeTurn(carry.turns, snap.lastTurn);
	let next: TurnCarry = { ...carry, turns: seen.streak };
	// A NEW turn that worked ends a transient run of failures; a re-read of the same turn changes nothing.
	if (seen.streak.lastAt !== carry.turns.lastAt && classifyTurn(snap.lastTurn) === "ok") {
		next = { ...next, transientStreak: 0, okTurnSeen: true };
		// The first worked turn on the fallback model is its outcome (#1392): recorded once, then the carry forgets it.
		if (carry.fallbackModel) {
			effects.push({ event: { name: "provider_fallback_outcome", detail: `A turn worked on the fallback ${carry.fallbackModel}.`, data: { attempt: 0, model: carry.fallbackModel, outcome: "recovered" } } });
			next = { ...next, fallbackModel: undefined };
		}
	}
	if (!seen.newFailure) return { carry: next, effects, ending: null };

	// A turn refused on a dead login is not one of three strikes — no instruction and no retry changes it, and only the owner signing the engine in does (#881).
	const block = ctx.signInBlock();
	if (block) return { carry: next, effects, ending: { kind: "reauth", block } };

	// THE PROVIDER'S OWN WORDS (#1326): a usage window parks, a transient failure is retried, an empty account ends —
	// none is the engine refusing to run, so none spends one of the strikes below.
	const provider = engineProviderError(next.turns.lastDetail, next.turns.lastTail);
	const verdict = providerTurnVerdict(provider, next.transientStreak, ctx.repo);
	const exitCode = next.turns.lastExitCode ?? null;
	const record: ProviderErrorRecord | undefined = provider ? { kind: provider.kind, provider: provider.provider, rule: provider.rule, exitCode, text: provider.text } : undefined;
	// Structured, durable facts (#1391): what the turn's words were classified as, and — always — what was decided about them and why. A run that
	// did NOT retry has to be able to say whether no rule matched, the runner sent no output to match, or a rule decided something else.
	if (record) {
		effects.push({ event: { name: "provider_error_classified", detail: `${record.provider} (${record.kind}): ${provider?.evidence ?? ""}`, data: { ...record, evidence: provider?.evidence, exitCode } } });
	}
	const decide = (decision: string, why: string, detail: string) =>
		effects.push({ event: { name: "provider_retry_decision", detail, data: { decision, why, exitCode, consecutiveFailures: next.turns.consecutive, transientStreak: verdict?.transientStreak ?? 0, ...(record ? { rule: record.rule, kind: record.kind } : {}) } } });
	next = { ...next, transientStreak: verdict?.transientStreak ?? 0 };
	if (verdict) next = { ...next, turns: { ...next.turns, consecutive: Math.max(0, next.turns.consecutive - 1) } };
	if (verdict?.end) {
		decide("end", "billing", `ending: ${record?.provider} reports no credit or quota`);
		effects.push({ transcript: `finish: engine_error — ${verdict.end}` });
		return { carry: next, effects, ending: { kind: "result", outcome: "engine_error", detail: verdict.end, ...(record ? { providerError: record } : {}) } };
	}
	if (verdict?.park) {
		decide("park", verdict.waitKind === "limit" ? "usage_limit" : "repeated_transient", `parking on ${record?.provider} (${verdict.waitKind})`);
		effects.push({ transcript: `waiting: ${verdict.park}`, event: { name: "waiting", detail: verdict.park } });
		return { carry: next, effects, ending: { kind: "result", outcome: "waiting", detail: verdict.park, waitKind: verdict.waitKind, ...(verdict.resetHint ? { resetHint: verdict.resetHint } : {}), ...(record ? { providerError: record } : {}) } };
	}
	if (verdict?.retry) {
		decide("resend", "first_transient_failure", `the Pilot is told to resend the same instruction once (${record?.provider})`);
		effects.push({ log: verdict.retry, transcript: verdict.retry, event: { name: "engine_failed", detail: verdict.retry } });
		return { carry: next, effects, ending: null };
	}
	// No rule matched. WHY matters: a runner that sent no output (older CLI) cannot be classified at all, which is a different fault from output
	// that no row recognises.
	decide("strike", next.turns.lastTail === undefined ? "tail_not_reported" : "no_rule_matched", `the failed turn matched no provider rule; strike ${next.turns.consecutive} of ${MAX_ENGINE_FAILURES}`);
	const note = engineFailureNote(next.turns);
	effects.push({ log: note, transcript: note, event: { name: "engine_failed", detail: note } });
	// `failed`, not `stuck`: no human takeover fixes a CLI that refuses on every invocation. The bound is CONSECUTIVE, so a run that recovers is untouched.
	if (next.turns.consecutive >= MAX_ENGINE_FAILURES) {
		const detail = engineFailureDetail(next.turns, ctx.repo);
		effects.push({ transcript: `finish: engine_error — ${detail}` });
		return { carry: next, effects, ending: { kind: "result", outcome: "engine_error", detail } };
	}
	return { carry: next, effects, ending: null };
}
