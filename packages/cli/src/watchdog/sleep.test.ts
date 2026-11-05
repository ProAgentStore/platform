import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { stoppableSleep } from "./sleep.js";

afterEach(() => vi.useRealTimers());

it("ordinary completed waits release their stop closures instead of accumulating for service lifetime", async () => {
	vi.useFakeTimers();
	const stop = new AbortController();
	for (let i = 0; i < 100; i++) {
		const waiting = stoppableSleep(30_000, stop.signal);
		expect(getEventListeners(stop.signal, "abort")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(30_000);
		await waiting;
		expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
	}
	expect(vi.getTimerCount()).toBe(0);
});

it("stop wakes pending waits, clears timers, and future waits return immediately", async () => {
	vi.useFakeTimers();
	const stop = new AbortController();
	const waiting = stoppableSleep(300_000, stop.signal);
	stop.abort();
	await waiting;
	await stoppableSleep(300_000, stop.signal);
	expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
	expect(vi.getTimerCount()).toBe(0);
});
