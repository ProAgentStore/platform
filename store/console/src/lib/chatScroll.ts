/**
 * When the transcript is allowed to move under you (#132, #335).
 *
 * The rule, in one line: **auto-scroll only while you are already at the bottom.** Scroll up
 * and the thread holds still; scroll back down (or press the jump-to-latest button, which is
 * the deliberate escape hatch) and it resumes following. Nothing else may move the viewport.
 *
 * #335 was the one call site that ignored this. `loadMessages` scrolled unconditionally with
 * the comment "after initial load", which was true when it was only a mount-time fetch — but
 * it is also the REFRESH path, and the loop watcher calls it every 3s while an autonomous run
 * is going (#158: the platform drives the loop, so this component's only job is to re-read the
 * transcript). Loop entries are precisely the messages that arrive while you are not the one
 * talking, which is precisely when you are scrolled up reading them. The 3s poll is correct —
 * `useTieredPolling` treats a running loop as busy on purpose (#272) — so the bug was never
 * the interval, it was that a read yanked the viewport.
 */

/**
 * How close to the bottom still counts as "at the bottom", in px.
 *
 * Sub-pixel layout, a growing last bubble and momentum scrolling all mean an exact
 * `scrollTop + clientHeight === scrollHeight` never holds, so some tolerance is required.
 * 40px is under half a line of chat text: you have to be *visually* at the bottom, not merely
 * near it, which is what keeps "almost at the bottom" from being snapped down (#335). It is
 * unaffected by the voice pill's reserved `pb-16` — padding counts inside `scrollHeight`, so
 * the distance-to-bottom arithmetic is the same whether or not the pill is showing.
 */
export const BOTTOM_EPSILON_PX = 40;

/** The three numbers any scroll container reports. Kept structural so this is testable. */
export interface ScrollGeometry {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}

/** Is the viewer pinned to the newest message? */
export function isPinnedToBottom(g: ScrollGeometry): boolean {
	return g.scrollHeight - g.scrollTop - g.clientHeight < BOTTOM_EPSILON_PX;
}

/**
 * May a completed transcript fetch scroll to the bottom?
 *
 * `initial` is passed explicitly by the caller rather than inferred (from an empty message
 * list, say) because the two cases are genuinely different intents and only the caller knows
 * which it has: opening a conversation must land on the newest message, refreshing one must
 * not move at all unless the reader was already there.
 *
 * It cannot be collapsed into `pinned` either. The page is reused across instances without
 * remounting (see the InstanceDetail header note), so `atBottom` survives the switch — open a
 * conversation while scrolled up in the previous one and, without the flag, you would land in
 * the middle of a thread you have never seen.
 */
export function shouldScrollAfterLoad({ initial, pinned }: { initial: boolean; pinned: boolean }): boolean {
	return initial || pinned;
}
