/**
 * #994's confirmation contract: a submit is successful only on evidence the runner observed
 * after the click. These examples model SEEK's published receipt wording without retaining a
 * real application's page text anywhere outside the browser.
 */
import { describe, expect, it } from "vitest";
import { CONFIRMATION_TEXT_RE, confirmationMarker, confirmationSignals, observe } from "./confirmation.js";

const BEFORE = { url: "https://au.seek.com/job/94991284/apply", title: "Apply", confirmed: false, duplicate: false };

describe("SEEK submit confirmation (#994)", () => {
	it.each(["Application sent", "Your application has been sent", "You've applied"])('recognises the SEEK receipt wording %j', (text) => {
		expect(CONFIRMATION_TEXT_RE.test(text.toLowerCase())).toBe(true);
		expect(confirmationMarker(BEFORE, { ...BEFORE, confirmed: true })).toBe("page_text");
	});

	it("accepts a receipt URL only after the submit moved there", () => {
		const receipt = { ...BEFORE, url: "https://au.seek.com/job/94991284/application/sent" };
		expect(confirmationMarker(BEFORE, receipt)).toBe("url_receipt");
		expect(confirmationMarker(receipt, receipt)).toBeNull();
		expect(confirmationMarker(null, receipt)).toBeNull();
		// `/apply` is the form, rather than a receipt, even if the page moved there.
		expect(confirmationMarker({ ...BEFORE, url: "https://au.seek.com/job/94991284" }, BEFORE)).toBeNull();
	});

	it("treats a duplicate notice as confirmation only when it appeared after the click", () => {
		expect(confirmationMarker(BEFORE, { ...BEFORE, duplicate: true })).toBe("already_applied_notice");
		expect(confirmationMarker({ ...BEFORE, duplicate: true }, { ...BEFORE, duplicate: true })).toBeNull();
	});

	it("makes an unconfirmed outcome actionable without retaining page prose or URLs", () => {
		const observation = observe(BEFORE, { ...BEFORE, url: "https://au.seek.com/job/94991284/next", title: "Something unexpected" }, 6);
		expect(confirmationSignals(observation)).toEqual(["confirmation_no_marker", "confirmation_url_changed", "confirmation_title_changed"]);
		expect(JSON.stringify({ ...observation, signals: confirmationSignals(observation) })).not.toContain("Something unexpected");
		expect(JSON.stringify({ ...observation, signals: confirmationSignals(observation) })).not.toContain("94991284");
	});
});
