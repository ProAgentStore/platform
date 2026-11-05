import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkPower } from "./work-power.js";

function fixture(platform: NodeJS.Platform = "darwin") {
	let work = false;
	const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }> = [];
	const spawn = vi.fn(() => {
		const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
		children.push(child);
		return child as unknown as ChildProcess;
	});
	const warn = vi.fn();
	const power = new WorkPower({ platform, pid: 12345, hasWork: () => work, spawn, warn });
	return { power, children, spawn, warn, background: (active: boolean) => { work = active; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("macOS work-scoped sleep prevention (#1486)", () => {
	it("immediately protects a new job after the previous job released its assertion", () => {
		const f = fixture();
		f.power.begin()();
		const release = f.power.begin();
		expect(f.spawn).toHaveBeenCalledTimes(2);
		release();
	});

	it("takes only an AC system-sleep assertion before work and binds it to runtime lifetime", () => {
		const f = fixture();
		expect(f.spawn).not.toHaveBeenCalled();
		const release = f.power.begin();
		expect(f.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/caffeinate", ["-s", "-w", "12345"]);
		expect(f.children[0].kill).not.toHaveBeenCalled();
		release();
		expect(f.children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("concurrent requests cannot release another request or its background coding/clone job", () => {
		const f = fixture();
		const first = f.power.begin();
		const second = f.power.begin();
		first(); first();
		expect(f.children[0].kill).not.toHaveBeenCalled();
		f.background(true); second();
		vi.advanceTimersByTime(60_000);
		expect(f.spawn).toHaveBeenCalledTimes(1);
		expect(f.children[0].kill).not.toHaveBeenCalled();
		f.background(false);
		vi.advanceTimersByTime(1000);
		expect(f.children[0].kill).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases after cancellation and runtime close, and late releases cannot reopen it", () => {
		const f = fixture();
		const release = f.power.begin();
		f.background(true); release();
		f.power.close();
		expect(f.children[0].kill).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		release(); f.power.begin(); vi.advanceTimersByTime(60_000);
		expect(f.spawn).toHaveBeenCalledTimes(1);
	});

	it("recovers an unexpectedly exited helper with a bounded retry and no helper pile-up", () => {
		const f = fixture();
		const release = f.power.begin();
		f.children[0].emit("exit", 1);
		vi.advanceTimersByTime(4999);
		expect(f.spawn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(f.spawn).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(30_000);
		expect(f.spawn).toHaveBeenCalledTimes(2);
		release();
		expect(f.children[1].kill).toHaveBeenCalledTimes(1);
		expect(f.warn).toHaveBeenCalledTimes(1);
	});

	it("reports spawn errors and retries while work is active, never after idle", () => {
		const f = fixture();
		const release = f.power.begin();
		f.children[0].emit("error", new Error("ENOENT"));
		vi.advanceTimersByTime(5000);
		expect(f.spawn).toHaveBeenCalledTimes(2);
		release();
		vi.advanceTimersByTime(30_000);
		expect(f.spawn).toHaveBeenCalledTimes(2);
	});

	it.each(["linux", "win32"] as const)("does not spawn or leave timers on %s", (platform) => {
		const f = fixture(platform);
		f.background(true);
		const release = f.power.begin();
		vi.advanceTimersByTime(60_000);
		release(); f.power.close();
		expect(f.spawn).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
