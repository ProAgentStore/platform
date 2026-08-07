import { describe, expect, it } from "vitest";
import { formatGap, gapBetween, parseStamp, stampTitle, GAP_FLOOR_MS } from "./messageStamp";

describe("parseStamp", () => {
	it("reads a SQLite timestamp as UTC, not as local time", () => {
		// The bug this exists to prevent: `new Date("2026-08-07 22:33:34")` is LOCAL, so every
		// server-written timestamp would shift by the viewer's offset — and the gap between two
		// of them would still look right, which is how it would survive review.
		expect(parseStamp("2026-08-07 22:33:34")).toBe(Date.parse("2026-08-07T22:33:34Z"));
	});

	it("leaves an ISO string alone", () => {
		expect(parseStamp("2026-08-07T22:33:34.000Z")).toBe(Date.parse("2026-08-07T22:33:34.000Z"));
	});

	it("returns null rather than NaN for missing or junk input", () => {
		for (const v of [undefined, null, "", "not a date"]) expect(parseStamp(v)).toBeNull();
	});
});

describe("formatGap", () => {
	it("uses the shortest form that still says how long", () => {
		expect(formatGap(45_000)).toBe("45s");
		expect(formatGap(140_000)).toBe("2m20s"); // the real FWS thread from #336
		expect(formatGap(300_000)).toBe("5m");
		expect(formatGap(3_840_000)).toBe("1h04m");
		expect(formatGap(7_200_000)).toBe("2h");
		expect(formatGap(266_400_000)).toBe("3d2h");
		expect(formatGap(259_200_000)).toBe("3d");
	});

	it("pads the minutes inside an hour so 1h04m never reads as 1h40m", () => {
		expect(formatGap(3_840_000)).toBe("1h04m");
		expect(formatGap(6_000_000)).toBe("1h40m");
	});
});

describe("gapBetween", () => {
	it("reports the elapsed time between two entries", () => {
		expect(gapBetween("2026-08-07T22:33:34Z", "2026-08-07T22:35:54Z")).toBe("2m20s");
	});

	it("says nothing when either timestamp is missing — a locally emitted row has none", () => {
		expect(gapBetween(undefined, "2026-08-07T22:35:54Z")).toBe("");
		expect(gapBetween("2026-08-07T22:33:34Z", undefined)).toBe("");
	});

	it("stays quiet below the floor: several rows written in one tick are not a pause", () => {
		expect(gapBetween("2026-08-07T22:33:34Z", "2026-08-07T22:33:35Z")).toBe("");
		expect(gapBetween("2026-08-07T22:33:34Z", new Date(Date.parse("2026-08-07T22:33:34Z") + GAP_FLOOR_MS).toISOString())).toBe("2s");
	});

	it("never prints a negative gap — out-of-order rows are a lie, not a datum", () => {
		expect(gapBetween("2026-08-07T22:35:54Z", "2026-08-07T22:33:34Z")).toBe("");
	});
});

describe("stampTitle", () => {
	it("names the zone, so a reader can reconcile it with the agent's UTC prose (#329)", () => {
		const title = stampTitle("2026-08-07T22:33:34Z");
		expect(title).not.toBe("");
		// The zone name is locale/TZ dependent, so assert only that one is present at all.
		expect(title.split(" ").length).toBeGreaterThan(2);
	});

	it("is empty for a row with no usable timestamp", () => {
		expect(stampTitle(undefined)).toBe("");
		expect(stampTitle("nonsense")).toBe("");
	});

	it("honours the owner's stored zone over the browser's (#345)", () => {
		// The two-clock defect, one layer down: before this the title said `toLocaleString(undefined,
		// …)` — the MACHINE's zone — so an owner who set a zone different from their laptop saw it
		// honoured in the agent's prose and ignored in the UI.
		const sydney = stampTitle("2026-08-06T22:33:34Z", "Australia/Sydney");
		expect(sydney).toContain("8:33");
		// The day differs too, which is the half that makes "overnight" mean two different things.
		expect(sydney).toContain("2026");
		expect(stampTitle("2026-08-06T22:33:34Z", "Europe/London")).toContain("11:33");
	});

	it("falls back to the browser's zone rather than to an empty title", () => {
		// A stored zone this runtime's tz database does not carry must degrade to a readable time.
		expect(stampTitle("2026-08-06T22:33:34Z", "Mars/Olympus")).not.toBe("");
		expect(stampTitle("2026-08-06T22:33:34Z", undefined)).not.toBe("");
	});
});
