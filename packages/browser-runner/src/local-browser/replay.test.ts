/**
 * The runner's replay recorder (#1063): every capture takes one Playwright-native masked screenshot
 * (#1419), captures NOTHING when it fails or there is no real page to capture (fail closed), and is
 * bounded by a per-run cap, a per-frame size cap and a paged pull.
 */
import { describe, expect, it } from "vitest";
import { APPLY_SHOT_CAP, SCOUT_SHOT_CAP, MASK_CSS, MASK_SELECTOR, MAX_SHOT_BASE64, type MaskablePage, SHOTS_PAGE_BASE64, ShotRecorder } from "./replay.js";

function fakePage(opts: { shotThrows?: boolean; image?: string } = {}) {
	const calls: string[] = [];
	const page: MaskablePage = {
		locator: (selector) => {
			calls.push(`locator:${selector}`);
			return {} as ReturnType<MaskablePage["locator"]>;
		},
		screenshot: async () => {
			calls.push("shot");
			if (opts.shotThrows) throw new Error("page closed");
			return Buffer.from(opts.image ?? "jpeg-bytes");
		},
	};
	return { calls, page };
}

describe("ShotRecorder.capture", () => {
	it("takes one masked screenshot and keeps it", async () => {
		const p = fakePage();
		const rec = new ShotRecorder(10, () => Date.parse("2026-10-14T00:00:00Z"));
		expect(await rec.capture(p.page, "filled", { url: "https://jobs.example/apply" })).toBe(1);
		expect(p.calls).toEqual([`locator:${MASK_SELECTOR}`, "shot"]);
		expect(rec.shots).toEqual([{ seq: 1, point: "filled", url: "https://jobs.example/apply", mimeType: "image/jpeg", data: Buffer.from("jpeg-bytes").toString("base64"), at: "2026-10-14T00:00:00.000Z" }]);
	});

	it("masks inputs, textareas, selects and contenteditable regions", () => {
		for (const sel of ["input", "textarea", "select", "[contenteditable]"]) expect(MASK_CSS).toContain(sel);
		expect(MASK_CSS).toMatch(/filter: blur\(\d+px\) !important/);
	});

	it("fails closed: no frame when the screenshot throws", async () => {
		const p = fakePage({ shotThrows: true });
		const rec = new ShotRecorder(10);
		expect(await rec.capture(p.page, "filled")).toBeNull();
		expect(rec.shots).toEqual([]);
	});

	it("fails closed: no frame, no attempt at all, when there is no real page (#1419)", async () => {
		const rec = new ShotRecorder(10);
		expect(await rec.capture(null, "filled")).toBeNull();
		expect(rec.shots).toEqual([]);
	});

	it("keeps recent frames with monotonic sequences, and refuses an oversized frame", async () => {
		const rec = new ShotRecorder(2);
		const p = fakePage();
		expect([await rec.capture(p.page, "clicked"), await rec.capture(p.page, "clicked"), await rec.capture(p.page, "clicked")]).toEqual([1, 2, 3]);
		expect(rec.shots.map((shot) => shot.seq)).toEqual([2, 3]);
		const big = new ShotRecorder(5);
		expect(await big.capture(fakePage({ image: "A".repeat(MAX_SHOT_BASE64 + 4) }).page, "clicked")).toBeNull();
	});
	it.each([APPLY_SHOT_CAP, SCOUT_SHOT_CAP])("can capture review and completion after %i frames while retaining only its capacity", async (cap) => {
		const rec = new ShotRecorder(cap); const p = fakePage();
		for (let i = 0; i < cap + 5; i++) await rec.capture(p.page, "clicked");
		expect(await rec.capture(p.page, "review")).toBe(cap + 6);
		expect(await rec.capture(p.page, "completed")).toBe(cap + 7);
		expect(rec.shots).toHaveLength(cap);
		expect(rec.shots.at(-1)?.point).toBe("completed");
		expect(rec.page("run", 0).coverage).toMatchObject({ oldestSeq: 8, latestSeq: cap + 7, evicted: 7, gap: { fromSeq: 1, toSeq: 7 } });
		// If the cloud already stored the evicted frames, those evictions are not a missing-history gap.
		expect(rec.page("run", 7).coverage).not.toHaveProperty("gap");
	});
	it("never captures or retains frames when screenshots are off", async () => {
		const rec = new ShotRecorder(0, () => 0, false); const p = fakePage();
		for (let i = 0; i < 45; i++) expect(await rec.capture(p.page, "completed")).toBeNull();
		expect(p.calls).toEqual([]); expect(rec.shots).toEqual([]);
	});
});

describe("ShotRecorder.page — what the cloud pulls", () => {
	it("returns frames after the cursor, paged by size, never advancing past one it did not return", async () => {
		const frame = "A".repeat(Math.floor(SHOTS_PAGE_BASE64 / 2) + 8);
		const rec = new ShotRecorder(10);
		const p = fakePage({ image: frame });
		for (let i = 0; i < 3; i++) await rec.capture(p.page, "navigated");
		const first = rec.page("run-1", 0);
		expect(first.shots.map((s) => s.seq)).toEqual([1]);
		expect(first.lastSeq).toBe(1);
		expect(rec.page("run-1", first.lastSeq).shots.map((s) => s.seq)).toEqual([2]);
		expect(first.hasMore).toBe(true);
		expect(rec.page("run-1", 3)).toMatchObject({ runId: "run-1", shots: [], lastSeq: 3, hasMore: false, coverage: { oldestSeq: 1, latestSeq: 3, evicted: 0 } });
	});
});
