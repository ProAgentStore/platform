import { describe, expect, it } from "vitest";
import { CHARGED_LEGEND, chargedCell, hasChargedFigures } from "./usageFigures";

describe("chargedCell (#543)", () => {
	it("distinguishes a measured zero from a figure that was never measured", () => {
		// The whole point of three states. Rendering `$0.00` for a payload that carries no charged
		// figure would invent a measurement; rendering nothing for a measured zero would hide the
		// most informative thing the page can say about a coding agent.
		expect(chargedCell({ costMicros: 9_566_686_384 })).toEqual({ kind: "unmeasured" });
		expect(chargedCell({ costMicros: 9_566_686_384, chargedCostMicros: 0 })).toEqual({ kind: "none" });
	});

	it("reports a charged row with its own figure, not the notional one", () => {
		expect(chargedCell({ costMicros: 40_000_000, chargedCostMicros: 36_336_533 })).toEqual({
			kind: "charged",
			micros: 36_336_533,
		});
	});

	it("treats a non-numeric or non-finite value as unmeasured", () => {
		expect(chargedCell({ costMicros: 1, chargedCostMicros: Number.NaN })).toEqual({ kind: "unmeasured" });
		expect(chargedCell({ costMicros: 1, chargedCostMicros: undefined })).toEqual({ kind: "unmeasured" });
	});
});

describe("hasChargedFigures", () => {
	it("is false for a payload from an API that predates the split", () => {
		expect(hasChargedFigures([{ costMicros: 100 }, { costMicros: 200 }])).toBe(false);
	});

	it("is true as soon as one row carries the figure, including a zero one", () => {
		expect(hasChargedFigures([{ costMicros: 100 }, { costMicros: 200, chargedCostMicros: 0 }])).toBe(true);
	});
});

describe("the legend", () => {
	it("refuses to call an unattributed row free, and does not claim the charged total is complete", () => {
		// Both halves are load-bearing: $0.00 charged beside $9,566.69 of value is the page's most
		// misreadable moment, and the charged figure genuinely starts at migration 0092 (#544).
		expect(CHARGED_LEGEND).toContain("is not free");
		expect(CHARGED_LEGEND).toContain("understates");
	});
});
