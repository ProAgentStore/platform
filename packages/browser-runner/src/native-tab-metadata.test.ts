import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { NativeTabMetadata } from "./native-tab-metadata.js";

it("bounds and coalesces optional title reads, observes late rejection, and restores page methods/listeners", async () => {
	vi.useFakeTimers();
	try {
		let reject!: (reason: Error) => void;
		const original = vi.fn(() => new Promise<string>((_, fail) => { reject = fail; }));
		const foreground = vi.fn(async () => {});
		const page = Object.assign(new EventEmitter(), { title: original, bringToFront: foreground }) as unknown as Page;
		const metadata = new NativeTabMetadata(() => 40);
		metadata.track(page); metadata.track(page);
		const read = page.title();
		await vi.advanceTimersByTimeAsync(10);
		expect(await read).toContain("title unavailable");
		expect(await page.title()).toContain("title unavailable");
		expect(original).toHaveBeenCalledTimes(1);
		expect(metadata.pending()).toContain("title metadata pending 10ms (budget 10ms)");
		reject(new Error("late read failure")); await Promise.resolve(); await Promise.resolve();
		expect(metadata.pending()).toBe("");
		metadata.stop();
		expect(page.title).toBe(original); expect(page.bringToFront).toBe(foreground);
		expect(page.listenerCount("close")).toBe(0);
	} finally { vi.useRealTimers(); }
});

it("observes foreground operations without cancelling or replaying them", async () => {
	let release!: () => void;
	const original = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
	const page = Object.assign(new EventEmitter(), { title: async () => "normal", bringToFront: original }) as unknown as Page;
	const metadata = new NativeTabMetadata(() => 600_000);
	metadata.track(page);
	const action = page.bringToFront();
	expect(metadata.pending()).toContain("bringToFront pending");
	expect(original).toHaveBeenCalledTimes(1);
	release(); await action;
	expect(metadata.pending()).toBe("");
	page.emit("close"); expect(page.title).not.toBeUndefined();
	expect(page.bringToFront).toBe(original); expect(page.listenerCount("close")).toBe(0);
});
