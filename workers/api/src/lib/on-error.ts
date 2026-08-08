import type { Env } from "../types.js";
import { HttpError } from "./auth.js";
import { logError } from "./error-log.js";

/**
 * Transient infrastructure errors that are NOT bugs — a Durable Object being reset
 * mid-request because a new code version deployed, or a briefly-overloaded DO. These
 * are self-healing (the client just retries) and shouldn't pollute the error log or
 * be surfaced to the operator as a real 500. Matched on the platform's own messages.
 */
export function isTransientInfraError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err ?? "");
	return (
		/Durable Object reset because its code was updated/i.test(msg) ||
		/Durable Object is overloaded/i.test(msg) ||
		/The Durable Object's code has been updated/i.test(msg) ||
		/Network connection lost/i.test(msg)
	);
}

/**
 * The 4xx worth a durable row, at `warn` (#424).
 *
 * Not "all 4xx": on an SPA, 401 and 404 are constant background traffic and logging them would
 * flood the log harder than #423's cron did. These four are the ones that are evidence of
 * something — 402 says no API key is connected, 403 a permission wall, 409 a conflicting write,
 * 429 a user repeatedly hitting a limit. Before this, a user hammering a rate limit produced no
 * record anywhere, on either side.
 *
 * The 402 already visible in the log gets there because `chat` logs it explicitly at its own call
 * site; that is the shape this generalises.
 */
const DIAGNOSTIC_CLIENT_ERRORS = new Set([402, 403, 409, 429]);

/**
 * Persist an exception that reached the global handler so it's never lost to the
 * ephemeral worker console. Decides WHAT to log, and AT WHICH LEVEL:
 *  - transient infra (DO reset on deploy, overload) → `warn`, source `transient`. Not a bug and
 *    the 503 is the right answer, but it must be COUNTABLE: "how often does a deploy break a live
 *    request?" was unanswerable while these were dropped, and that is the question that was asked.
 *  - HttpError 402/403/409/429 → `warn`. Expected, but diagnostic.
 *  - other HttpError < 500 → skip; logging every 401/404 would flood the log.
 *  - HttpError >= 500 → a real server failure. Log message + where.
 *  - anything else    → a genuine unhandled bug. Log the full message + STACK.
 * `req.userId` attributes the failure to the signed-in user (when known) so it shows
 * up in THAT user's own /v1/errors view — not just the admin all-scope read.
 * Best-effort: never throws (logError swallows), so it can't break the error path.
 */
export async function logUnhandled(
	env: Env,
	err: unknown,
	req: { path: string; method: string; userId?: string | null },
): Promise<void> {
	if (isTransientInfraError(err)) {
		// A distinct SOURCE as well as a distinct level, so `?source=transient` counts deploy
		// disruption directly instead of requiring a message match against platform wording that
		// is not ours and can change.
		await logError(env, {
			source: "transient",
			level: "warn",
			status: 503,
			message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			userId: req.userId ?? null,
			context: { path: req.path, method: req.method },
		}).catch(() => undefined);
		return;
	}
	if (err instanceof HttpError) {
		if (err.status < 500 && !DIAGNOSTIC_CLIENT_ERRORS.has(err.status)) return;
		await logError(env, {
			source: "unhandled",
			level: err.status < 500 ? "warn" : "error",
			status: err.status,
			message: err.message,
			userId: req.userId ?? null,
			context: { path: req.path, method: req.method },
		}).catch(() => undefined);
		return;
	}
	const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	console.error("Unhandled error:", message, err instanceof Error ? err.stack : "");
	await logError(env, {
		source: "unhandled",
		status: 500,
		message,
		userId: req.userId ?? null,
		context: {
			path: req.path,
			method: req.method,
			stack: err instanceof Error ? String(err.stack || "").slice(0, 1800) : undefined,
		},
	}).catch(() => undefined);
}
