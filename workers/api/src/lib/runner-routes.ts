/**
 * What the cloud knows about each runner route, in one table (#1358): how long to wait for it, and whether a failed attempt may
 * be sent again.
 *
 * "Which commands are safe to re-send" used to be decided far from the call sites: a hidden set in `runner-client.ts` that left out
 * `/health` and `/capabilities`, and a guard that re-ran ANY step after a reconnect, so safety rested on every caller remembering
 * to use `sendAct` with an `inputId`. Now the route says it, `callRunner` reads it, and the guard consults it.
 *
 * `retry`:
 *   safe       a repeat changes nothing — a read, or a write that is idempotent by its own key (a session start).
 *   reconciled a repeat is safe ONLY after the caller has asked the runner whether the first one landed — `/coding/act`, whose
 *              input ledger answers exactly that. A step that does so declares it (`guard(..., { reconciles: true })`).
 *   never      a repeat may do it twice (a commit, a file written, a keystroke, a browser click). Not re-sent after it was dispatched.
 *
 * An unlisted path is `never` with the relay's default timeout: new routes fail closed until someone classifies them.
 */
import { READ_TIMEOUT_MS, RELAY_DEFAULT_TIMEOUT_MS } from "./runner-timeouts.js";

export type RouteRetry = "safe" | "reconciled" | "never";

export interface RunnerRoute {
	/** How long the relay waits for the reply when the caller names no timeout of its own. */
	timeoutMs: number;
	retry: RouteRetry;
}

const read = (): RunnerRoute => ({ timeoutMs: READ_TIMEOUT_MS, retry: "safe" });
const readSlow = (): RunnerRoute => ({ timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "safe" });
const once = (): RunnerRoute => ({ timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "never" });

export const RUNNER_ROUTES: Readonly<Record<string, RunnerRoute>> = {
	// ── liveness and capability: a repeat asks the same question ──
	"/health": read(),
	"/capabilities": read(),
	"/tasks": readSlow(),

	// ── the Pilot's engine session ──
	// A capture is a read. Its usage/act records are drained only until the cursor protocol (`coding-capture.ts`) is negotiated;
	// once it is, a capture that timed out but ran loses nothing, so it is fully safe to repeat.
	"/coding/capture": read(),
	// Idempotent by session id: an existing session is reused and its start is a no-op, which is what a reconnect relies on.
	"/coding/start": { timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "safe" },
	// Ending an ended session is a no-op.
	"/coding/end": { timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "safe" },
	// The runner's input ledger answers "did that id land?" — the caller reconciles before it sends again (`sendAct`).
	"/coding/act": { timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "reconciled" },
	"/coding/event": once(),
	"/coding/takeover": { timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "safe" },
	"/coding/takeover-status": read(),

	// ── reads of the checkout and the machine ──
	"/coding/git": readSlow(),
	"/coding/git-remote": readSlow(),
	"/coding/git-identity": readSlow(),
	"/coding/sync": readSlow(), // fetches, never pulls
	"/coding/repo-check": readSlow(),
	"/coding/read-file": readSlow(),
	"/coding/search": readSlow(),
	"/coding/browse": readSlow(),
	"/coding/tree": readSlow(),
	"/coding/diagnostics": readSlow(),
	"/coding/resources": readSlow(),
	"/coding/sessions": readSlow(),
	"/coding/clone-status": read(),
	"/coding/engine-check": readSlow(),
	"/coding/engine-models": readSlow(),
	"/coding/github-credentials": readSlow(),
	"/coding/github-orgs": readSlow(),
	"/coding/github-repos": readSlow(),
	"/coding/github-search": readSlow(),
	"/coding/github-repo-detail": readSlow(),

	// ── writes to the checkout: a repeat may do it twice ──
	"/coding/git-write": once(),
	"/coding/checkout-clean": once(),
	"/coding/park-snapshot": once(),
	"/coding/park-restore": once(),
	"/coding/clone": once(),
	"/coding/clone-start": once(),
	"/coding/kill-tmux": once(),
	"/coding/close-sessions": once(),

	// ── terminals ──
	"/tmux/list": read(),
	"/tmux/capture": read(),
	"/tmux/session": once(),
	"/tmux/send": once(),
	"/tmux/run": once(),
	"/terminal/list": read(),
	"/terminal/capture": read(),
	"/terminal/session": once(),
	"/terminal/send": once(),
	"/terminal/run": once(),

	// ── secure input ──
	"/secure/read": readSlow(),
	"/secure/write": once(),
	"/secure/scrub": once(),
	"/secure/type": once(),
	// One sudo attempt (#1131): every dispatch can use up one of sudo's three tries, so a command that was sent is never sent again by itself.
	"/secure/sudo": once(),

	// ── the browser: every click, keystroke and completion is a side effect on a live page ──
	"/browser/snapshot": readSlow(),
	"/browser/handoff-status": read(),
	"/browser/act": once(),
	"/browser/event": once(),
	"/browser/handoff": once(),
	"/browser/resume": once(),
	"/browser/input": once(),
	"/browser/complete": once(),
};

/** Routes with a path parameter, matched by prefix and suffix (`/coding/takeover/:sessionId/end`). Idempotent flag writes. */
const PATTERNS: ReadonlyArray<{ re: RegExp; route: RunnerRoute }> = [
	{ re: /^\/coding\/takeover\/[^/]+\/(?:end|resolve)$/, route: { timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "safe" } },
];

const DEFAULT_ROUTE: RunnerRoute = { timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "never" };

/** The route a path belongs to, ignoring a query string. Unknown paths fail closed: the relay default timeout, never re-sent. */
export function routeFor(path: string): RunnerRoute {
	const bare = path.split("?")[0] ?? path;
	const exact = RUNNER_ROUTES[bare];
	if (exact) return exact;
	for (const p of PATTERNS) if (p.re.test(bare)) return p.route;
	return DEFAULT_ROUTE;
}

/** Whether a failed attempt on this route may be sent again with no further proof. */
export function isSafeToResend(path: string): boolean {
	return routeFor(path).retry === "safe";
}

/**
 * The quick reads whose timeout at the relay means a runner that is connected and not answering, to be waited out and re-sent
 * (#1341). It used to be a hand-kept set of two capture paths that left out `/health` and `/capabilities`; it is now every `safe`
 * route with the short read timeout. A slow safe read (a GitHub listing, a clone status) keeps the plain timeout error: waiting a
 * runner out because a 2-minute listing was slow would be a different decision.
 */
export const TIMED_OUT_READ_PATHS: ReadonlySet<string> = new Set(
	Object.entries(RUNNER_ROUTES)
		.filter(([, r]) => r.retry === "safe" && r.timeoutMs === READ_TIMEOUT_MS)
		.map(([p]) => p),
);
