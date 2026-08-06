/**
 * The one message the service worker sends the page (#176).
 *
 * `sw.js` already suppresses an OS notification while a console tab is visible — the user is
 * looking at the app, so a system banner for something the app can show itself is redundant
 * and disruptive. What it did NOT do is tell the app, so a suppressed push simply vanished
 * and the bell badge only noticed on its next 30s poll. Now the SW hands the payload to the
 * visible tab instead of dropping it, and the tab refreshes its badge immediately.
 *
 * That completes the trade rather than just making it cheaper: push covers "not looking",
 * this covers "looking", and neither one fires twice. It is also what lets the badge poll
 * halt in a hidden tab (#272) without a gap — hidden is exactly when the push DOES fire.
 *
 * Pure and dependency-free so the shape can be unit-tested. The SW is a plain static file
 * served straight from `store/sw.js` and cannot import from the bundle, so the string is
 * duplicated there — keep the two in step.
 */

/** `event.data.type` on the message the service worker posts to visible clients. */
export const PUSH_SUPPRESSED_MESSAGE = "pags:push-suppressed";

/** The push payload, forwarded verbatim from the SW. Every field is best-effort. */
export interface SuppressedPush {
	type: typeof PUSH_SUPPRESSED_MESSAGE;
	title?: string;
	body?: string;
	url?: string;
	tag?: string;
}

/**
 * Is this a suppressed-push message from our own service worker?
 *
 * Deliberately strict about the envelope and indifferent to the contents: `message` events
 * on a page are a shared channel (extensions, other SW versions, anything that got a
 * MessagePort), so acting on one means recognising it exactly. It only ever triggers a
 * re-read of the user's own notifications, so a false negative costs 30s of staleness and a
 * false positive would cost one wasted GET — but "it looked close enough" is how a shared
 * channel becomes a bug you cannot reproduce.
 */
export function isSuppressedPush(data: unknown): data is SuppressedPush {
	return !!data && typeof data === "object" && (data as { type?: unknown }).type === PUSH_SUPPRESSED_MESSAGE;
}
