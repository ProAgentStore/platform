// Self-contained API + auth for the admin app. Reuses the SAME session token the
// console stores ("pags:session"), and the SAME OAuth handoff (?session=), so the
// admin app needs no @proagentstore/sdk dependency. Server-side, every /v1/admin/*
// route is behind requireAdmin — this is just the client.

const API = "https://api.proagentstore.online";
const SESSION_KEY = "pags:session";

export function getToken(): string | null {
	return localStorage.getItem(SESSION_KEY);
}
export function setToken(t: string | null) {
	if (t) localStorage.setItem(SESSION_KEY, t);
	else localStorage.removeItem(SESSION_KEY);
}

export class ApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
	const token = getToken();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...((opts.headers as Record<string, string>) || {}),
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${API}${path}`, { ...opts, headers });
	if (res.status === 401) {
		setToken(null);
		throw new ApiError(401, "Not signed in");
	}
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new ApiError(res.status, body.error || `HTTP ${res.status}`);
	}
	return res.json() as Promise<T>;
}

/** Begin ProAgentStore's own OAuth, returning to the current /admin URL. */
export async function signIn(provider: "google" | "github" = "github") {
	const config = (await (await fetch(`${API}/v1/auth/config`)).json()) as {
		google_oauth_url: string;
		oauth_url: string;
		app_id: string;
		response_mode: string;
	};
	const returnTo = encodeURIComponent(window.location.href);
	const url = provider === "google" ? config.google_oauth_url : config.oauth_url;
	window.location.href = `${url}?app_id=${config.app_id}&response_mode=${config.response_mode}&return_to=${returnTo}`;
}

/** If we came back from OAuth with ?session=, persist it and clean the URL. */
export function captureOAuthSession() {
	const params = new URLSearchParams(window.location.search);
	const session = params.get("session");
	if (session) {
		setToken(session);
		window.history.replaceState({}, "", window.location.pathname);
	}
}

// ── formatting ──
export function fmtUsd(micros: number): string {
	const usd = (Number(micros) || 0) / 1_000_000;
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return "<$0.01";
	return `$${usd.toFixed(2)}`;
}
export function fmtInt(n: number): string {
	return (Number(n) || 0).toLocaleString("en-US");
}
