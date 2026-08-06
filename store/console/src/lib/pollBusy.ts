/**
 * "Is this surface worth polling at full rate right now?" — the per-call-site `busy`
 * input to `useTieredPolling` (#272, the console half of #83).
 *
 * The cadence policy itself (active / passive / halted, plus the catch-up fetch on any
 * speed-up) lives in `@proagentstore/sdk` `poll-cadence.ts` and is already tested there.
 * What could NOT be shared is the one fact each surface has to supply: whether anything
 * is happening. That answer is different for a board of runtime tasks, an append-only
 * activity log, a list of machines and a tmux pane — so it lives here, pure, and the
 * components stay dumb glue.
 *
 * Two rules carry over from #83 and are load-bearing in every predicate below:
 *
 *   1. **Busy beats hidden.** Work the user is waiting on keeps its full rate even in a
 *      backgrounded tab. Halting it would trade a real wait for a battery saving.
 *   2. **Believing something is OFFLINE counts as busy.** Offline is the state a change
 *      is imminent from — it is the one the user is actively fixing (`pags up`) — so
 *      slowing down there is how a stuck-offline state becomes unrecoverable (#241).
 *
 * Everything else — an idle board, a quiet log, machines that are all connected — is the
 * case worth slowing down, and it is the case ~all of the time.
 */

/**
 * Board statuses that advance WITHOUT the user. `needs_approval` / `needs_human` are
 * deliberately absent: those wait on a person, and a person acting on the board is a
 * person looking at the board (so the tab is visible, and the action reloads it anyway).
 */
const ADVANCING_BOARD_STATUSES = new Set(["queued", "running"]);

/** Is a runtime job in flight on the board? */
export function boardBusy(items: { status?: string }[] | null | undefined): boolean {
	if (!Array.isArray(items)) return false;
	return items.some((it) => ADVANCING_BOARD_STATUSES.has(String(it?.status ?? "")));
}

/**
 * How recently an activity event has to have landed for the agent to count as working.
 *
 * Comfortably longer than the gap between the events of one agent turn (tool call →
 * result → reply), so a normal turn never flickers the timeline down to the passive tier
 * mid-thought, and short enough that an agent that stopped an hour ago is not still
 * paying for a 4s poll.
 */
export const ACTIVITY_BUSY_WINDOW_MS = 60_000;

/**
 * Is the agent doing things right now? Answered from the log itself — the newest event's
 * age — because the activity log has no other liveness signal to read.
 *
 * Unparseable timestamps are ignored rather than treated as "now": a bad date must not
 * pin the surface to its fastest tier forever. The window is applied in BOTH directions so
 * that a little clock skew still reads as fresh while a wildly future stamp does not.
 */
export function activityBusy(
	events: { createdAt?: string }[] | null | undefined,
	now: number = Date.now(),
	windowMs: number = ACTIVITY_BUSY_WINDOW_MS,
): boolean {
	if (!Array.isArray(events)) return false;
	return events.some((e) => {
		const t = Date.parse(String(e?.createdAt ?? ""));
		return Number.isFinite(t) && Math.abs(now - t) < windowMs;
	});
}

/** The Terminals page's view of one machine. */
export interface TerminalNodeLike {
	connected?: boolean;
	sessions?: { status?: string }[];
}

/**
 * Terminals: busy while any machine is believed offline, while there are no machines at
 * all, or while a coding session is active.
 *
 * The empty list is included on purpose and is the same judgement as rule 2 above: a page
 * that says "No terminals connected" is being watched by someone who is about to run
 * `pags up`, and making them wait out the slow tier to see it land is the exact failure
 * #241 was. A fully-connected, idle set of machines is the opposite — a boolean that
 * changes about twice a day — and that is the state this slows down.
 */
export function terminalsBusy(nodes: TerminalNodeLike[] | null | undefined): boolean {
	if (!Array.isArray(nodes) || nodes.length === 0) return true;
	return nodes.some((n) => n?.connected !== true || (n?.sessions ?? []).some((s) => s?.status === "active"));
}

/**
 * Shells, so a pane sitting at a prompt does not read as a running command. The leading
 * `-` of a login shell (`-zsh`) is stripped before the lookup.
 */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "nu", "pwsh", "tmux"]);

/** Is a command actually running in this pane (as opposed to an idle prompt)? */
export function isRunningCommand(activeCommand?: string): boolean {
	const cmd = String(activeCommand ?? "").trim().replace(/^-/, "");
	if (!cmd) return false;
	return !SHELLS.has(cmd.split(/[\s/]/).filter(Boolean).pop() ?? cmd);
}

/**
 * Terminal (tmux/kitty/iTerm2) connector tab: busy while a pane is running a command, or
 * while the last refresh FAILED.
 *
 * The failure case is rule 2 again in its most literal form — the tool call only fails
 * because the runner could not be reached, and backing off then is how the tab stays
 * showing an error long after the machine came back.
 */
export function tmuxBusy(targets: { activeCommand?: string }[] | null | undefined, failing = false): boolean {
	if (failing) return true;
	if (!Array.isArray(targets)) return false;
	return targets.some((t) => isRunningCommand(t?.activeCommand));
}
