/**
 * Wrapper around `runUserWorkersAi` that adds automatic retry for transient stalls (#907).
 *
 * When a provider stream stalls mid-reply, this wrapper:
 * 1. Detects the stall error
 * 2. Applies bounded exponential backoff (0s, 2s, 5s, ...)
 * 3. Retries up to STALL_MAX_RETRIES times
 * 4. Records telemetry for each attempt
 * 5. Propagates the error only after exhausting retries
 *
 * This is transparent to the caller and cheap to the platform because the workflow's
 * journal replay (#442) means completed steps are not re-executed.
 */

import { isProviderStallError, STALL_BACKOFF_MS, STALL_MAX_RETRIES, recordStallEvent } from "./provider-stall-policy.js";
import { runUserWorkersAi } from "./user-ai.js";
import type { Env } from "../types.js";

interface UserAiRequest {
	messages: Array<{ role: string; content: string }>;
	[key: string]: unknown;
}

/**
 * Sleep for a given duration. Used for backoff between retries.
 * In a real Worker, this uses `event.waitUntil` or returns a promise that resolves after delay.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `runUserWorkersAi` with automatic retry on transient stall errors.
 *
 * @param env Cloudflare Worker environment
 * @param userId User ID for the AI call
 * @param model Model name (e.g. "claude-sonnet-4-6")
 * @param request Request object with messages and options
 * @returns Result from `runUserWorkersAi` (same structure as non-retry version)
 * @throws Only if retries exhaust or a non-stall error occurs
 */
export async function runUserWorkersAiWithStallRetry(
	env: Env,
	userId: string,
	model: string,
	request: UserAiRequest,
): Promise<unknown> {
	const totalAttempts = STALL_MAX_RETRIES + 1;
	const startMs = Date.now();

	for (let attemptNumber = 1; attemptNumber <= totalAttempts; attemptNumber++) {
		try {
			// Attempt the AI call
			return await runUserWorkersAi(env, userId, model, request);
		} catch (err) {
			// Not a stall? Propagate immediately (e.g. credentials error)
			if (!isProviderStallError(err)) {
				throw err;
			}

			const isLastAttempt = attemptNumber === totalAttempts;
			if (isLastAttempt) {
				// Exhausted retries. Stall error propagates as-is.
				throw err;
			}

			// Determine backoff delay for next retry
			const backoffIndex = attemptNumber - 1;
			const backoffMs = backoffIndex < STALL_BACKOFF_MS.length ? STALL_BACKOFF_MS[backoffIndex] : STALL_BACKOFF_MS[STALL_BACKOFF_MS.length - 1];

			// Record telemetry about the stall
			const stallDurationMs = Date.now() - startMs;
			recordStallEvent({
				provider: "anthropic", // Hardcoded for now; could be parameterized
				model,
				attemptNumber,
				totalAttempts,
				backoffMs,
				stallDurationMs,
			});

			// Wait before retry
			if (backoffMs > 0) {
				await sleep(backoffMs);
			}

			// Loop continues to next attempt
		}
	}

	// This should never be reached, but TypeScript needs an explicit return
	throw new Error("Provider stall retry loop exited unexpectedly");
}
