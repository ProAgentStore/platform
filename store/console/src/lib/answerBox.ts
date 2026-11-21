/**
 * The owner's free-text answer box (#1338): how tall it is, as pure numbers.
 *
 * It was one line (`<input>`): on a phone a legal name or a sentence of context scrolled sideways out of sight, so the owner could not see
 * or edit what they were sending. It is now a multi-line box that starts comfortably tall and grows with its content.
 */

/** Visible lines when empty — enough to read a short paragraph without scrolling. */
export const ANSWER_MIN_ROWS = 4;
/** The same floor in px (Tailwind `min-h-28` = 7rem), so the box is never shorter than this even before layout runs. */
export const ANSWER_MIN_PX = 112;
/** The most of the visible viewport the box may take before it scrolls inside itself: the rest stays for the question and the Send button. */
export const ANSWER_MAX_VIEWPORT_SHARE = 0.45;

/**
 * The height, in px, an auto-growing answer box should have: its content, never below {@link ANSWER_MIN_PX}, never above a share of the
 * VISIBLE viewport. `viewportHeight` is `visualViewport.height` where there is one, so an open phone keyboard shrinks the cap and Send stays
 * reachable instead of ending up behind it.
 */
export function answerBoxHeight(contentHeight: number, viewportHeight: number): number {
	const content = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
	const viewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
	const cap = Math.max(ANSWER_MIN_PX, Math.round(viewport * ANSWER_MAX_VIEWPORT_SHARE));
	return Math.min(Math.max(content, ANSWER_MIN_PX), cap);
}
