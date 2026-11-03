import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalRunner } from "./runner.js";

let dir: string;
let runner: LocalRunner;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-handoff-generation-"));
	runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
	const page = { url: () => "https://example.test/form", isClosed: () => false } as Page;
	vi.spyOn(runner, "getActivePage").mockResolvedValue(page);
});
afterEach(async () => {
	await runner.close();
	rmSync(dir, { recursive: true, force: true });
});

// Invariant: polling and owner resume retain the request identity; a new handoff on
// the same task replaces it, independent of wall-clock ordering between machines.
it("gives each successive handoff a stable, distinct opaque request id", async () => {
	const task = runner.createTask({ type: "browser.task", input: { screenshots: false } });
	await runner.browserHandoff(task.id, "first step", "stuck");
	const first = runner.listTakeoverRequests();
	expect(first).toEqual([{ taskId: task.id, requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) }]);
	expect(runner.listTakeoverRequests()).toEqual(first);
	await runner.resumeTakeover(task.id);
	expect(runner.listTakeoverRequests()).toEqual(first);
	await runner.browserHandoff(task.id, "second step", "stuck");
	const second = runner.listTakeoverRequests();
	expect(second[0]?.taskId).toBe(task.id);
	expect(second[0]?.requestId).not.toBe(first[0]?.requestId);
	await runner.endTakeover(task.id);
	expect(runner.listTakeoverRequests()).toEqual([]);
});
