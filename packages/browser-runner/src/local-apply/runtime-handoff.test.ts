import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import { LocalApplyHandoffRuntime } from "./runtime-handoff.js";

function fixture() {
	const page = { isClosed: () => false } as Page;
	const run = {
		envelope: { runId: "run", applicationId: "app", browserProfile: "isolated" as const },
		state: "paused" as "paused" | "running" | "ended",
		pause: { handoffRequestId: "pause-1" },
		browser: { handoffPage: () => page },
	};
	const takeover = { open: vi.fn(async () => undefined), state: vi.fn(async () => "ready" as const), frame: vi.fn(async () => ({ frame: "safe", width: 1, height: 1 })), input: vi.fn(async () => undefined), end: vi.fn(async () => undefined) };
	const runtime = new LocalApplyHandoffRuntime({ get: () => run, now: () => 1000, takeover });
	const request = { handoffId: "handoff-1", runId: "run", applicationId: "app", browserProfile: "isolated", handoffRequestId: "pause-1" };
	return { run, takeover, runtime, request };
}

it("opens one handoff per pause, joins concurrent requests, and never retargets an old id", async () => {
	const { run, takeover, runtime, request } = fixture();
	const first = await Promise.all([runtime.handoff(request), runtime.handoff(request)]);
	expect(first.map((r) => r.state)).toEqual(["ready", "ready"]);
	expect(takeover.open).toHaveBeenCalledTimes(1);
	await runtime.end(request);
	expect((await runtime.handoff(request)).state).toBe("closed");
	run.pause.handoffRequestId = "pause-2";
	const second = { ...request, handoffId: "handoff-2", handoffRequestId: "pause-2" };
	expect((await runtime.handoff(second)).state).toBe("ready");
	expect((await runtime.status(request)).state).toBe("closed");
	await expect(runtime.input({ ...request, input: { type: "click", x: 1, y: 1 } })).rejects.toThrow(/closed/);
	expect(takeover.input).not.toHaveBeenCalled();
	expect((await runtime.frame(second)).frame).toBe("safe");
});

it("refuses a fabricated pause or a second id for the same closed pause", async () => {
	const { runtime, request, takeover } = fixture();
	await expect(runtime.handoff({ ...request, handoffRequestId: "invented" })).rejects.toThrow(/current pause/);
	await runtime.handoff(request);
	await runtime.end(request);
	await expect(runtime.handoff({ ...request, handoffId: "another-id" })).rejects.toThrow(/already exists/);
	expect(takeover.open).toHaveBeenCalledTimes(1);
});

it("closes an old pause's live control as soon as the run advances", async () => {
	const { run, runtime, request, takeover } = fixture();
	await runtime.handoff(request);
	run.state = "running";
	await expect(runtime.frame(request)).rejects.toThrow(/closed/);
	expect(takeover.end).toHaveBeenCalledWith("handoff-1");
});
