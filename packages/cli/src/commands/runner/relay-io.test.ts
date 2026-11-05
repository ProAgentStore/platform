import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedRelayWork, relayRequest } from "./relay-io.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("bounded relay control-plane requests", () => {
	it("token body parsing is aborted within the same deadline as fetch", async () => {
		let sent: AbortSignal | undefined;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			sent = init.signal ?? undefined;
			return new Response(new ReadableStream({ start(controller) { sent?.addEventListener("abort", () => controller.error(sent?.reason), { once: true }); } }));
		});
		const result = relayRequest("POST", "/v1/relay/fixture/token", { pagsToken: "inert", apiBase: "https://fixture.test" }, {}).catch(error => error);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(sent?.aborted).toBe(true); expect(await result).toMatchObject({ message: expect.stringContaining("did not finish") });
	});
	it("parent cancellation rejects even a noncooperative request and late success is discarded", async () => {
		const parent = new AbortController(); let release!: (value: string) => void;
		let signal: AbortSignal | undefined;
		const operation = boundedRelayWork((given) => { signal = given; return new Promise<string>(resolve => { release = resolve; }); }, 1000, parent.signal).catch(error => error);
		parent.abort(new Error("detached")); await vi.advanceTimersByTimeAsync(0);
		expect(await operation).toMatchObject({ message: "detached" }); expect(signal?.aborted).toBe(true);
		release("late"); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
	});
	it("an already-aborted parent starts no IO and leaves no rejected background promise", async () => {
		const parent = new AbortController(); parent.abort(new Error("already detached")); const work = vi.fn();
		await expect(boundedRelayWork(work, 1000, parent.signal)).rejects.toThrow("already detached"); expect(work).not.toHaveBeenCalled();
	});
});
