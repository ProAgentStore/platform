/**
 * ProAgentStore shared auth widget.
 * Include on any page to show sign-in state in the nav.
 *
 * Usage: <script src="/auth-widget.js" defer></script>
 *
 * Looks for a <nav> in <header> and appends user info or "Sign in" link.
 * Reads session token from localStorage ('pags:session').
 *
 * Also carries the public pages' error reporter (#1088) — the first block below.
 */
/**
 * Error delivery for the public pages (#1088). Every public page loads this file, so this is where their
 * browser failures reach the durable log (`client:public`, read through MCP list_errors). The same rules
 * as the SDK's outbox (`packages/sdk/src/error-outbox.ts`), kept small because these pages ship no bundle:
 *   - an event id, kept in localStorage (≤ 20) until the platform acknowledges it — 2xx removes it; 429,
 *     5xx and a network failure retry with backoff; 400/413/422 drop it; offline waits for `online`;
 *   - repeats of a waiting failure are counted into it; a delivered one throttles the next for 30 s;
 *   - anonymous unless the same session that saw the failure is still signed in (a fingerprint is
 *     stored, never the token);
 *   - only the store's OWN scripts: an error from a browser extension or a cross-origin script is not
 *     ours to report. Never a query string or form value — the page path only.
 */
(() => {
	const API = "https://api.proagentstore.online";
	const KEY = "pags:public-error-outbox";
	const MAX = 20;
	const BACKOFF = [2000, 10000, 30000, 120000, 300000];
	const sent = {};
	let box = [];
	let busy = false;
	try { box = JSON.parse(localStorage.getItem(KEY) || "[]").slice(0, MAX); } catch { box = []; }
	const save = () => { try { localStorage.setItem(KEY, JSON.stringify(box)); } catch { /* storage blocked */ } };
	const token = () => { try { return localStorage.getItem("pags:session"); } catch { return null; } };
	const fp = (t) => {
		if (!t) return "anon";
		let h = 2166136261;
		for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
		return `s${(h >>> 0).toString(36)}`;
	};
	const newId = () => (crypto?.randomUUID ? crypto.randomUUID() : `pub-${Date.now()}-${Math.random().toString(36).slice(2)}`);

	async function flush() {
		if (busy) return;
		busy = true;
		try {
			while (navigator.onLine !== false) {
				const now = Date.now();
				const ev = box.find((x) => x.nextAt <= now);
				if (!ev) break;
				const t = token();
				const authorized = ev.auth !== "anon" && fp(t) === ev.auth;
				let status = 0;
				try {
					const res = await fetch(`${API}/v1/errors/client`, {
						method: "POST",
						keepalive: true,
						headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${t}` } : {}) },
						body: JSON.stringify({ id: ev.id, source: ev.source, message: ev.message, context: ev.context, count: ev.count, build: "public" }),
					});
					status = res.status;
				} catch { /* network: retried */ }
				if (status >= 200 && status < 300) {
					box = box.filter((x) => x !== ev);
					sent[`${ev.source}|${ev.message}`] = Date.now();
				} else if ([400, 413, 422].includes(status) || ev.attempts >= BACKOFF.length) {
					box = box.filter((x) => x !== ev);
				} else {
					ev.nextAt = Date.now() + BACKOFF[ev.attempts++];
				}
				save();
			}
		} finally {
			busy = false;
			if (box.length) setTimeout(flush, Math.max(0, Math.min(...box.map((x) => x.nextAt)) - Date.now()));
		}
	}

	function report(source, message, context) {
		const key = `${source}|${message}`;
		const auth = fp(token());
		const waiting = box.find((x) => `${x.source}|${x.message}` === key && x.auth === auth);
		if (waiting) waiting.count++;
		else if (box.length < MAX) box.push({ id: newId(), source, message: String(message).slice(0, 2000), context, count: 1, auth, attempts: 0, nextAt: Math.max(Date.now(), (sent[key] || 0) + 30000) });
		save();
		void flush();
	}
	window.__pagsReportError = report;

	const ours = (file) => {
		try { return !!file && new URL(file, location.href).origin === location.origin; } catch { return false; }
	};
	window.addEventListener("error", (e) => {
		if (!ours(e.filename)) return;
		const err = e.error;
		report("public", err instanceof Error ? `${err.name}: ${err.message}` : String(e.message || "error"), {
			page: location.pathname,
			file: new URL(e.filename, location.href).pathname,
			line: e.lineno,
			stack: err instanceof Error ? String(err.stack || "").slice(0, 600) : undefined,
		});
	});
	window.addEventListener("unhandledrejection", (e) => {
		const r = e.reason;
		if (!(r instanceof Error) || r.name === "AbortError") return;
		// A fetch that failed because the browser is offline is expected; any other rejection is reported.
		if (navigator.onLine === false && r.name === "TypeError" && /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/.test(r.message)) return;
		if (!String(r.stack || "").includes(location.origin)) return; // not one of our scripts
		report("public", `${r.name}: ${r.message}`, { page: location.pathname, stack: String(r.stack || "").slice(0, 600) });
	});
	window.addEventListener("online", () => void flush());
	void flush();
})();

(() => {
	const API = "https://api.proagentstore.online";
	const SESSION_KEY = "pags:session";
	const token = localStorage.getItem(SESSION_KEY);

	const nav = document.querySelector("header nav");
	if (!nav) return;

	function isEmail(value) {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
	}

	function accountLabel(user) {
		const label = user?.name || user?.login || "Account";
		return isEmail(label) ? "Account" : String(label).replace(/^@/, "");
	}

	// Create container for auth UI
	const authEl = document.createElement("span");
	authEl.style.cssText =
		"display:inline-flex;align-items:center;gap:0.5rem;margin-left:0.25rem;min-width:0";

	if (!token) {
		// Not signed in — show sign-in link
		const link = document.createElement("a");
		link.href = "/console/";
		link.textContent = "Sign in";
		link.style.cssText =
			"color:#a3a3a3;text-decoration:none;font-size:0.88rem;font-weight:600";
		link.onmouseenter = () => (link.style.color = "#fafafa");
		link.onmouseleave = () => (link.style.color = "#a3a3a3");
		authEl.appendChild(link);
		nav.appendChild(authEl);
		return;
	}

	// Have token — verify and show user
	fetch(`${API}/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
		.then((r) => {
			// A refused /me is a handled failure the log should know about (#1088); a 401 is just a stale session.
			if (!r.ok && r.status !== 401) window.__pagsReportError?.("public", `GET /v1/auth/me → ${r.status}`, { page: location.pathname, status: r.status });
			return r.ok ? r.json() : null;
		})
		.then((user) => {
			if (!user?.login) {
				// Invalid token — clear and show sign-in
				localStorage.removeItem(SESSION_KEY);
				const link = document.createElement("a");
				link.href = "/console/";
				link.textContent = "Sign in";
				link.style.cssText =
					"color:#a3a3a3;text-decoration:none;font-size:0.88rem;font-weight:600";
				authEl.appendChild(link);
				nav.appendChild(authEl);
				return;
			}

			// Valid — show avatar + link to console profile
			const wrapper = document.createElement("a");
			wrapper.href = "/console/";
			wrapper.setAttribute("aria-label", "Open console account");
			wrapper.style.cssText =
				"display:inline-flex;align-items:center;gap:0.4rem;text-decoration:none;border:1px solid #262626;border-radius:999px;padding:0.18rem 0.5rem 0.18rem 0.18rem;max-width:150px";

			const avatar = document.createElement("img");
			avatar.src = user.avatar || "";
			avatar.alt = "";
			avatar.style.cssText =
				"width:24px;height:24px;border-radius:50%;border:1px solid #404040;object-fit:cover;background:#171717";

			const name = document.createElement("span");
			name.textContent = accountLabel(user);
			name.style.cssText = "font-size:0.8rem;color:#a3a3a3;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

			wrapper.appendChild(avatar);
			wrapper.appendChild(name);
			authEl.appendChild(wrapper);
			nav.appendChild(authEl);
		})
		.catch(() => {
			// Network error — show nothing (fail silently)
		});
})();
