/**
 * Did the employer's site confirm the submission? (#994)
 *
 * ── The live failure this module exists for
 *
 * Three distinct approved auto-submit runs on `au.seek.com` reached `submit.attempted` and all
 * three ended terminal `blocked / submit_unconfirmed` with `submittedAt=null`: applications
 * `435d31c8…` (run `a4bf5c0f…`), `71765edd…` (run `76416747…`) and `b6244557…` (run `2f2e88a5…`).
 * The honest safety state was right — nothing was retried, and the owner was told to check the
 * employer's site — but a 3/3 rate says the DETECTOR was wrong, not the sites.
 *
 * Three facts about the old detector, each read off the code rather than guessed at:
 *
 *  1. **The vocabulary had no "sent".** It matched `thank you for (your) appl`,
 *     `application (has been|was) (received|submitted)`, `we('ve| have) received your application`
 *     and `successfully (applied|submitted)` — and nothing else. SEEK's own post-apply wording is
 *     the "sent" family ("Application sent", "Your application has been sent", "You've applied"),
 *     so the one word the page actually uses was the one word the regex could not see.
 *  2. **It looked once, 2 seconds after the click** (`browser_wait_for {time: 2}` then one
 *     `inspect()`), so a success state that arrives on a navigation or a client-side re-render a
 *     moment later was simply not there yet when the only look happened.
 *  3. **Text was the only evidence considered.** The URL the click navigates to, the title, and
 *     the site's own "you have already applied" notice were all collected by `INSPECT_PAGE` and
 *     none of them counted.
 *
 * What remains UNVERIFIED, and is stated here rather than implied: no live SEEK page was captured
 * while writing this, so which of the three was decisive for those three runs is not established.
 * The tests below use realistic fixtures of the wording SEEK and the big ATSs publish, which the
 * issue explicitly allows; a live capture would still be worth taking.
 *
 * ── What counts as confirmation
 *
 * A named marker, never a feeling. Every marker is an id this platform defines, and only the ID
 * crosses the contract — never the text that matched it. That is the same rule `signalsOf` follows
 * in `runtime.ts` for engine output, and for the same reason: an application page holds the
 * owner's typed answers, and no redaction reliably separates those from the rest of the prose.
 *
 * The URL and duplicate markers are deliberately comparative — they need the page as it was BEFORE
 * the click, which the submit path already has. A `/success` URL that was already there is not
 * evidence of this click; "you have already applied" that was already there is somebody's earlier
 * application, not this one.
 */

import type { LocalApplyConfirmationMarker } from "./contract.js";

/** What `INSPECT_PAGE` reports, as this module needs to read it. */
export interface ConfirmationPage {
	url: string;
	title: string;
	/** Did the page's own text match the success vocabulary? Evaluated in the page. */
	confirmed: boolean;
	/** Did the page say an application already exists? Evaluated in the page. */
	duplicate: boolean;
}

/**
 * The success vocabulary, as ONE source used in two places: this module (tested in Node) and the
 * in-page script (built from `.source`, executed in the browser). Two copies of a regex is how the
 * "sent" family went missing from one of them for three live runs.
 *
 * Lower-cased text is matched, so the patterns carry no case class.
 */
export const CONFIRMATION_TEXT_RE =
	/thank you for (your )?appl|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (applied|submitted|sent)|your application (is|has been) (on its way|complete)|you(r application)?('ve| have)? (now )?applied|applied (on|to this job)|application (sent|complete|submitted) *[.!]?$/;

/**
 * A URL that is itself the receipt. Matched against the path and query of the page the click
 * landed on, and only when the click CHANGED it.
 *
 * Kept narrow on purpose: `/apply` alone is the form, not the confirmation, and treating it as one
 * would turn "the click did nothing" into "submitted".
 */
export const CONFIRMATION_URL_RE = /(^|\/)(apply|application|applications|job)?[^/]*\/(success|succeeded|complete|completed|confirmation|confirmed|submitted|sent|thank-?you|receipt)(\/|$|\?)|[?&](applied|submitted|success)=(1|true|yes)/;

/** Ordered by how strong the evidence is: the first match is the one recorded. */
export function confirmationMarker(before: ConfirmationPage | null, after: ConfirmationPage | null): LocalApplyConfirmationMarker | null {
	if (!after) return null;
	if (after.confirmed) return "page_text";
	const url = urlPathAndQuery(after.url).toLowerCase();
	if (CONFIRMATION_URL_RE.test(url) && before && urlPathAndQuery(before.url).toLowerCase() !== url) return "url_receipt";
	// The site's own duplicate notice, but ONLY if it appeared after this click: "you have already
	// applied" that was on the page beforehand is an earlier application of the owner's, and
	// reading it as this run's success would record a submission that never happened.
	if (after.duplicate && before && !before.duplicate) return "already_applied_notice";
	return null;
}

/** Path + query only: a host or a fragment is not evidence, and the host is recorded separately. */
function urlPathAndQuery(raw: string): string {
	try {
		const u = new URL(raw);
		return `${u.pathname}${u.search}`;
	} catch {
		return raw;
	}
}

/**
 * How long to keep looking, and how often.
 *
 * The old path waited 2s once. These are bounded for the reason every wait in this runner is: an
 * application run holds the owner's only browser, so "look again" must not become "sit here". Six
 * looks over ~9s covers a navigation and a client-side re-render, and stops long before the
 * engine's own minute budget notices.
 */
export const CONFIRMATION_LOOKS = 6;
export const CONFIRMATION_INTERVAL_SECONDS = 1.5;

/** What the run OBSERVED about the submit, as ids — the diagnostic an owner can act on (#994). */
export interface ConfirmationObservation {
	marker: LocalApplyConfirmationMarker | null;
	/** How many times the page was read after the click. */
	looks: number;
	/** Did the click change the URL at all? "No" is the finding when nothing was confirmed. */
	urlChanged: boolean;
	titleChanged: boolean;
	/** The page could not be read after the click — a different failure from "read, not confirmed". */
	unreadable: boolean;
}

export function observe(before: ConfirmationPage | null, after: ConfirmationPage | null, looks: number): ConfirmationObservation {
	return {
		marker: confirmationMarker(before, after),
		looks,
		urlChanged: !!after && !!before && after.url !== before.url,
		titleChanged: !!after && !!before && after.title !== before.title,
		unreadable: !after,
	};
}

/**
 * The closed-vocabulary signals that go on the run's diagnostic when a submit was pressed and not
 * confirmed, so the owner's record says what was seen rather than only what was not.
 *
 * Each is an id, so nothing here can carry page text; together they distinguish the three cases a
 * person would act on differently: the page never changed (the click may not have landed), the page
 * moved but said nothing this detector knows (a wording to add), and the page could not be read.
 */
export function confirmationSignals(o: ConfirmationObservation): string[] {
	const out: string[] = [];
	if (o.unreadable) out.push("confirmation_page_unreadable");
	else if (!o.marker) out.push("confirmation_no_marker");
	if (o.urlChanged) out.push("confirmation_url_changed");
	else if (!o.unreadable) out.push("confirmation_url_unchanged");
	if (o.titleChanged) out.push("confirmation_title_changed");
	return out;
}
