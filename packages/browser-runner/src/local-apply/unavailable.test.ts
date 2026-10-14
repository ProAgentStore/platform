/**
 * The listing-gone vocabulary (#1022), tested on the wording job boards actually publish — and the
 * in-page probe that carries it EXECUTED on that wording, rather than faked, which is how SEEK's
 * "no longer advertised" stayed invisible through three live runs of application cc90cd13.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSPECT_PAGE } from "./bridge.js";
import { listingUnavailableReason } from "./unavailable.js";

/** SEEK's notice, verbatim from the live runs' summaries (26d8f1c1, 28c8f18f, 9c87cd10). */
const SEEK = "Head of IT Delivery\nOnline Education Services\nThis job is no longer advertised\nJobs remain on SEEK for 30 days, unless the advertiser removes them sooner.";

describe("listingUnavailableReason — the boards' own notices", () => {
	it.each([
		["SEEK (the live miss)", SEEK, "unavailable"],
		["Indeed", "This job has expired on Indeed\nFind similar jobs", "expired"],
		["LinkedIn", "Senior Engineer · Acme\nNo longer accepting applications", "unavailable"],
		["a generic ATS", "Sorry, this position has been filled.", "unavailable"],
		["a removed ad", "This job ad has been removed by the advertiser.", "unavailable"],
		["a closed posting", "This posting is closed and is no longer accepting applications.", "unavailable"],
		["expired, gone-word first", "Expired: this listing can no longer be applied for", "expired"],
	])("%s is recognised", (_label, text, reason) => {
		expect(listingUnavailableReason(text)).toBe(reason);
	});

	it.each([
		["a live posting with an Apply button", "Head of IT Delivery\nApply now\nQuick apply"],
		["a closing DATE on a live posting is not a notice", "Applications close 30 October. Apply now."],
		["an unrelated 'expired' (a session)", "Your session expired. Sign in to continue."],
		["an empty page", ""],
	])("%s is not", (_label, text) => {
		expect(listingUnavailableReason(text)).toBeNull();
	});
});

describe("the in-page probe, executed on SEEK's notice", () => {
	afterEach(() => vi.unstubAllGlobals());

	const probe = (bodyText: string) => {
		vi.stubGlobal("document", { body: { innerText: bodyText }, title: "Head of IT Delivery Job in Cremorne - SEEK", querySelector: () => null });
		vi.stubGlobal("location", { href: "https://au.seek.com/job/95031707" });
		const fn = new Function(`return (${INSPECT_PAGE});`)() as () => { unavailable: string | null };
		return fn();
	};

	it("reads SEEK's 'This job is no longer advertised' as unavailable — the check report_job_unavailable runs", () => {
		expect(probe(SEEK).unavailable).toBe("unavailable");
	});

	it("reads Indeed's expiry as expired, and a live page as nothing", () => {
		expect(probe("This job has expired on Indeed").unavailable).toBe("expired");
		expect(probe("Head of IT Delivery\nApply now").unavailable).toBeNull();
	});
});
