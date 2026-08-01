import type { Env } from "../types.js";
import { HttpError } from "./auth.js";
import { logError } from "./error-log.js";

/**
 * Persist an exception that reached the global handler so it's never lost to the
 * ephemeral worker console. Decides WHAT to log:
 *  - HttpError < 500  → expected client error (validation/not-found/auth). Skip —
 *    logging every denial would flood the log.
 *  - HttpError >= 500 → a real server failure. Log message + where.
 *  - anything else    → a genuine unhandled bug. Log the full message + STACK.
 * Best-effort: never throws (logError swallows), so it can't break the error path.
 */
export async function logUnhandled(
	env: Env,
	err: unknown,
	req: { path: string; method: string },
): Promise<void> {
	if (err instanceof HttpError) {
		if (err.status < 500) return;
		await logError(env, {
			source: "unhandled",
			status: err.status,
			message: err.message,
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
		context: {
			path: req.path,
			method: req.method,
			stack: err instanceof Error ? String(err.stack || "").slice(0, 1800) : undefined,
		},
	}).catch(() => undefined);
}
