import { describe, expect, it } from "vitest";
import { CHARGED_LEGEND, chargedCell, dayTokens, hasChargedFigures, showsInstanceBreakdown, tokenSplitLabel, unknownPayerRemedy } from "./usageFigures";

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

describe("dayTokens (#547)", () => {
	// The measured day: 2026-08-11 on the account whose 250M-token ceiling tripped at 268M. The
	// chart plotted 4,225,598 for it. The ceiling counts all four columns.
	const aug11 = { inputTokens: 2_192_612, outputTokens: 2_032_986, cacheReadTokens: 846_000_000, cacheWriteTokens: 9_400_000 };

	it("counts the same four columns the daily circuit breaker counts", () => {
		expect(dayTokens(aug11)).toBe(859_625_598);
		// And the old metric, for the size of the error the chart was making: 137x smaller.
		expect(aug11.inputTokens + aug11.outputTokens).toBe(4_225_598);
	});

	it("treats missing cache columns as zero without crashing", () => {
		// A response from an API older than #547 carries no cache fields. Zero is the only sum
		// available; the tooltip is what refuses to describe that as "0 cache".
		expect(dayTokens({ inputTokens: 1000, outputTokens: 500 })).toBe(1500);
	});
});

describe("tokenSplitLabel", () => {
	const raw = (n: number) => String(n);

	it("names the I/O and cache halves, so the magnitude is not a second mystery number", () => {
		expect(tokenSplitLabel({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 700 }, raw)).toBe(
			"300 I/O + 9700 cache",
		);
	});

	it("says nothing about cache when the payload does not report any", () => {
		expect(tokenSplitLabel({ inputTokens: 200, outputTokens: 100 }, raw)).toBe("300 tokens");
	});

	it("says nothing about cache on a day that reported zero of it", () => {
		// Reported-and-zero is a real answer, but "+ 0 cache" is noise on every pre-engine day.
		expect(tokenSplitLabel({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, raw)).toBe("300 tokens");
	});
});

describe("unknownPayerRemedy (#551)", () => {
	const usd = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;

	it("states the size of the gap and the one action that closes it", () => {
		// The production bucket: 3,462 calls, $9,584.87, 99.62% of the account's notional value.
		const s = unknownPayerRemedy([{ key: "unknown", costMicros: 9_584_865_793, calls: 3_462 }], usd);
		expect(s).toContain("3,462 calls");
		expect(s).toContain("$9584.87");
		expect(s).toContain("Profile → API Keys");
	});

	it("says nothing to an account whose spend is all attributed", () => {
		// Every row here has a payer. Offering a remedy for a problem the reader does not have is
		// how a page teaches people to skip its notices.
		expect(unknownPayerRemedy([{ key: "byok-api", costMicros: 100, calls: 4 }], usd)).toBeNull();
		expect(unknownPayerRemedy(undefined, usd)).toBeNull();
	});

	it("says nothing about a bucket with no calls in it", () => {
		expect(unknownPayerRemedy([{ key: "unknown", costMicros: 0, calls: 0 }], usd)).toBeNull();
	});
});

describe("showsInstanceBreakdown (#526)", () => {
	it("shows the card once there is more than one instance to compare", () => {
		// The whole point: seven Repo Coders are one row on "By agent". Two is enough for that
		// collapse to hide something.
		expect(showsInstanceBreakdown([{ key: "i1" }, { key: "i2" }])).toBe(true);
	});

	it("stays hidden for a single instance, where it would repeat 'By agent' verbatim", () => {
		expect(showsInstanceBreakdown([{ key: "i1" }])).toBe(false);
		expect(showsInstanceBreakdown([{ key: "i1" }, { key: "unassigned" }])).toBe(false);
	});

	it("stays hidden when the API did not report the axis at all", () => {
		// An older API has no byInstance. The page omits the card rather than rendering an empty one.
		expect(showsInstanceBreakdown(undefined)).toBe(false);
		expect(showsInstanceBreakdown([])).toBe(false);
	});
});
