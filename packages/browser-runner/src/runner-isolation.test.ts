import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRunner } from "./runner.js";

const launch = vi.hoisted(() => vi.fn());
vi.mock("./browser-launch.js", async (original) => ({ ...await original<typeof import("./browser-launch.js")>(), launchRunnerBrowser: launch }));

describe("browser task and attachment isolation (#1441)", () => {
	let directory: string;
	let runner: LocalRunner;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pags-isolation-"));
		runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true });
		launch.mockReset();
	});
	afterEach(async () => { await runner.close(); rmSync(directory, { recursive: true, force: true }); });

	it("Stop remains terminal when delayed resume, input, handoff or completion calls arrive", async () => {
		const task = runner.createTask({ type: "browser.task" });
		task.status = "needs_human"; runner.store.putTask(task);
		runner["takeovers"].set(task.id, { page: {} as Page, requestId: "handoff", reason: "needs_input" });
		const stopped = runner.cancelTask(task.id);
		expect(await runner.resumeTakeover(task.id)).toMatchObject({ submitted: false, resumed: false });
		expect(runner.browserSubmitInput(task.id, "late answer")).toEqual({ ok: false });
		expect(await runner.browserResume(task.id)).toEqual({ ok: false });
		await expect(runner.browserHandoff(task.id, "late handoff")).rejects.toThrow(/stopped/);
		await runner.browserComplete(task.id, "submitted", "late result");
		expect(runner.store.getTask(task.id)).toEqual(stopped);
	});

	it("refuses unattributed and foreign-task calls before they can reach or clear the owner's tool policy", async () => {
		const owner = runner.createTask({ type: "browser.task", input: { commit: false } });
		const getTools = vi.fn(async () => { throw new Error("Tool access must not be reached"); });
		runner["getMcp"] = getTools;
		await expect(runner.browserAct({ action: "click", ref: "e1" })).rejects.toThrow(/owned by another/);
		await expect(runner.browserAct({ action: "click", ref: "e1" }, undefined, undefined, "foreign")).rejects.toThrow(/owned by another/);
		await expect(runner.browserSnapshot()).rejects.toThrow(/owned by another/);
		await expect(runner.browserHandoff("foreign", "Review")).rejects.toThrow(/owned by another/);
		expect(getTools).not.toHaveBeenCalled();
		expect(runner.store.getTask(owner.id)?.status).toBe("running");
	});

	it("a reused tab attaches only the current task's résumé and never falls back after a failed resolution", async () => {
		const page = new EventEmitter() as unknown as Page;
		const a = runner.createTask({ type: "job.apply_agent" });
		const b = runner.createTask({ type: "job.apply_agent" });
		const fileA = join(directory, "a.pdf"); const fileB = join(directory, "b.pdf");
		writeFileSync(fileA, "resume A"); writeFileSync(fileB, "resume B");
		const setFiles = vi.fn(async () => undefined);
		const choose = () => (page as unknown as EventEmitter).emit("filechooser", { setFiles });
		await runner["prepareResumeFile"](page, fileA, a.id); choose();
		expect(setFiles).toHaveBeenLastCalledWith(fileA);
		await runner["prepareResumeFile"](page, fileB, b.id); choose();
		expect(setFiles).toHaveBeenLastCalledWith(fileB);
		expect((page as unknown as EventEmitter).listenerCount("filechooser")).toBe(1);
		await expect(runner["prepareResumeFile"](page, join(directory, "missing.pdf"), b.id)).rejects.toThrow(/no previous attachment/);
		choose(); expect(setFiles).toHaveBeenCalledTimes(2);
		await runner["prepareResumeFile"](page, fileA, a.id);
		await runner["prepareResumeFile"](page, undefined, b.id);
		choose(); expect(setFiles).toHaveBeenCalledTimes(2);
	});

	it("read-only calls and a cancelled task cannot trigger the previously armed chooser", async () => {
		const page = new EventEmitter() as unknown as Page;
		const task = runner.createTask({ type: "job.apply_agent" });
		const path = join(directory, "resume.pdf"); writeFileSync(path, "resume");
		const setFiles = vi.fn(async () => undefined);
		const choose = () => (page as unknown as EventEmitter).emit("filechooser", { setFiles });
		await runner["prepareResumeFile"](page, path, task.id);
		await runner["prepareResumeFile"](page, path, task.id, false); choose();
		expect(setFiles).not.toHaveBeenCalled();
		await runner["prepareResumeFile"](page, path, task.id);
		task.status = "cancelled"; runner.store.putTask(task); choose();
		expect(setFiles).not.toHaveBeenCalled();
	});

	it("completion cannot close another live task's tab", async () => {
		const first = runner.createTask({ type: "browser.task" });
		const second = runner.createTask({ type: "browser.task" });
		const close = vi.fn(async () => undefined);
		const other = { close, isClosed: () => false } as unknown as Page;
		const active = {} as Page;
		runner.browsers.current.context = { pages: () => [other, active], close: async () => undefined } as unknown as BrowserContext;
		runner.browsers.current.activePage = active;
		await runner.browserComplete(first.id, "completed");
		expect(close).not.toHaveBeenCalled();
		await runner.browserComplete(second.id, "completed");
		expect(close).toHaveBeenCalledOnce();
	});

	it("a closed browser invalidates cached context and MCP before the next launch", async () => {
		const contexts: Array<BrowserContext & EventEmitter> = [];
		launch.mockImplementation(async () => {
			const context = Object.assign(new EventEmitter(), { pages: () => [], addInitScript: async () => undefined, close: async () => { context.emit("close"); } }) as unknown as BrowserContext & EventEmitter;
			contexts.push(context);
			return { context, stop: () => context.close() };
		});
		const first = await runner["getBrowserContext"]();
		const stop = vi.fn(async () => undefined);
		runner.browsers.current.mcp = { stop } as never;
		contexts[0].emit("close");
		expect(runner.browsers.current.mcp).toBeNull();
		expect(stop).toHaveBeenCalledOnce();
		expect(await runner["getBrowserContext"]()).not.toBe(first);
		expect(launch).toHaveBeenCalledTimes(2);
	});
});
