/**
 * One vocabulary for status chips.
 *
 * The console had two: BoardTab mapped statuses onto the app's own tokens as
 * `bg-<token>/15 text-<token>`, while DataTab shipped eleven raw Tailwind pairs —
 * a 100-level background under 700-level text, the standard *light mode* pairing,
 * on an app whose only palette is dark (`--color-paper: #0a0a0a`). So the same
 * idea wore two different greens, neither of them `--color-green`, and `dead` was
 * mid-grey on light-grey: a pairing designed to recede on a white page, which on
 * black neither recedes nor reads (#368).
 *
 * (Class names are described rather than spelled here on purpose — Tailwind v4
 * scans comments too, so quoting the broken utilities would resurrect them in the
 * built stylesheet.)
 *
 * The fix is to route a status through an *intent* first. The chip's colour then
 * follows from what the status means, not from whatever hue the author reached
 * for, and a later decision to (say) make warnings orange is one edit here rather
 * than a hunt through every table.
 *
 * The tint is an opacity modifier because this repo's `@theme` declares no `-soft`
 * background pairing for the status colours — #367's to fix properly; this uses
 * what exists, matching the `/15` BoardTab already established.
 */

export type StatusIntent = "success" | "danger" | "warning" | "info" | "neutral";

/** Tinted background + solid foreground, both from `index.css` `@theme` tokens. */
export const INTENT_CLASS: Record<StatusIntent, string> = {
	success: "bg-green/15 text-green",
	danger: "bg-red/15 text-red",
	warning: "bg-yellow/15 text-yellow",
	info: "bg-blue/15 text-blue",
	neutral: "bg-muted/15 text-muted",
};

/**
 * Status → intent. Deliberately a flat map over every status the console's
 * collections and pipeline runs actually emit; an unknown status is `neutral`
 * rather than a guess, because a chip that invents a colour for a status nobody
 * declared is worse than a grey one.
 */
const INTENT_BY_STATUS: Record<string, StatusIntent> = {
	// Lead pipeline (site-builder / lead-finder collections).
	new: "info",
	contacted: "warning",
	won: "success",
	dead: "neutral",
	// website_status — "none" means the business has no site, which is the
	// qualifying signal the lead agents are looking for, so it reads as success.
	none: "success",
	unreachable: "warning",
	// Pipeline runs (#98).
	queued: "warning",
	running: "info",
	completed: "success",
	failed: "danger",
	interrupted: "warning",
	// Board items.
	needs_approval: "warning",
	submitted: "success",
	offer: "success",
	accepted: "success",
	rejected: "neutral",
	cancelled: "neutral",
};

export function statusIntent(status: string): StatusIntent {
	return INTENT_BY_STATUS[String(status ?? "").trim().toLowerCase()] ?? "neutral";
}

export function statusBadgeClass(status: string): string {
	return INTENT_CLASS[statusIntent(status)];
}
