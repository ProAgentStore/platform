import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRunner } from "./runner.js";
import { startRunnerServer } from "./server.js";

const launch = vi.hoisted(() => vi.fn());
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: launch, executablePath: () => "/playwright/chromium" } }));
vi.mock("./mcp-runtime.js", () => ({ McpRuntime: class { async start() {} async stop() {} } }));
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pags-mode-launch-"));
	vi.stubEnv("PAGS_SKIP_PLAYWRIGHT_INSTALL", "1");
	vi.stubEnv("PAGS_RUNNER_CHROMIUM", "1");
	launch.mockReset().mockImplementation(async (profile: string) => {
		void profile;
		return { browser: () => ({ version: () => "test-version" }), close: vi.fn(async () => undefined), pages: () => [], on: vi.fn(), addInitScript: async () => undefined, newPage: async () => ({ once() {}, isClosed: () => false }) };
	});
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("browser mode reaches real launch boundaries (#1429)", () => {
	it("agent mode overrides the CLI fallback at the Playwright launch, including two instances on one process", async () => {
		const runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true });
		try {
			await runner.browsers.run("visible", "headed", true, async () => { await Promise.all([runner["getBrowserContext"](), runner["getBrowserContext"]()]); });
			await runner.browsers.run("hidden", "headless", true, () => runner["getBrowserContext"]());
			expect(launch.mock.calls.map((c) => c[1].headless).sort()).toEqual([false, true]);
			expect(launch.mock.calls[0][0]).not.toBe(launch.mock.calls[1][0]);
			await runner.browsers.run("visible", "headed", false, async () => { await Promise.all([runner["getBrowserContext"](), runner["getBrowserContext"]()]); });
			expect(launch).toHaveBeenCalledTimes(2);
		} finally { await runner.close(); }
	});

	it.each([false, true])("local browser/apply isolated factories obey headed for apply=%s", async (apply) => {
		const runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true });
		try {
			await runner.browsers.run("local", "headed", true, async () => {
				const browser = await runner.browsers.browserFor("isolated", join(directory, "run"), apply, () => { throw new Error("not default"); }, () => { throw new Error("not default"); });
				expect(launch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headless: false }));
				await browser.stop();
			});
		} finally { await runner.close(); }
	});

	it.each([false, true])("local browser/apply default factories obey headed for apply=%s", async (apply) => {
		const runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true });
		try {
			await runner.browsers.run("local", "headed", true, async () => {
				const browser = await runner.browsers.browserFor("default", join(directory, "run"), apply, () => runner["getMcp"](), () => runner["getBrowserContext"]());
				expect(launch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headless: false }));
				await browser.stop();
				expect(runner.browsers.current.leases).toBe(0);
			});
		} finally { await runner.close(); }
	});

	it("a headed launch failure is reported; it never silently falls back to headless", async () => {
		launch.mockRejectedValue(new Error("No desktop display"));
		const runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true });
		try {
			await expect(runner.browsers.run("visible", "headed", true, () => runner["getBrowserContext"]())).rejects.toThrow("No desktop display");
			expect(launch.mock.calls.every((c) => c[1].headless === false)).toBe(true);
		} finally { await runner.close(); }
	});
});

describe("HTTP launch scope and non-browser requests (#1429)", () => {
	it("task creation pins headed; status/health/coding work never reset or wait on browser mode", async () => {
		const started = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true, token: "test" });
		const call = (path: string, body?: unknown, mode?: string) => fetch(started.url + path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "X-PAGS-Instance-Id": "a", ...(mode ? { "X-PAGS-Browser-Mode": mode } : {}) }, body: body ? JSON.stringify(body) : undefined });
		try {
			const task = await (await call("/tasks", { type: "browser.open", input: { url: "https://example.org" } }, "headed")).json() as { id: string };
			expect((await call("/health")).status).toBe(200);
			expect((await call("/tasks", { type: "echo", input: {} })).status).toBe(202);
			await started.runner.browsers.run("a", undefined, false, async () => expect(started.runner.browsers.current.headless).toBe(false), false);
			expect((await call("/tasks", { type: "browser.task", input: {} }, "headless")).status).toBe(409);
			started.runner.cancelTask(task.id);
			expect((await call("/tasks", { type: "browser.task", input: {} }, "headless")).status).toBe(202);
		} finally { await started.close(); }
	});

	it.each(["/local-browser/run", "/local-apply/run", "/local-apply/preflight", "/local-apply/sign-in", "/local-apply/reconciliation/run"])("scopes %s to the agent's headed configuration", async (path) => {
		const started = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true, token: "test" });
		const result = () => ({ headless: started.runner.browsers.current.headless });
		vi.spyOn(started.runner.localBrowser, "start").mockImplementation(result as never);
		vi.spyOn(started.runner.localApply, "start").mockImplementation(result as never);
		vi.spyOn(started.runner.localApply, "preflight").mockImplementation(async () => result() as never);
		vi.spyOn(started.runner.localApplySignIn, "open").mockImplementation(async () => result() as never);
		vi.spyOn(started.runner.localApplyReconciliation, "start").mockImplementation(async () => result() as never);
		try {
			const res = await fetch(started.url + path, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "X-PAGS-Instance-Id": "a", "X-PAGS-Browser-Mode": "headed" }, body: "{}" });
			expect(await res.json()).toEqual({ headless: false });
		} finally { await started.close(); }
	});
});
