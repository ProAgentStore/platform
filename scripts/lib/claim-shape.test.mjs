import { describe, expect, it } from "vitest";
import { SUBSET_CLAIMS, checkClaimShape } from "./claim-shape.mjs";

/**
 * The check exists because `workers/mcp/AGENTS.md:15` carried "18 of the **124**
 * registrations are gated" — against an actual 19 of 136 — through a fully green
 * `pnpm docs:drift`, in a file that WAS swept. Every other check in that script grades a
 * claim it managed to parse; none of them noticed a claim it could not.
 *
 * So the assertions below are about the THIRD state, the one that did not previously
 * exist: a document that raises the subject in a shape nobody reads. Each block asserts
 * both directions — the unreadable phrasing fails, and the readable one does not — because
 * a shape check that fires on everything gets deleted within a week.
 */

/** Enough files to clear SWEEP_FLOOR, none of them saying anything about tools. */
const padding = (n = 40) =>
	Array.from({ length: n }, (_, i) => ({ name: `platform-docs/pad-${i}.md`, src: "prose with no numbers in it" }));

/** The must-speak files, phrased readably — what a healthy tree looks like to this check. */
const healthy = () => [
	{ name: "platform-docs/mcp.md", src: "The server registers **136 tools**. 117 are always present. The remaining 19 are gated." },
	{ name: "workers/mcp/README.md", src: "**136 tool registrations.** 117 are always registered; 19 are gated to the console." },
	{ name: "store/llms-full.txt", src: "136 tools. 117 are always present; 19 are gated." },
	{ name: "store/about/index.html", src: "<p>136 tools across creator operations.</p>" },
	...padding(36),
];

describe("checkClaimShape", () => {
	it("fails the exact sentence that shipped, and names both halves of it", () => {
		const files = [
			...healthy(),
			{
				name: "workers/mcp/AGENTS.md",
				src: "The tool list is versioned and\n*per-connection*: 18 of the 124 registrations are gated to the console surfaces.",
			},
		];
		const { failures } = checkClaimShape({ files });
		expect(failures).toHaveLength(1);
		expect(failures[0].check).toBe("claim-shape");
		expect(failures[0].message).toContain("workers/mcp/AGENTS.md:2");
		expect(failures[0].message).toContain("124 registrations");
		// The remedy the message gives must be the one this design chose — rephrase, never
		// widen — because the next person reads that sentence and not this file.
		expect(failures[0].message).toContain("REPHRASING");
	});

	it("passes the same fact stated in a shape a check can read", () => {
		// The DISCRIMINATING half. `AGENTS.md` saying the right thing readably must be silent,
		// or the check is just noise that will be switched off.
		const files = [
			...healthy(),
			{ name: "workers/mcp/AGENTS.md", src: "Of 136 tool registrations, 19 are gated to your console surfaces." },
		];
		expect(checkClaimShape({ files }).failures).toEqual([]);
	});

	it("says nothing about a document that never raises the subject", () => {
		// "No claim" and "claim not parsed" being the same result IS the defect. This asserts
		// they have come apart: silence stays free.
		const { failures, notes } = checkClaimShape({ files: healthy() });
		expect(failures).toEqual([]);
		expect(notes[0]).toContain("0 unparsed");
	});

	it("states mentions = parsed + unparsed, not files swept", () => {
		// AC2 of #603, pinned as a string: "40 swept" was true of the green build that shipped
		// the stale 124, so the denominator has to be the claims.
		const { notes } = checkClaimShape({ files: healthy() });
		expect(notes[0]).toMatch(/\d+ mention\(s\).*== \d+ parsed by a claim check \+ \d+ unparsed/);
		expect(notes[0]).toContain("40 swept");
	});

	it("prints how many mentions the exemption hides, not just that one exists", () => {
		const files = [
			...healthy(),
			{ name: SUBSET_CLAIMS[0], src: "base.ts 7 tools\nknowledge.ts 10 tools\n67 of those 86 tools until #305" },
		];
		const { failures, notes } = checkClaimShape({ files });
		// Subset prose in the module-layout file is honest and must not fail...
		expect(failures).toEqual([]);
		// ...but the size of what went unchecked is stated, because an exclusion whose
		// magnitude is invisible is the under-count ADR 0002 forbids.
		expect(notes[0]).toContain("holding 3 unchecked mention(s)");
	});

	it("reports a broken sweep rather than a clean tree", () => {
		// G1. Both floors, each with its own message, because they fail for different reasons:
		// too few FILES means the collector lost a directory; too few MENTIONS means the
		// detector stopped detecting while the collector was fine.
		expect(checkClaimShape({ files: padding(5) }).failures[0].message).toContain("expected at least 20");

		const quiet = checkClaimShape({ files: padding(40) });
		expect(quiet.failures[0].message).toContain("mention detector has stopped detecting");
		expect(quiet.notes, "a broken detector must not also emit a reassuring note").toEqual([]);
	});
});
