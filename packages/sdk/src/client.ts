// @proagentstore/sdk/client — browser-side authenticated client for the platform API.
//
// The "system service" every agent UI (and the console shell) uses to talk to
// api.proagentstore.online with the signed Bearer session. Kept in its own subpath
// so browser UIs don't pull in the backend `.` export (initPro/Stripe/etc).
// See ../../PLAN-agent-os.md. (Base-URL override can come later if a UI needs it.)

import { ErrorOutbox } from "./error-outbox.js";
const API = "https://api.proagentstore.online";
const SESSION_KEY = "pags:session";

export function getToken(): string | null {
	return localStorage.getItem(SESSION_KEY);
}

/**
 * True when an error message is transient CONNECTIVITY (offline / flaky wifi / aborted
 * navigation / CORS preflight), not a platform bug. Safari says "Load failed", Chrome
 * "Failed to fetch", Firefox "NetworkError". These fire once per in-flight request on
 * every network blip, so reporting them floods the durable log and buries real errors.
 *
 * A WORD filter, and so too broad for a reporting boundary (#1088): it also matches real errors that
 * merely mention "timed out" or "cancelled". `api()` and the global handlers now use
 * {@link classifyClientFailure}; this stays for the voice paths, which classify error STRINGS.
 */
export function isConnectivityError(message: string): boolean {
	return /load failed|failed to fetch|networkerror|network connection was lost|network request failed|the request timed out|timed? ?out|cancelled|canceled|aborted/i.test(message);
}

export function setToken(t: string | null) {
	if (t) localStorage.setItem(SESSION_KEY, t);
	else localStorage.removeItem(SESSION_KEY);
}

/**
 * The build this bundle was made from, as reported on every client error row (#539).
 *
 * `unset` until an app declares itself — deliberately a WORD, not an empty string and not a
 * plausible-looking id. Three states, all honest and none mistakable for a commit sha:
 *
 *   • a short sha  — a bundle built by CI, i.e. something deployed
 *   • `dev`        — built on a developer's machine, where there is no sha to report
 *   • `unset`      — a bundle that never declared one (and NULL server-side means a bundle
 *                    predating this field entirely, which is itself the answer to "is this tab
 *                    running old JavaScript?")
 *
 * Declared by the app rather than inlined here on purpose: this module ships as compiled `dist`
 * and is consumed by whatever bundles it, so a build-time `define` reaching in would be a
 * different mechanism per consumer. `setClientBuild` is one mechanism, and it is testable.
 */
let _build = "unset";

/** Declare the build this bundle was made from. Call it once, at the app entry, before render. */
export function setClientBuild(id: string | null | undefined): void {
	const clean = typeof id === "string" ? id.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) : "";
	_build = clean || "unset";
}

/** The build id this bundle reports — see {@link setClientBuild}. */
export function clientBuild(): string {
	return _build;
}

/**
 * Report a browser-side failure into the durable server error log, so it is visible through
 * GET /v1/errors and MCP list_errors — not just the user's DevTools console.
 *
 * Delivered through a persisted outbox (#1088, `error-outbox.ts`): a stable event id, retried until the
 * platform acknowledges it, kept across offline periods and reloads, with repeats counted rather than
 * dropped. Sent with a DIRECT fetch — never `api()`, which would recurse if `api()` is what failed.
 * Signed out is not a reason to stay silent (#424): the report is filed anonymously.
 */
let _outbox: ErrorOutbox | null = null;
function outbox(): ErrorOutbox {
	if (_outbox) return _outbox;
	const browser = typeof window !== "undefined";
	_outbox = new ErrorOutbox({
		endpoint: `${API}/v1/errors/client`,
		fetch: (url, init) => fetch(url, init as RequestInit),
		storage: typeof localStorage !== "undefined" ? localStorage : null,
		now: () => Date.now(),
		online: () => typeof navigator === "undefined" || navigator.onLine !== false,
		token: () => {
			try { return getToken(); } catch { return null; }
		},
		schedule: (fn, ms) => { setTimeout(fn, ms); },
		newId: () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `ev-${Date.now()}-${Math.random().toString(36).slice(2)}`),
	});
	if (browser) {
		// Back online: say how many requests failed while offline (once), then send what waited.
		window.addEventListener("online", () => {
			const n = _offlineFailures;
			_offlineFailures = 0;
			if (n > 0) reportClientError("network", `${n} request(s) failed while the browser was offline`, { offlineFailures: n });
			void _outbox?.flush();
		});
		// What a previous page load could not deliver.
		void _outbox.flush();
	}
	return _outbox;
}

// Started with the page, not with its first report (#1088): what a previous load could not deliver is sent
// now, and the `online` listener is in place before anything fails offline. Reads storage and sends what is
// due; it never throws.
if (typeof window !== "undefined") {
	queueMicrotask(() => {
		try { outbox(); } catch { /* never block the app */ }
	});
}

export function reportClientError(source: string, message: string, context?: Record<string, unknown>, status?: number): void {
	try {
		outbox().report({ source: String(source).slice(0, 40), message: String(message).slice(0, 2000), status, context, build: _build });
	} catch { /* reporting must never throw */ }
}

/**
 * What a failure IS (#1088) — precise, not a guess from words in the message.
 *
 *  - `abort`   the caller cancelled it (`AbortError`): expected, never reported.
 *  - `offline` a fetch that failed at the transport while the browser says it is offline: expected,
 *              COUNTED, and the count is reported once it is back online — one row, not one per request.
 *  - `network` a fetch that failed at the transport while online — the exact `TypeError` each browser
 *              throws for it. Reported under `network`, which the server files as a warning.
 *  - `error`   everything else: a real failure.
 *
 * It replaces a word filter (`timed out|cancelled|aborted|…`) that also hid real errors whose message
 * merely contained one of those words.
 */
export type ClientFailureClass = "abort" | "offline" | "network" | "error";
const FETCH_NETWORK_FAILURE = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed|The network connection was lost\.?)$/;
export function classifyClientFailure(err: unknown, online: boolean = typeof navigator === "undefined" || navigator.onLine !== false): ClientFailureClass {
	const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
	if (name === "AbortError") return "abort";
	// Only a TRANSPORT failure is the network's: a bug thrown while the browser is offline is still a bug.
	if (name === "TypeError" && FETCH_NETWORK_FAILURE.test(message.trim())) return online ? "network" : "offline";
	return "error";
}

let _offlineFailures = 0;
const _reported = new WeakSet<object>();
/** True for an error `api()` already reported (or classified as expected) — so a global handler skips it. */
export function wasReported(err: unknown): boolean {
	return !!err && typeof err === "object" && _reported.has(err);
}
function markReported<E>(err: E): E {
	if (err && typeof err === "object") _reported.add(err as object);
	return err;
}

/**
 * The 4xx worth reporting from the browser (#424).
 *
 * Mirrors `DIAGNOSTIC_CLIENT_ERRORS` in the Worker's `on-error.ts`, and for the same reason: 401
 * and 404 are constant SPA background traffic and reporting them would bury the log, while these
 * four are evidence — 402 no API key connected, 403 a permission wall, 409 a conflicting write,
 * 429 a user repeatedly hitting a limit. The server files them at `warn`, so they are countable
 * without inflating the error count.
 */
const DIAGNOSTIC_STATUSES = new Set([402, 403, 409, 429]);

export async function api<T = Record<string, unknown>>(
	path: string,
	opts: RequestInit = {},
	noAuth = false,
): Promise<T> {
	const token = getToken();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...((opts.headers as Record<string, string>) || {}),
	};
	if (!noAuth && token) headers.Authorization = `Bearer ${token}`;
	let res: Response;
	try {
		// `credentials: "include"` is what lets the API set (and later receive) the OAuth
		// state-binding cookie — a browser discards Set-Cookie on an uncredentialed cross-origin
		// XHR. Auth itself is the Bearer header; no session cookie exists, so this changes
		// nothing else.
		res = await fetch(`${API}${path}`, { credentials: "include", ...opts, headers });
	} catch (e) {
		// A thrown fetch is almost always transient CONNECTIVITY (offline / flaky wifi /
		// CORS), not a platform bug — and on every blip it fires one report per in-flight
		// request, flooding the durable log and burying real errors. Skip the common
		// connectivity messages; still surface anything genuinely unusual.
		// Classified, not filtered by words (#1088): an abort is the caller's, offline is counted and
		// reported once the browser is back, a transport failure while online is a `network` warning.
		const kind = classifyClientFailure(e);
		if (!path.startsWith("/v1/errors")) {
			if (kind === "offline") _offlineFailures++;
			else if (kind !== "abort") reportClientError(kind === "network" ? "network" : "api", `${opts.method || "GET"} ${path} → network error`, { error: e instanceof Error ? e.message : String(e) });
		}
		throw markReported(e);
	}
	// Session expired/invalid mid-use: clear the dead token and signal the app so it
	// can re-show Login, instead of leaving every subsequent call to throw "HTTP 401"
	// and components to render error text or silently empty.
	if (res.status === 401 && !noAuth && token) {
		setToken(null);
		if (typeof window !== "undefined") window.dispatchEvent(new Event("pags:unauthorized"));
	}
	// Handle empty/non-JSON responses (e.g. 204 No Content, DELETE)
	const text = await res.text();
	let data: unknown;
	try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
	if (!res.ok) {
		// Server errors (5xx) are always worth capturing; ordinary 4xx (validation,
		// 404, 401) are expected and would just be noise. The four DIAGNOSTIC statuses are the
		// exception — they are the evidence that a user is hitting a wall, and before #424 a user
		// repeatedly rate-limited left no trace on either side of the wire.
		if ((res.status >= 500 || DIAGNOSTIC_STATUSES.has(res.status)) && !path.startsWith("/v1/errors")) {
			reportClientError("api", `${opts.method || "GET"} ${path} → ${res.status}`, { body: text.slice(0, 300) }, res.status);
		}
		throw markReported(new ApiError((data as Record<string, string>)?.error || `HTTP ${res.status}`, res.status, data));
	}
	return data as T;
}

/**
 * A refused request, with the WHOLE answer (#931).
 *
 * `api()` used to throw `new Error(body.error)`, so every structured field a refusal carried was
 * gone before any page could read it: the run holding a busy repo (`activeRun`, #886), a start
 * still provisioning, `needsReauth`, `duplicate_of`. The message is unchanged, so every existing
 * `catch (e) { … e.message … }` reads exactly as before; `status` and `body` are what is new.
 */
export class ApiError extends Error {
	constructor(message: string, readonly status: number, readonly body: unknown) {
		super(message);
		this.name = "ApiError";
	}
}

export { API };
