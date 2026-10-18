/**
 * A running `pags up` keeps its own sign-in alive (#1157).
 *
 * A session lasts 30 days, and a machine that runs for longer simply stopped being signed in: on 18 Oct 2026 the
 * Dell's session had expired, and nothing had said so until `pags up --install-service` failed with "Session
 * expired". Now `runner connect` checks its token at start and every 6 hours; inside the last 7 days it swaps it for
 * a fresh one (`POST /v1/auth/session/refresh`), and if it cannot, it warns — in the `pags up` window
 * and, through the heartbeat's `sessionExpiresAt`, in list_runner_nodes — while there is still time to sign in.
 */
import { sessionExpiresAt } from "./commands/login-device.js";

/** Refresh once a session has less than this left. */
export const REFRESH_WITHIN_MS = 7 * 24 * 3600_000;
/** Warn when it has less than this left and a refresh has not worked. */
export const WARN_WITHIN_MS = 3 * 24 * 3600_000;
export const CHECK_EVERY_MS = 6 * 3600_000;

export type RefreshDecision = "fresh" | "refresh" | "expired" | "unreadable";

export function refreshDecision(expiresAt: number | null, now: number): RefreshDecision {
	if (expiresAt === null) return "unreadable";
	if (expiresAt <= now) return "expired";
	return expiresAt - now <= REFRESH_WITHIN_MS ? "refresh" : "fresh";
}

const hoursLeft = (ms: number) => (ms >= 48 * 3600_000 ? `${Math.round(ms / (24 * 3600_000))} days` : `${Math.max(1, Math.round(ms / 3600_000))} hours`);

export interface RefreshDeps {
	apiBase: string;
	/** The token this process is using right now. */
	token: () => string | null;
	/** A fresh token: use it from now on, and keep it for the next start. */
	onRefreshed: (token: string, previous: string) => void;
	log: (line: string) => void;
	warn: (line: string) => void;
	fetch?: typeof fetch;
	now?: () => number;
}

/** One check. Returns what it decided — and, for `refresh`, whether the swap worked. */
export async function checkSession(deps: RefreshDeps): Promise<{ decision: RefreshDecision; refreshed?: boolean }> {
	const now = (deps.now ?? Date.now)();
	const token = deps.token();
	if (!token) return { decision: "unreadable" };
	const expiresAt = sessionExpiresAt(token);
	const decision = refreshDecision(expiresAt, now);
	if (decision === "expired") {
		deps.warn("Session expired: this runner is signed out. Sign in again with `pags login` (`pags login --device` over SSH).");
		return { decision };
	}
	if (decision !== "refresh") return { decision };
	const left = (expiresAt as number) - now;
	try {
		const res = await (deps.fetch ?? fetch)(`${deps.apiBase}/v1/auth/session/refresh`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
		const body = (await res.json().catch(() => ({}))) as { session?: string; error?: string };
		if (!res.ok || !body.session) throw new Error(body.error || `HTTP ${res.status}`);
		deps.onRefreshed(body.session, token);
		const until = sessionExpiresAt(body.session);
		deps.log(`Session refreshed — signed in until ${until ? new Date(until).toISOString().slice(0, 10) : "the next 30 days"}.`);
		return { decision, refreshed: true };
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		if (left <= WARN_WITHIN_MS) deps.warn(`Session refresh failed (${why}): this runner signs out in ${hoursLeft(left)}. Sign in again with \`pags login\` (\`pags login --device\` over SSH).`);
		return { decision, refreshed: false };
	}
}

/** Check now and every {@link CHECK_EVERY_MS}, on an unref'd timer that never keeps the process alive. */
export function startSessionRefresh(deps: RefreshDeps, every: (fn: () => void, ms: number) => { unref?: () => void } = setInterval): void {
	const run = () => void checkSession(deps).catch(() => undefined);
	run();
	every(run, CHECK_EVERY_MS).unref?.();
}
