/** #1433: an owner's saved run policy controls stored pixels across actions, handoffs and restart. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpRuntime } from "./mcp-runtime.js";
import { LocalRunner } from "./runner.js";

function pageFixture(challenge = false) {
	const screenshot = vi.fn(async (_options: Parameters<Page["screenshot"]>[0]) => Buffer.from("rendered-jpeg"));
	const page = {
		url: () => "https://jobs.example/form", title: async () => "Form", screenshot,
		locator: () => ({ count: async () => challenge ? 1 : 0 }), evaluate: async () => false,
		mouse: { wheel: async () => undefined }, waitForTimeout: async () => undefined,
		goto: async () => undefined,
	} as unknown as Page;
	return { page, screenshot };
}

describe("stored browser screenshot run policy", () => {
	let dir: string;
	let runner: LocalRunner;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-shot-policy-"));
		runner = makeRunner();
	});
	function makeRunner() { return new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true }); }
	function install(page: Page) {
		runner["getActivePage"] = async () => page;
		runner["getBrowserContext"] = async () => ({ pages: () => [page] }) as unknown as BrowserContext;
		runner["getMcp"] = async () => ({ setSubject: () => undefined, recordExternal: () => undefined }) as unknown as McpRuntime;
	}
	afterEach(async () => { await runner.close(); rmSync(dir, { recursive: true, force: true }); });

	it("freezes opposite policies independently and retains them after a runner restart", async () => {
		const input = { blurFormFields: false };
		const raw = runner.createTask({ type: "browser.task", input });
		const masked = runner.createTask({ type: "browser.task", input: { blurFormFields: true } });
		input.blurFormFields = true;
		await runner.close();
		runner = makeRunner();
		const f = pageFixture(); install(f.page);
		await runner.browserAct({ action: "scroll", blurFormFields: true }, undefined, undefined, raw.id);
		expect(f.screenshot.mock.calls[0]?.[0]).not.toHaveProperty("mask");
		await runner.browserAct({ action: "scroll", blurFormFields: false }, undefined, undefined, masked.id);
		expect(f.screenshot.mock.calls[1]?.[0]).toHaveProperty("mask");
		await runner.browserHandoff(raw.id, "Review", "assist", { blurFormFields: true });
		expect(f.screenshot.mock.calls[2]?.[0]).not.toHaveProperty("mask");
		await runner.browserHandoff(masked.id, "Review", "assist", { blurFormFields: false });
		expect(f.screenshot.mock.calls[3]?.[0]).toHaveProperty("mask");
	});

	it.each([undefined, null, "false", 0, {}])("masks absent or invalid task policy %j even if a later action asks otherwise", async (blurFormFields) => {
		const task = runner.createTask({ type: "job.apply_agent", input: { blurFormFields } });
		const f = pageFixture(); install(f.page);
		await runner.browserAct({ action: "scroll", blurFormFields: false }, undefined, undefined, task.id);
		expect(f.screenshot.mock.calls[0]?.[0]).toHaveProperty("mask");
	});

	it("keeps screenshot disable stronger than unblur for both actions and handoff stills", async () => {
		const task = runner.createTask({ type: "browser.task", input: { screenshots: false, blurFormFields: false } });
		const f = pageFixture(); install(f.page);
		expect((await runner.browserAct({ action: "scroll", screenshot: true }, undefined, undefined, task.id)).screenshot).toBeUndefined();
		expect((await runner.browserHandoff(task.id, "Review", "assist")).screenshotBase64).toBeUndefined();
		expect(runner.listTakeovers()).toContain(task.id);
		expect(f.screenshot).not.toHaveBeenCalled();
	});

	it("persists a taskless handoff's initial choice for subsequent stills", async () => {
		const f = pageFixture(); install(f.page);
		await runner.browserHandoff("signin-fixture", "Sign in", "assist", { blurFormFields: false });
		await runner.browserHandoff("signin-fixture", "Sign in", "assist", { blurFormFields: true });
		expect(runner.store.getTask("signin-fixture")?.input.blurFormFields).toBe(false);
		for (const call of f.screenshot.mock.calls) expect(call[0]).not.toHaveProperty("mask");
	});

	it.each([false, true])("browser.open %s challenge/hold stores a still under its saved policy", async (challenge) => {
		const f = pageFixture(challenge); install(f.page);
		const task = runner.createTask({ type: "browser.open", input: { url: "https://jobs.example/form", holdForTakeover: true, blurFormFields: false } });
		await runner.approveTask(task.id);
		expect(runner.store.getTask(task.id)?.status).toBe("needs_human");
		expect(f.screenshot).toHaveBeenCalledTimes(1);
		expect(f.screenshot.mock.calls[0]?.[0]).not.toHaveProperty("mask");
	});
});
