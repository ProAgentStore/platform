import type { Env } from "../types.js";
import { HttpError } from "./auth.js";
import { clipMarked } from "./clip-marked.js";
import { type ErrorLevel, logError } from "./error-log.js";
import { redactText } from "./redact.js";

/**
 * Transient infrastructure errors that are NOT bugs — a Durable Object being reset
 * mid-request because a new code version deployed, a briefly-overloaded DO, or D1
 * queueing more requests than it can serve in a burst (#1256: a console answer-submit
 * hit this mid-burst, and — like the DO cases — was a bare "Internal server error" to
 * the client even though nothing was actually broken). These are self-healing (the
 * client just retries) and shouldn't pollute the error log or be surfaced to the
 * operator as a real 500. Matched on the platform's own messages.
 */
export function isTransientInfraError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err ?? "");
	return (
		/Durable Object reset because its code was updated/i.test(msg) ||
		/Durable Object is overloaded/i.test(msg) ||
		/The Durable Object's code has been updated/i.test(msg) ||
		/Network connection lost/i.test(msg) ||
		/D1_ERROR: D1 DB is overloaded/i.test(msg)
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

/**
 * The same policy for a failure a handler RETURNED rather than threw (#1086).
 *
 * `app.onError` only ever sees a throw. A route that answers `c.json(…, 502)` itself — an upstream
 * model failing, a runner that is not connected, the rate limiter's 429 — produced no row at all,
 * so the classification above covered half of the failures it was written for. This is that
 * classification, applied at the place the response is built:
 *
 *   - 401, 404 and every other non-diagnostic 4xx → nothing (constant background traffic);
 *   - 402 / 403 / 409 / 429 → `warn`;
 *   - 5xx → `error`, unless the caller declares the state EXPECTED (`level: "warn"`) — "the runner
 *     is not connected" is a 502 to the client and a fact about the owner's laptop, not a bug.
 *
 * Exactly one report per failure: a path calls this only where it RETURNS the failure. A thrown
 * error is `logUnhandled`'s, and a path that has already called `logError` itself must not call
 * this too. Nothing that serves `/v1/errors/*`, the telemetry spool or its drain reports through
 * here — a failing log must never report itself.
 *
 * The message is redacted (`redactText`) and clipped: an upstream body can carry a key, and ADR
 * 0004 keeps bodies out of the log. Never throws.
 */
export async function logDirectResponse(
	env: Pick<Env, "DB"> & Partial<Pick<Env, "OAUTH_KV" | "API_BUILD">>,
	r: { status: number; source: string; message: string; userId?: string | null; level?: ErrorLevel; context?: Record<string, unknown> },
): Promise<void> {
	if (r.status < 500 && !DIAGNOSTIC_CLIENT_ERRORS.has(r.status)) return;
	const level: ErrorLevel = r.level ?? (r.status < 500 ? "warn" : "error");
	await logError(env, {
		source: r.source,
		level,
		status: r.status,
		message: clipMarked(redactText(r.message), 500),
		userId: r.userId ?? null,
		context: r.context,
	}).catch(() => undefined);
}

/**
 * A 5xx a route RETURNED without recording it (#1134) — the backstop behind `logDirectResponse`.
 *
 * `logDirectResponse` is called at three sites; 22 more `c.json(…, 5xx)` returns, and every route
 * that passes an upstream status through, produced no row. Rather than a call at each of them (and at
 * each one added later), the request middleware hands every 5xx response here AFTER the route has
 * answered, and it is recorded only when nothing in the request wrote a row already
 * (`requestRecorded`): a route that logged its own failure, and a throw `app.onError` logged, stay
 * one row.
 *
 * Level by status, the policy `logDirectResponse` documents:
 *   - 500 and any other 5xx → `error`, a failure of this Worker;
 *   - 501 → `warn`: the feature is not configured on this deployment (an OAuth client, a webhook secret);
 *   - 502 / 503 / 504 → `warn`: a dependency did not answer — the owner's runner, GitHub, a provider.
 *     "The runner is not connected" is a 502 to the client and a fact about the owner's laptop, not a
 *     bug. A route whose 503 IS a fault of its own records it at `error` itself.
 *
 * The message is the response's own `error` text (or its plain-text body), which the caller already
 * received — redacted and clipped as `logDirectResponse` does (ADR 0004). Never throws.
 */
export async function logReturnedFailure(
	env: Pick<Env, "DB"> & Partial<Pick<Env, "OAUTH_KV" | "API_BUILD">>,
	r: { response: Response; path: string; method: string; userId?: string | null },
): Promise<void> {
	const status = r.response.status;
	if (status < 500) return;
	let message = `HTTP ${status}`;
	try {
		const type = r.response.headers.get("Content-Type") ?? "";
		if (type.includes("application/json")) {
			const body = (await r.response.clone().json()) as { error?: unknown };
			if (typeof body?.error === "string" && body.error.trim()) message = body.error;
		} else if (type.startsWith("text/plain")) {
			const text = (await r.response.clone().text()).trim();
			if (text) message = text;
		}
	} catch {
		// An unreadable body leaves the status as the message.
	}
	await logDirectResponse(env, {
		status,
		source: "route-5xx",
		level: status === 500 || status > 504 ? "error" : "warn",
		message,
		userId: r.userId ?? null,
		// The instance a `/v1/instances/:id/…` path names — kept by `logError` only when the caller owns it.
		context: { path: r.path, method: r.method, ...(instanceInPath(r.path) ? { instanceId: instanceInPath(r.path) } : {}) },
	});
}

function instanceInPath(path: string): string | undefined {
	const id = /^\/v1\/instances\/([^/]+)\//.exec(path)?.[1];
	return id && id !== "my" ? id : undefined;
}
