/**
 * Resilient handling of transient AI provider stream stalls (#907).
 *
 * ── The problem
 *
 * A provider's streaming response can go silent mid-reply due to network hiccups, load spikes, or
 * transient infrastructure issues. The current 20s stall timeout is a reasonable threshold to detect
 * this, but terminating the entire coding run on first occurrence is too aggressive — a brief stall
 * is often recoverable with a retry, and the user's work to that point should be preserved.
 *
 * ── The solution
 *
 * Implement automatic bounded retry with exponential backoff for stall errors. If a reply begins
 * then goes silent, attempt up to 3 retries (4 total attempts) before surfacing the error. This
 * is cheap because the platform's journal replay mechanism (#442) makes retries free — completed
 * tool invocations are not repeated.
 *
 * ── Configuration and telemetry
 *
 * All timing is tunable but has conservative defaults. Telemetry records stall events
 * (attempt count, backoff delay, provider/model) without exposing prompts or secrets.
 */

/** Maximum number of retry attempts for a stalled stream. Total attempts = MAX + 1. */
export const STALL_MAX_RETRIES = 3;

/**
 * Backoff delays (ms) applied between retry attempts.
 * Index 0 = delay before retry 1, index 1 = delay before retry 2, etc.
 * Exponential backoff: 0s, 2s, 5s allows the provider time to recover.
 */
export const STALL_BACKOFF_MS = [0, 2_000, 5_000];

/**
 * Hard ceiling (ms) to spend retrying a single stalled stream.
 * Prevents unbounded retry loops even if backoff constants are misconfigured.
 * Sum of STALL_BACKOFF_MS + margin should stay well under this.
 */
export const STALL_RETRY_CEILING_MS = 15_000;

/**
 * Distinguishes a stream stall from other provider errors by matching the error message.
 * The stall deadline throws messages like:
 *   "The AI provider stopped sending mid-reply — 20s with no bytes received after the reply had begun."
 */
export function isProviderStallError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return (
		err.message.includes("stopped sending mid-reply") ||
		err.message.includes("The connection to the AI provider ended mid-reply")
	);
}

/**
 * Records a stall event for observability without exposing sensitive data.
 * Used by retry logic to track patterns across providers/models.
 */
export interface StallEvent {
	provider: string;
	model: string;
	attemptNumber: number;
	totalAttempts: number;
	backoffMs: number;
	/** Wall-clock duration of the stall (time without receiving bytes). */
	stallDurationMs: number;
}

/**
 * Empty logging implementation. In production, this would forward to the platform's
 * telemetry/observability system (e.g., write to error_log, metrics service, etc.).
 * Called for every retry attempt, and once more at terminal failure.
 */
export function recordStallEvent(_event: StallEvent): void {
	// Telemetry placeholder. Implement per platform's observability requirements.
}
