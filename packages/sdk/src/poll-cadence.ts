// Poll cadence — how often a status poll should actually fire (CODER-007, #83).
//
// #83 proposed replacing status polling with a pushed WebSocket channel. The
// valuable part of that ticket turned out to be its *cadence policy*, not its
// transport: the decision recorded on the issue defines three tiers —
//
//   Active   (a conversation or an agent is running) → fastest cadence
//   Passive  (UI visible, nothing running)           → much slower
//   Halted   (UI hidden, nothing running)            → suppressed entirely
//
// Those tiers are a property of *when an update is worth fetching*, not of how
// it arrives, so they apply to a poll exactly as well as to a push — and on a
// poll they cost no new socket, no new token type, and no new failure mode.
// That matters here specifically: the bugs this surface has actually shipped
// (#190 runner dot stuck online, #238 stale node, #241 unrecoverable offline)
// were all STUCK-STATE bugs. A poll self-heals from those; a dropped push does
// not. Slowing a self-healing loop is strictly safer than replacing it.
//
// Deliberately pure and React-free so the decision is unit-testable on its own;
// `useTieredPolling` in ./hooks.ts is the thin React binding.

/** Which cadence tier a poll is currently in. */
export type PollTier = "active" | "passive" | "halted";

/** The two facts that decide the tier. */
export interface PollSignals {
	/** The tab is backgrounded — `document.hidden`. */
	hidden: boolean;
	/**
	 * Work the user is waiting on is in flight right now (an engine is working,
	 * a loop is iterating, a build is queued). NOT "a session exists" — an idle
	 * session is precisely the case worth slowing down.
	 */
	busy: boolean;
}

/** Per-call-site cadence. `halted` is always 0 (suppressed) and is not configurable. */
export interface PollCadence {
	/** Interval while something is running. Usually the site's existing interval. */
	activeMs: number;
	/** Interval while the tab is visible but nothing is running. `0` suppresses. */
	passiveMs: number;
}

/**
 * Note `busy` wins over `hidden`: a backgrounded tab whose engine is mid-run
 * stays in `active`. That is the issue's own definition (Halted requires no
 * agent AND no conversation), and it is load-bearing here — the client-driven
 * Coder Loop and the post-delegation watcher advance off these polls, so
 * halting a busy tab would stall real work, not just a display.
 */
export function resolvePollTier(signals: PollSignals): PollTier {
	if (signals.busy) return "active";
	return signals.hidden ? "halted" : "passive";
}

/** Interval for the current tier. `0` means "do not poll at all". */
export function resolvePollMs(cadence: PollCadence, signals: PollSignals): number {
	const tier = resolvePollTier(signals);
	if (tier === "halted") return 0;
	const ms = tier === "active" ? cadence.activeMs : cadence.passiveMs;
	// A negative/NaN interval would become a runaway `setInterval(fn, 0)`.
	return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

const RANK: Record<PollTier, number> = { halted: 0, passive: 1, active: 2 };

/**
 * Should the caller fetch ONCE immediately, on top of the interval, because the
 * tier just got faster?
 *
 * This is what makes the halted tier safe. Suppressing a poll in a hidden tab
 * leaves the displayed value stale by an unbounded amount; refreshing the
 * instant the tab comes back means the user never SEES the stale value, so the
 * suppression is invisible. `null` (first mount) is false — call sites already
 * do their own initial load.
 */
export function shouldRefreshOnResume(previous: PollTier | null, next: PollTier): boolean {
	if (previous === null) return false;
	return RANK[next] > RANK[previous];
}
