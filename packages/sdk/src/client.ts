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

export function setToken(t: string | null) {
	if (t) localStorage.setItem(SESSION_KEY, t);
	else localStorage.removeItem(SESSION_KEY);
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
		const token = getToken();
		if (!token) return; // the log is per-user; nothing to attribute it to
		const key = `${source}|${message}`.slice(0, 200);
		const now = Date.now();
		const last = _reportedAt.get(key);
		if (last && now - last < 30_000) return; // same error at most once / 30s
		_reportedAt.set(key, now);
		if (_reportedAt.size > 200) _reportedAt.clear();
		void fetch(`${API}/v1/errors/client`, {
			method: "POST",
			keepalive: true,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ source: String(source).slice(0, 40), message: String(message).slice(0, 2000), status, context }),
		}).catch(() => {});
	} catch { /* reporting must never throw */ }
}

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
		res = await fetch(`${API}${path}`, { ...opts, headers });
	} catch (e) {
		// A thrown fetch is almost always transient CONNECTIVITY (offline / flaky wifi /
		// CORS), not a platform bug — and on every blip it fires one report per in-flight
		// request, flooding the durable log and burying real errors. Skip the common
		// connectivity messages; still surface anything genuinely unusual.
		const msg = e instanceof Error ? e.message : String(e);
		const connectivity = /load failed|failed to fetch|networkerror|network connection was lost|the request timed out|timed? ?out|cancelled|canceled|aborted/i.test(msg);
		if (!connectivity && !path.startsWith("/v1/errors")) {
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
		// 404, 401) are expected and would just be noise.
		if (res.status >= 500 && !path.startsWith("/v1/errors")) {
			reportClientError("api", `${opts.method || "GET"} ${path} → ${res.status}`, { body: text.slice(0, 300) }, res.status);
		}
		throw new Error((data as Record<string, string>)?.error || `HTTP ${res.status}`);
	}
	return data as T;
}

export { API };
