import { describe, expect, it, vi } from "vitest";
import { heartbeatAcceptance, heartbeatPosts } from "./heartbeat-posts.js";

describe("ordered heartbeat acceptance", () => {
	it("a newer reply applied first fences out an older response arriving later", async () => {
		const applied: string[] = [];
		const accept = heartbeatAcceptance(async (value: string) => { applied.push(value); });
		const signal = new AbortController().signal;
		await accept("new", 2, signal);
		await accept("old", 1, signal);
		expect(applied).toEqual(["new"]);
	});

	it("asynchronous policy application is serialized so older work cannot overwrite newer work", async () => {
		let release: () => void = () => undefined;
		const paused = new Promise<void>((resolve) => { release = resolve; });
		const applied: string[] = [];
		const accept = heartbeatAcceptance(async (value: string) => { if (value === "old") await paused; applied.push(value); });
		const signal = new AbortController().signal;
		const first = accept("old", 1, signal);
		const second = accept("new", 2, signal);
		await Promise.resolve();
		expect(applied).toEqual([]);
		release();
		await Promise.all([first, second]);
		expect(applied).toEqual(["old", "new"]);
	});

	it("queued acceptance abandoned by its heartbeat deadline has no side effects", async () => {
		let release: () => void = () => undefined;
		const paused = new Promise<void>((resolve) => { release = resolve; });
		const applied: string[] = [];
		const accept = heartbeatAcceptance(async (value: string) => { if (value === "first") await paused; applied.push(value); });
		const first = accept("first", 1, new AbortController().signal);
		const abandoned = new AbortController();
		const late = accept("late", 2, abandoned.signal);
		const rejected = expect(late).rejects.toThrow("deadline");
		abandoned.abort(new Error("deadline"));
		release(); await first; await rejected;
		expect(applied).toEqual(["first"]);
	});

	it("a hanging acceptance cannot starve delivery to other agents or finish a cycle successfully", async () => {
		vi.useFakeTimers();
		try {
			const sent: string[] = [];
			const accept = heartbeatAcceptance(async () => { await new Promise<void>(() => undefined); });
			let sequence = 0;
			const cycle = heartbeatPosts(["a", "b", "c", "d", "e"], async (id, signal) => {
				sent.push(id); const n = ++sequence; await accept(id, n, signal);
			});
			await vi.advanceTimersByTimeAsync(20_000);
			expect(await cycle).toMatch(/did not finish/);
			expect(sent).toEqual(["a", "b", "c", "d", "e"]);
		} finally { vi.useRealTimers(); }
	});
});
