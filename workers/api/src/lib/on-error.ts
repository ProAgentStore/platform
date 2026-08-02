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
 * Persist an exception that reached the global handler so it's never lost to the
 * ephemeral worker console. Decides WHAT to log:
 *  - transient infra (DO reset on deploy, overload) → skip; not a bug, self-heals.
 *  - HttpError < 500  → expected client error (validation/not-found/auth). Skip —
 *    logging every denial would flood the log.
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
	if (isTransientInfraError(err)) return;
	if (err instanceof HttpError) {
		if (err.status < 500) return;
		await logError(env, {
			source: "unhandled",
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
