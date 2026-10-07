import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@proagentstore/sdk/client", () => ({ api: vi.fn() }));

import { api } from "@proagentstore/sdk/client";
import { loopQueuedNotice, loopRequestKey, readLoopStart } from "./coding-loop-run";
import { type LastLoopStart, postLoopStart } from "./loop-start";

const mockApi = api as unknown as ReturnType<typeof vi.fn>;
const sentKey = (call: number) => JSON.parse(String((mockApi.mock.calls[call][1] as { body: string }).body)).requestId as string;

beforeEach(() => mockApi.mockReset());

describe("what a loop start answered (#929 findings 9 and 10)", () => {
	it("tells a started run from a queued objective from a start not yet confirmed", () => {
		expect(readLoopStart({ runId: "run-1", driver: "coding", status: "running" })).toEqual({ kind: "started", runId: "run-1", driver: "coding", duplicate: false });
		expect(readLoopStart({ queued: true, entry: { id: "q-1" }, blocked: "busy" })).toEqual({ kind: "queued", entryId: "q-1", duplicate: false });
		// A 202 receipt: the old code read `run.runId` here and announced a run with no id.
		expect(readLoopStart({ requestId: "k", startState: "provisioning" })).toEqual({ kind: "pending" });
		// #925: the guard hands back what already holds this objective.
		expect(readLoopStart({ runId: "run-0", status: "running", duplicate_of: "run-0" })).toMatchObject({ kind: "started", duplicate: true });
		expect(readLoopStart({ queued: true, entry: { id: "q-0" }, duplicate_of: "q-0" })).toMatchObject({ kind: "queued", duplicate: true });
	});

	it("says a queued objective is queued, and a duplicate that nothing was added", () => {
		expect(loopQueuedNotice({ kind: "queued", entryId: "q", duplicate: false })).toMatch(/^Queued — .*Settings → Autonomous runs/);
		expect(loopQueuedNotice({ kind: "queued", entryId: "q", duplicate: true })).toMatch(/already queued.*nothing new was added/);
	});

	it("reuses a request key only for the same arguments", () => {
		const first = loopRequestKey(null, "a");
		expect(loopRequestKey(first, "a")).toBe(first);
		expect(loopRequestKey(first, "b").requestId).not.toBe(first.requestId);
	});
});

describe("postLoopStart — a retry replays an unconfirmed start, never doubles it (#929 finding 10)", () => {
	const args = { objective: "fix it", maxIterations: 10 };

	it("keeps the key after an unconfirmed (202) answer, so the retry sends the same one", async () => {
		const last: LastLoopStart = { current: null };
		mockApi.mockResolvedValueOnce({ requestId: "x", startState: "provisioning" });
		expect(await postLoopStart("i1", args, last)).toEqual({ kind: "pending" });
		mockApi.mockResolvedValueOnce({ runId: "run-1" });
		expect(await postLoopStart("i1", args, last)).toMatchObject({ kind: "started", runId: "run-1" });
		expect(sentKey(1)).toBe(sentKey(0));
		// Confirmed: the next start is a NEW start, with a new key.
		mockApi.mockResolvedValueOnce({ runId: "run-2" });
		await postLoopStart("i1", args, last);
		expect(sentKey(2)).not.toBe(sentKey(1));
		expect(mockApi.mock.calls[0][0]).toBe("/v1/instances/i1/loop");
	});

	it("keeps the key after a lost reply, and frees it after a refusal", async () => {
		const last: LastLoopStart = { current: null };
		mockApi.mockRejectedValueOnce(new TypeError("fetch failed"));
		await expect(postLoopStart("i1", args, last)).rejects.toThrow("fetch failed");
		expect(last.current).not.toBeNull();
		mockApi.mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 409, body: { reason: "busy" } }));
		await expect(postLoopStart("i1", args, last)).rejects.toThrow("busy");
		expect(sentKey(1)).toBe(sentKey(0));
		expect(last.current).toBeNull();
	});
});
