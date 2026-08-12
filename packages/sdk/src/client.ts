// @proagentstore/sdk/client — browser-side authenticated client for the platform API.
//
// The "system service" every agent UI (and the console shell) uses to talk to
// api.proagentstore.online with the signed Bearer session. Kept in its own subpath
// so browser UIs don't pull in the backend `.` export (initPro/Stripe/etc).
// See ../../PLAN-agent-os.md. (Base-URL override can come later if a UI needs it.)

const API = "https://api.proagentstore.online";
const SESSION_KEY = "pags:session";

export function getToken(): string | null {
	return localStorage.getItem(SESSION_KEY);
}

/**
 * True when an error message is transient CONNECTIVITY (offline / flaky wifi / aborted
 * navigation / CORS preflight), not a platform bug. Safari says "Load failed", Chrome
 * "Failed to fetch", Firefox "NetworkError". These fire once per in-flight request on
 * every network blip, so reporting them floods the durable log and buries real errors —
 * suppress at every reporting boundary (api() below AND the global handlers in main.tsx)
 * from this ONE definition so the two can't drift.
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
 * Best-effort client-error reporter → the durable server error log, so browser
 * failures (voice errors, unhandled exceptions, failed calls) are visible via
 * GET /v1/errors and MCP list_errors — not just the user's DevTools console.
 * Deduped (a broken UI can't spam the log) and fire-and-forget via a DIRECT fetch
 * (never api(), which would recurse if api() itself is what failed).
 */
const _reportedAt = new Map<string, number>();
export function reportClientError(source: string, message: string, context?: Record<string, unknown>, status?: number): void {
	try {
		// NO token is not a reason to stay silent (#424). This used to `return` here, on the
		// premise that "the log is per-user; nothing to attribute it to" — but the server has
		// always written null-user rows (migration 0034: `user_id TEXT, -- nullable: some failures
		// have no user context`), and the effect of the early return was that every sign-in and
		// OAuth-callback failure was invisible. That is exactly the class a user cannot report
		// from their side, because they never got a session to read their own errors with.
		const token = getToken();
		const key = `${source}|${message}`.slice(0, 200);
		const now = Date.now();
		const last = _reportedAt.get(key);
		if (last && now - last < 30_000) return; // same error at most once / 30s
		_reportedAt.set(key, now);
		if (_reportedAt.size > 200) _reportedAt.clear();
		void fetch(`${API}/v1/errors/client`, {
			method: "POST",
			keepalive: true,
			headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			// `build` is top-level, not folded into `context`: it is part of the row's collapse
			// identity server-side (#539), and a build id living only in `context` is exactly what
			// a fold discards. It also has to be readable in `list_errors` without decoding JSON.
			body: JSON.stringify({ source: String(source).slice(0, 40), message: String(message).slice(0, 2000), status, context, build: _build }),
		}).catch(() => {});
	} catch { /* reporting must never throw */ }
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
		const msg = e instanceof Error ? e.message : String(e);
		if (!isConnectivityError(msg) && !path.startsWith("/v1/errors")) {
			reportClientError("api", `${opts.method || "GET"} ${path} → network error`, { error: msg });
		}
		throw e;
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
		throw new Error((data as Record<string, string>)?.error || `HTTP ${res.status}`);
	}
	return data as T;
}

export { API };
