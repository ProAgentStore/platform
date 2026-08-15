import { describe, expect, it } from "vitest";
import { CARD_DETAIL_MAX, actHeadline, cardDetail, cutTo } from "./card-detail.js";

/**
 * The run this module is named for (#568) — card `deleg-ae7fa3f2` of instance `bd43f4de`.
 *
 * Fifteen `act.consequential` rows, every one `irreversible: true`: fourteen pushes to the trunk
 * and one recursive delete. Reconstructed from the trace rather than invented, because the whole
 * defect is about a real string's LENGTH and a fabricated one would measure nothing.
 */
const ACTS_15 = [
	...Array.from({ length: 14 }, () => ({ summary: "pushed directly to the trunk origin main", irreversible: true })),
	{ summary: "deleted files recursively", irreversible: true },
];

/** The note `runOutcomeNote` composed for that run — 691 characters as measured on the card. */
const NOTE_691 =
	"outcome: failed — run error: Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits" +
	" | Acts: " +
	Array.from({ length: 4 }, () => "pushed directly to the trunk origin main").join("; ") +
	"; and 11 more.";

describe("cutTo — a cut says so, inside its budget", () => {
	it("leaves anything that fits completely alone", () => {
		expect(cutTo("short", 300)).toBe("short");
		expect(cutTo("x".repeat(300), 300)).toBe("x".repeat(300));
	});

	it("marks the cut, and the marker is INSIDE the budget", () => {
		const out = cutTo("x".repeat(400), 300);
		expect(out.length).toBe(300);
		expect(out.endsWith("…")).toBe(true);
		// `tool-result-cap.ts` appends outside its budget; here several cuts compose into one
		// 300-character field, so an overrun per segment would put the composition over the cap.
		expect(out).not.toBe(`${"x".repeat(300)}…`);
	});

	it("degrades to the marker alone rather than overrunning a tiny budget", () => {
		expect(cutTo("abcdef", 1)).toBe("…");
		expect(cutTo("abcdef", 0)).toBe("");
	});
});

describe("actHeadline — the count is stated, never inferred (#568)", () => {
	it("names N and how many of the N are irreversible", () => {
		const head = actHeadline(ACTS_15);
		expect(head).not.toBeNull();
		// The acceptance criterion, literally: a reader can tell 15 from 2.
		expect(head).toMatch(/^15 acts, all irreversible:/);
	});

	it("collapses identical acts with a multiplier, irreversible first", () => {
		// The observed card spent 120 of its 300 characters writing the same sentence three times.
		expect(actHeadline(ACTS_15)).toBe(
			"15 acts, all irreversible: 14× pushed directly to the trunk origin main; deleted files recursively",
		);
		const mixed = [
			{ summary: "opened a pull request #7", irreversible: false },
			{ summary: "merged a pull request #7", irreversible: true },
			{ summary: "opened a pull request #8", irreversible: false },
		];
		expect(actHeadline(mixed)).toBe(
			"3 acts, 1 irreversible: merged a pull request #7; opened a pull request #7; opened a pull request #8",
		);
	});

	it("counts the acts it could not name rather than dropping them", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ summary: `did distinct thing number ${i}`, irreversible: true }));
		const head = actHeadline(many) ?? "";
		expect(head).toMatch(/^30 acts, all irreversible:/);
		expect(head).toMatch(/; and \d+ more$/);
		// Bounded so `cardDetail` can always give the note its floor.
		expect(head.length).toBeLessThanOrEqual(CARD_DETAIL_MAX - 3 - 120);
	});

	it("keeps the count when a single act summary is longer than the whole headline budget", () => {
		const head = actHeadline([{ summary: "z".repeat(500), irreversible: false }]) ?? "";
		expect(head).toMatch(/^1 act:/);
		expect(head.endsWith("…")).toBe(true);
		expect(head.length).toBeLessThanOrEqual(CARD_DETAIL_MAX - 3 - 120);
	});

	it("says nothing at all for a run with no observed acts", () => {
		// Never a padded "no consequential acts": a raw engine reports nothing, so silence means
		// "not observed", and claiming otherwise is the #159/#183 all-clear this repo forbids.
		expect(actHeadline([])).toBeNull();
	});
});

describe("cardDetail — budgeted, not a blind prefix (#568)", () => {
	it("passes a note that already fits through untouched, with no marker", () => {
		expect(cardDetail("outcome: done — 3 tests fixed")).toBe("outcome: done — 3 tests fixed");
	});

	it("marks a cut note even with no lead", () => {
		const out = cardDetail("y".repeat(400));
		expect(out.length).toBe(CARD_DETAIL_MAX);
		expect(out.endsWith("…")).toBe(true);
	});

	it("keeps the count AND the error, both inside 300", () => {
		const detail = cardDetail(NOTE_691, actHeadline(ACTS_15));
		expect(detail.length).toBeLessThanOrEqual(CARD_DETAIL_MAX);
		expect(detail).toMatch(/^15 acts, all irreversible:/);
		// The error is why the card is in Failed. Both belong — the ordering and the budget are the
		// fix, not dropping one of them.
		expect(detail).toContain("outcome: failed — run error: Too many API requests");
		expect(detail.endsWith("…")).toBe(true);
	});

	it("is NOT the 300-character prefix the old writer produced", () => {
		// The exact string measured on the card: 300 characters, ending `…pushed directly to th`,
		// naming two of fifteen irreversible acts and reading as a finished sentence.
		const old = NOTE_691.slice(0, 300);
		expect(old.length).toBe(300);
		expect(old.endsWith("pushed directly to th")).toBe(true);
		expect(old).not.toMatch(/15 acts/);
		expect(cardDetail(NOTE_691, actHeadline(ACTS_15))).not.toBe(old);
	});

	it("never lets the lead starve the note", () => {
		const huge = actHeadline(Array.from({ length: 40 }, (_, i) => ({ summary: `act ${i} of a very long list indeed`, irreversible: true })));
		const detail = cardDetail(NOTE_691, huge);
		expect(detail.length).toBeLessThanOrEqual(CARD_DETAIL_MAX);
		expect(detail).toContain("outcome: failed");
	});

	it("drops the separator rather than emit a dangling one when there is no note", () => {
		expect(cardDetail("", "15 acts, all irreversible")).toBe("15 acts, all irreversible");
	});
});
