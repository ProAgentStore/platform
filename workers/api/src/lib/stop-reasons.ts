/**
 * Why a run ended — the ONE table every reader derives from (#1354).
 *
 * The reasons used to be enumerated in about fourteen places (the union, `statusFor`'s chain, `needsHuman`, the
 * resumable list, the console's continue list and three label maps, SQL lists, MCP prose), and the copies drifted:
 * the console had no words for `engine_auth`/`engine_error`, and the coder app printed "Loop stopped (runner_gone)".
 * Each fact now lives once, in the row of the reason it is about.
 *
 * A LEAF that imports nothing, on purpose: the console and the coder web app import it directly, as they already
 * import `brain-models.ts`, so their labels cannot fall behind the worker's vocabulary.
 *
 * Per row:
 *   - `status`     — the board column (`statusFor`); the run row, the delegation card and the coding session card all
 *                    read it, so they cannot disagree about one run (#553).
 *   - `resumable`  — the run ended WITHOUT a verdict on its objective, so a successor is told what already landed
 *                    (#523, #806) and Continue is offered.
 *   - `notifies`   — the ending tells the owner rather than closing quietly (`needsHuman`).
 *   - `providerAccount` — the owner's own AI provider account stopped it (credit or key), so auto-pickup does not count
 *                    it against the issue and the platform continues it once the key works (#1314, #1318, #1326).
 *   - `label`      — the console's history row (`endingLabel`).
 *   - `outcomeWord`— the instance card's "Last run: …" line.
 *   - `endLabel`   — the coder app's end-of-loop notice.
 */

/** The terminal status a run record carries — deliberately the exact set a board card may hold at rest. */
export type LoopRunStatus = "completed" | "failed" | "needs_human" | "cancelled";

export interface StopReasonFacts {
	status: LoopRunStatus;
	resumable: boolean;
	notifies: boolean;
	providerAccount: boolean;
	label: string;
	outcomeWord: string;
	endLabel: string;
}

export const STOP_REASONS = {
	// The objective was met.
	done: { status: "completed", resumable: false, notifies: false, providerAccount: false, label: "Finished", outcomeWord: "finished", endLabel: "Loop complete" },
	// The run is asking a human, answered through its own handoff rather than a successor.
	escalated: { status: "needs_human", resumable: false, notifies: true, providerAccount: false, label: "Needs you", outcomeWord: "asked a question", endLabel: "Loop needs you" },
	// The agent reported failure. It got to say what happened, and repeating its steps may be exactly right — not resumable.
	failed: { status: "failed", resumable: false, notifies: true, providerAccount: false, label: "Failed", outcomeWord: "failed", endLabel: "Loop failed" },
	// The Pilot used up its step budget mid-work (#806's own case).
	max_iterations: { status: "failed", resumable: true, notifies: false, providerAccount: false, label: "Hit the step limit", outcomeWord: "hit its step limit", endLabel: "Loop hit its step limit" },
	// The tree ran out of money or delegations (#184).
	budget: { status: "failed", resumable: false, notifies: true, providerAccount: false, label: "Hit its spend limit", outcomeWord: "hit its spend limit", endLabel: "Loop hit its spend limit" },
	// A human stopped it; a restart after that may well be the "start clean" #806 lists as an option in its own right.
	cancelled: { status: "cancelled", resumable: false, notifies: false, providerAccount: false, label: "You stopped it", outcomeWord: "was stopped", endLabel: "Loop stopped by you" },
	// Repeating itself — a loop that cannot terminate on its own.
	no_progress: { status: "failed", resumable: false, notifies: true, providerAccount: false, label: "Was repeating itself", outcomeWord: "stopped repeating itself", endLabel: "Loop stopped — it was repeating itself" },
	// The coding CLI's OWN usage window outlasted the run's wait (#541). Not `failed`: the run ran out of time it was
	// allowed to wait for somebody else's window, and the remedy is the owner's — wait, upgrade, or switch engine.
	engine_limit: { status: "needs_human", resumable: true, notifies: true, providerAccount: false, label: "Hit the coding CLI's usage limit", outcomeWord: "hit the CLI's usage limit", endLabel: "Loop stopped — the coding CLI hit its usage limit" },
	// The owner's AI provider account has no credit (#773): "failed" would invite a retry that costs nothing and fixes
	// nothing. Its own sentence says to start again after topping up, and that restart is the successor (#1318).
	provider_credit: { status: "needs_human", resumable: true, notifies: true, providerAccount: true, label: "Out of AI provider credit — continues by itself after you top up", outcomeWord: "had an empty Anthropic API key balance (it continues by itself once the key works again)", endLabel: "Loop stopped — the Anthropic API key has no balance" },
	// The provider refused the owner's key (401/403); the platform re-checks it and continues once it works (#1326).
	provider_credentials: { status: "needs_human", resumable: true, notifies: true, providerAccount: true, label: "AI provider refused the key — continues by itself once it works", outcomeWord: "had its AI provider key refused (it continues by itself once the key works again)", endLabel: "Loop paused — the AI provider refused the API key (it continues by itself once the key works)" },
	// The coding CLI is not signed in and nobody signed it in within the park (#881) — an owner act the re-auth relay
	// makes possible from any device; once signed in, the successor carries on.
	engine_auth: { status: "needs_human", resumable: true, notifies: true, providerAccount: false, label: "Coding CLI not signed in", outcomeWord: "was waiting for the coding CLI to be signed in", endLabel: "Loop stopped — the coding CLI needs you to sign in" },
	// The PLATFORM cut the invocation off and the objective never reported (#546) — two of the five occurrences had
	// already pushed, so "failed" would send the owner to re-run work that may be on the trunk.
	interrupted: { status: "needs_human", resumable: true, notifies: true, providerAccount: false, label: "Cut off by the platform", outcomeWord: "was cut off", endLabel: "Loop was cut off by the platform" },
	// The owner's constraints in force do not fit the engine's envelope whole: nothing more was sent (#1019).
	constraint_refused: { status: "needs_human", resumable: true, notifies: true, providerAccount: false, label: "Stopped: your rules are too long to send", outcomeWord: "was stopped: your constraints are too long to send whole", endLabel: "Loop stopped — your rules are too long to send whole" },
	// A runner restart or engine relaunch cut a turn off and it could not be resumed exactly once (#1053): the turn may
	// have half-run, so somebody has to look at the worktree.
	turn_lost: { status: "needs_human", resumable: true, notifies: true, providerAccount: false, label: "Lost a turn to a runner restart", outcomeWord: "lost an engine turn to a runner restart", endLabel: "Loop stopped — a runner restart cut off an engine turn" },
	// Parked on a question and nobody answered within the park's 30 days (#1076); the answer, once given, is on the question row.
	decision: { status: "needs_human", resumable: true, notifies: true, providerAccount: false, label: "Parked on your answer; the 30-day wait ran out", outcomeWord: "waited 30 days for your answer to its question", endLabel: "Loop stopped — it waited 30 days for your answer" },
	// The machine stayed away past the run's whole 24h park (#1160); continuable once it is back (#1188).
	runner_gone: { status: "needs_human", resumable: true, notifies: true, providerAccount: false, label: "Its machine was away for a day", outcomeWord: "waited a day for its machine, which did not come back", endLabel: "Loop stopped — its machine was away for a day" },
	// The coding CLI itself exited non-zero (a bad model, a crash): its own message carried, never a wait on a person (#1200).
	engine_error: { status: "failed", resumable: true, notifies: false, providerAccount: false, label: "The coding CLI crashed", outcomeWord: "stopped on a coding CLI error", endLabel: "Loop stopped — the coding CLI crashed" },
} as const satisfies Record<string, StopReasonFacts>;

/** Why a run ended. Every one of these is a DIFFERENT thing to tell a human. */
export type LoopStopReason = keyof typeof STOP_REASONS;

/** Every reason, in table order. */
export const LOOP_STOP_REASONS = Object.keys(STOP_REASONS) as LoopStopReason[];

/** The reasons whose row says `resumable: true`, as a type. */
export type ResumableStopReason = { [R in LoopStopReason]: (typeof STOP_REASONS)[R]["resumable"] extends true ? R : never }[LoopStopReason];

/** The stop reasons after which a successor is told what already landed, and Continue is offered. */
export const RESUMABLE_STOP_REASONS = LOOP_STOP_REASONS.filter((r) => STOP_REASONS[r].resumable) as readonly ResumableStopReason[];

/** The stops the owner's own AI provider account caused (credit or a refused key). */
export const PROVIDER_ACCOUNT_STOP_REASONS = LOOP_STOP_REASONS.filter((r) => STOP_REASONS[r].providerAccount);

/**
 * Reasons as a SQL `IN (…)` list. Safe to interpolate because the values are this table's own keys — literal
 * identifiers, never input — and typed so nothing else can be passed.
 */
export function stopReasonsSql(reasons: readonly LoopStopReason[]): string {
	return reasons.map((r) => `'${r}'`).join(", ");
}

/** The row for a reason, or undefined for one this build does not know (a stored value from a newer or older build). */
export function stopReasonFacts(reason: string | null | undefined): StopReasonFacts | undefined {
	return (STOP_REASONS as Record<string, StopReasonFacts | undefined>)[reason ?? ""];
}
