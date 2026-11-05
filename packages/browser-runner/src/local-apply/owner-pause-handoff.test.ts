import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { LocalApplyHandoffRuntime, type LocalApplyTakeoverAdapter } from "./runtime-handoff.js";
import type { LocalApplyHandoffTerminalReason } from "./handoff-contract.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const request = { handoffId: "handoff-1", runId: "run-1", applicationId: "app-1", browserProfile: "isolated" as const, handoffRequestId: "pause-1" };
function setup() {
	let now = 1;
	const run = { envelope: { runId: "run-1", applicationId: "app-1", browserProfile: "isolated" as const }, state: "paused" as "running" | "paused" | "ended", pause: { reason: "owner_requested", handoffRequestId: "pause-1" }, ownerPauseReady: true, browser: { handoffPage: () => ({ isClosed: () => false }) as Page }, handoff: undefined as undefined | { handoffId: string; handoffRequestId?: string; state: "ready" | "closed"; expiresAt: number; terminalReason?: LocalApplyHandoffTerminalReason } };
	const adapter: LocalApplyTakeoverAdapter = { open: vi.fn(async () => {}), state: vi.fn(async () => "ready" as const), frame: vi.fn(async () => ({ frame: "safe", width: 1, height: 1 })), input: vi.fn(async () => {}), end: vi.fn(async () => {}) };
	const runtime = new LocalApplyHandoffRuntime({ get: () => run, now: () => now, takeover: adapter, handoffTtlMs: 10 });
	return { run, adapter, runtime, expire: () => { now = 12; } };
}

describe("owner handoff dispatch and settlement", () => {
	it("drains owner input and adapter close before AI resume can become available", async () => {
		const { run, adapter, runtime } = setup(); await runtime.handoff(request);
		const inputGate = deferred(), closeGate = deferred(), started = deferred();
		adapter.input = vi.fn(async () => { started.resolve(); await inputGate.promise; });
		adapter.end = vi.fn(async () => { await closeGate.promise; });
		const input = runtime.input({ ...request, input: { type: "click", x: 1, y: 1 } }); await started.promise;
		const closing = runtime.end(request);
		expect(runtime.isBusy(run)).toBe(true); expect(adapter.end).not.toHaveBeenCalled();
		await expect(runtime.input({ ...request, input: { type: "click", x: 2, y: 2 } })).rejects.toThrow();
		inputGate.resolve(); await input; await Promise.resolve();
		expect(runtime.isBusy(run)).toBe(true);
		closeGate.resolve(); await closing;
		expect(runtime.isBusy(run)).toBe(false); expect(adapter.input).toHaveBeenCalledTimes(1);
	});
	it.each(["expired", "page_lost"])("rejects %s input without waiting on its own drain", async reason => {
		const { adapter, runtime, expire } = setup(); await runtime.handoff(request);
		if (reason === "expired") expire(); else adapter.state = vi.fn(async () => "page_lost");
		await expect(runtime.input({ ...request, input: { type: "click", x: 1, y: 1 } })).rejects.toThrow("closed");
		expect(adapter.input).not.toHaveBeenCalled(); expect(adapter.end).toHaveBeenCalledTimes(1);
	});
	it("never redirects stale input to a new handoff after an awaited state check", async () => {
		const { run, adapter, runtime } = setup(); await runtime.handoff(request);
		const stateGate = deferred(), started = deferred();
		adapter.state = vi.fn(async () => { started.resolve(); await stateGate.promise; return "ready"; });
		const input = runtime.input({ ...request, input: { type: "click", x: 1, y: 1 } }); await started.promise;
		run.pause.handoffRequestId = "pause-2"; run.handoff = { handoffId: "handoff-2", handoffRequestId: "pause-2", state: "ready", expiresAt: 11 };
		stateGate.resolve(); await expect(input).rejects.toThrow("closed");
		expect(adapter.input).not.toHaveBeenCalled(); expect(run.handoff.state).toBe("ready");
	});
	it("closes an opening adapter if the pause changes before it returns", async () => {
		const { run, adapter, runtime } = setup(); const gate = deferred();
		adapter.open = vi.fn(async () => { await gate.promise; });
		const opening = runtime.handoff(request); expect(runtime.isBusy(run)).toBe(true);
		run.state = "running"; gate.resolve();
		await expect(opening).resolves.toMatchObject({ state: "closed" }); expect(adapter.end).toHaveBeenCalledWith("handoff-1");
	});
});
