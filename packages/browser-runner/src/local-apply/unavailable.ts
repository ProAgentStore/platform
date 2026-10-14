/**
 * Does the page say the job listing is gone? (#1022)
 *
 * ── The live failure this module exists for
 *
 * Every Runner run for application `cc90cd13…` (runs `26d8f1c1…`, `28c8f18f…`, `9c87cd10…`, 2026-10-09
 * and 2026-10-13) opened SEEK's listing, read "This job is no longer advertised — Jobs remain on SEEK
 * for 30 days, unless the advertiser removes them sooner", and called `report_job_unavailable` — which
 * the runner refused every time ("could not verify an expired or unavailable listing notice"). So each
 * run ended `awaiting_review` with nothing to review, and a retry repeated it. The vocabulary knew
 * "expired", "closed", "been filled", "no longer available" and "no longer accepting applications" —
 * not "no longer advertised", SEEK's own word.
 *
 * It was also written TWICE — in the in-page probe (`bridge.ts` `INSPECT_PAGE`) and in the reconciliation
 * check (`runtime.ts`) — and the probe's copy was never tested on real text, because the bridge's tests
 * fake the probe's RESULT. That is the gap #994 closed for the confirmation wording; this closes it here:
 * one vocabulary, interpolated into the probe, tested against the wording the boards publish.
 *
 * A notice, never an inference: the page must SAY the listing is gone. A missing Apply button is not
 * this — that stays a review state.
 */

export type ListingUnavailableReason = "expired" | "unavailable";

const NOUN = "(?:job|position|posting|role|opportunity|listing|advert|job ad)";
const GONE = "(?:has )?(?:expired|closed|been filled|been removed|is no longer (?:available|advertised|listed|accepting applications)|no longer (?:available|advertised|listed))";
const GONE_FIRST = "(?:expired|closed|no longer available|no longer advertised|no longer listed|no longer accepting applications)";

/** Specific enough to stand alone: LinkedIn's closed-listing badge names no job noun near it. */
const ALONE = "no longer accepting applications";

/**
 * The notice, in either order ("this job is no longer advertised" / "no longer accepting applications
 * for this role"), within 120 characters, or a phrase that needs no noun. Case-insensitive; the in-page
 * probe compiles `.source` with "i".
 */
export const LISTING_UNAVAILABLE_RE = new RegExp(`${NOUN}.{0,120}${GONE}|${GONE_FIRST}.{0,120}${NOUN}|${ALONE}`, "i");

/** Which of the two reasons a notice is: "expired" when the page says so, otherwise "unavailable". */
export const LISTING_EXPIRED_RE = /expired/i;

/** The listing's own notice, read from page text — or null when the page says nothing of the kind. */
export function listingUnavailableReason(text: string): ListingUnavailableReason | null {
	if (!LISTING_UNAVAILABLE_RE.test(text)) return null;
	return LISTING_EXPIRED_RE.test(text) ? "expired" : "unavailable";
}
