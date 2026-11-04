import { describe, expect, it, vi } from "vitest";
import type { BrowserArtifactView } from "./runReplay";
import { emptyReplayHistory, loadReplayHistory, replayHistorySummary, type BrowserArtifactPageResponse, type BrowserArtifactCoverage } from "./replayHistory";
const subject = { kind: "local_apply_run" as const, id: "run-1" };
const frame = (seq: number): BrowserArtifactView => ({ id: `frame-${seq}`, subjectKind: subject.kind, subjectId: subject.id, seq, contentType: "image/png", bytes: 100, point: "snapshot", url: "https://jobs.example.com/", domain: "jobs.example.com", action: null, createdAt: "2026-11-04T00:00:00Z" });
const coverage = (total: number): BrowserArtifactCoverage => ({ basis: "stored_local_capture_sequences", storedFrames: total, firstStoredSeq: 1, lastStoredSeq: total, missingRanges: [], rangesTruncated: false, notice: "Stored history only." });
function source(total: number) {
	return vi.fn(async (after: number, limit: number): Promise<BrowserArtifactPageResponse> => {
		const artifacts = Array.from({ length: Math.max(0, Math.min(limit, total - after)) }, (_, i) => frame(Math.max(1, after + 1) + i)).filter((f) => f.seq <= total);
		const last = artifacts.at(-1)?.seq ?? after;
		return { subjectKind: subject.kind, subjectId: subject.id, artifacts, hasMore: last < total, nextCursor: last < total ? String(last) : null, screenshotsOff: false, coverage: coverage(total) };
	});
}

describe("bounded screenshot history pagination", () => {
	it("loads beyond the old500frame limit and keeps the newest frame addressable", async () => {
		const read = source(650);
		const state = await loadReplayHistory(emptyReplayHistory(), subject, read);
		expect(state.status).toBe("complete");
		expect(state.artifacts).toHaveLength(650);
		expect(state.artifacts.at(-1)?.seq).toBe(650);
		expect(read).toHaveBeenCalledTimes(7);
	});
	it("bounds a large backlog, includes the latest tail, and resumes the unfilled middle next time", async () => {
		const read = source(2500);
		const first = await loadReplayHistory(emptyReplayHistory(), subject, read);
		expect(first).toMatchObject({ cursor: 1000, hasMore: true, status: "partial" });
		expect(first.artifacts.at(-1)?.seq).toBe(2500);
		expect(read).toHaveBeenCalledTimes(11);
		read.mockClear();
		const second = await loadReplayHistory(first, subject, read);
		expect(read.mock.calls[0]).toEqual([1000, 100]);
		expect(second).toMatchObject({ cursor: 2000, hasMore: true, status: "partial" });
		const complete = await loadReplayHistory(second, subject, read);
		expect(complete).toMatchObject({ cursor: 2500, hasMore: false, status: "complete" });
		expect(complete.artifacts).toHaveLength(2500);
	});
	it("retains prior frames and retries the unread page after a failure, without claiming completion", async () => {
		const read = source(650);
		const firstPage = await read(-1, 100);
		const fail = vi.fn().mockResolvedValueOnce(firstPage).mockRejectedValueOnce(new Error("Network unavailable")).mockRejectedValueOnce(new Error("Tail unavailable"));
		const partial = await loadReplayHistory(emptyReplayHistory(), subject, fail);
		expect(partial).toMatchObject({ status: "partial", cursor: 100, hasMore: true });
		expect(partial.artifacts).toHaveLength(100);
		expect(replayHistorySummary(partial)).toContain("incomplete");
		read.mockClear();
		const done = await loadReplayHistory(partial, subject, read);
		expect(read.mock.calls[0]).toEqual([100, 100]);
		expect(done.artifacts).toHaveLength(650);
		expect(done.status).toBe("complete");
	});
	it("does not call history complete when new frames arrive between the page and coverage reads", async () => {
		const original = await source(100)(-1, 100);
		const read = vi.fn().mockResolvedValueOnce({ ...original, coverage: coverage(350) }).mockResolvedValueOnce(await source(350)(250, 100));
		const state = await loadReplayHistory(emptyReplayHistory(), subject, read);
		expect(state).toMatchObject({ cursor: 100, status: "partial", hasMore: true });
		expect(state.artifacts.at(-1)?.seq).toBe(350);
	});
	it("refreshes incrementally without replacing already loaded frames", async () => {
		const initial = await loadReplayHistory(emptyReplayHistory(), subject, source(650));
		const read = source(653);
		const next = await loadReplayHistory(initial, subject, read);
		expect(read.mock.calls[0]).toEqual([650, 100]);
		expect(next.artifacts).toHaveLength(653);
		expect(next.artifacts[0]).toEqual(initial.artifacts[0]);
	});
	it("refuses a cross-run response and a stalled cursor", async () => {
		const page = await source(200)(-1, 100);
		for (const invalid of [{ ...page, subjectId: "other" }, { ...page, nextCursor: "-1" }]) {
			const read = vi.fn(async () => invalid);
			const state = await loadReplayHistory(emptyReplayHistory(), subject, read);
			expect(state.status).toBe("unavailable");
			expect(state.artifacts).toHaveLength(0);
			expect(read).toHaveBeenCalledTimes(1);
		}
	});
	it("describes durable capture gaps while never interpreting workflow step jumps as missing screenshots", () => {
		const state = { ...emptyReplayHistory(), coverage: { ...coverage(20), missingRanges: [{ fromSeq: 2, toSeq: 5 }] } };
		expect(replayHistorySummary(state)).toContain("1 gap in stored capture sequences");
		expect(replayHistorySummary({ ...state, coverage: { ...state.coverage, basis: "stored_workflow_steps" } })).not.toContain("gap in stored");
	});
	it("does not call a legacy unpaged response complete or infer screenshots-off", async () => {
		const state = await loadReplayHistory(emptyReplayHistory(), subject, async () => ({ subjectKind: subject.kind, subjectId: subject.id, artifacts: [], screenshotsOff: false }));
		expect(state).toMatchObject({ status: "partial", screenshotsOff: false });
		expect(replayHistorySummary(state)).toContain("complete history is unverified");
	});
});


describe("recorded screenshot capture mode", () => {
	it.each(["runtime_task", "local_browser_run", "local_apply_run"] as const)("%s: only the server's flag establishes off mode", async (kind) => {
		for (const off of [false, true]) {
			const state = await loadReplayHistory(emptyReplayHistory(), { kind, id: "run-1" }, async () => ({ subjectKind: kind, subjectId: "run-1", artifacts: [], hasMore: false, nextCursor: null, screenshotsOff: off }));
			expect(state.screenshotsOff).toBe(off);
			expect(state.status).toBe("complete");
		}
	});
});
