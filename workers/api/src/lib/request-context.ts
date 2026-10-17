/**
 * Which HTTP request a write is happening inside (#1135).
 *
 * An `error_log` row written while a request ran could not be joined to that request: the log
 * recorded instance and run, not which call failed, so an API crash and the MCP call that caused it
 * were two unconnected records. Every request now runs inside an id, and `logError` / `logEvent`
 * read it from here rather than having it threaded through every call site (#637's "Env plumbing
 * explosion" is the reason those writers take a narrow env in the first place).
 *
 * The id is the caller's `X-Request-Id` when it has an id's shape (the MCP Worker and the host send
 * one, so their own records carry the same value), else Cloudflare's `cf-ray`, else a fresh uuid. It
 * is a correlation label, not an identity: it authorizes nothing and scopes nothing, so a caller
 * that names its own id can only label its own request. Echoed on the response as `X-Request-Id`.
 *
 * A Durable Object, Workflow or cron runs outside any request and has no id; their rows say so with
 * NULL rather than borrowing one.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const REQUEST_ID_HEADER = "X-Request-Id";

const store = new AsyncLocalStorage<{ requestId: string }>();

/** An id as it may label a request: id-shaped and bounded, or nothing. */
export function requestIdOrNull(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const v = raw.trim();
	return v && v.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(v) ? v : null;
}

/** The id a request runs under: the caller's, else the edge's ray id, else a fresh one. */
export function requestIdFor(headers: Headers): string {
	return requestIdOrNull(headers.get(REQUEST_ID_HEADER)) ?? requestIdOrNull(headers.get("cf-ray")) ?? crypto.randomUUID();
}

export function withRequestId<T>(requestId: string, fn: () => T): T {
	return store.run({ requestId }, fn);
}

/** The id of the request this code is running inside, or null outside one. */
export function currentRequestId(): string | null {
	return store.getStore()?.requestId ?? null;
}
