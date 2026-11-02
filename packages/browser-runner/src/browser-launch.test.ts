import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_ENGINES, launchRunnerBrowser } from "./browser-launch.js";
import { LocalRunner } from "./runner.js";
import { startRunnerServer } from "./server.js";

const launches = vi.hoisted(() => ({ chromium: vi.fn(), firefox: vi.fn(), webkit: vi.fn() }));
vi.mock("playwright", () => Object.fromEntries(Object.entries(launches).map(([name, launch]) => [name, { launchPersistentContext: launch, executablePath: () => `/playwright/${name}` }])));
vi.mock("./challenge.js", () => ({ detectHumanChallenge: async () => null, challengeSolved: async () => true, captureScreenshotDataUrl: async () => "data:image/jpeg;base64,eA==" }));
vi.mock("./mcp-runtime.js", () => ({ McpRuntime: class { async start() {} async stop() {} } }));
let dir: string;
function context() {
	const listeners = new Map<string, Array<() => void>>();
	const page = { once() {}, isClosed: () => false, bringToFront: async () => undefined, url: () => "https://fixture.test", title: async () => "fixture", locator: () => ({ innerText: async () => "fixture" }) };
	return { browser: () => ({ version: () => "verified-test-version" }), close: vi.fn(async () => { for (const fn of listeners.get("close") ?? []) fn(); }), on: (event: string, fn: () => void) => { listeners.set(event, [...listeners.get(event) ?? [], fn]); }, pages: () => [], newPage: async () => page, addInitScript: async () => undefined, cookies: async () => [] };
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-engines-"));
	vi.stubEnv("PAGS_SKIP_PLAYWRIGHT_INSTALL", "1");
	vi.stubEnv("PAGS_RUNNER_CHROMIUM", "0");
	vi.stubEnv("PAGS_RUNNER_REAL_PROFILE", "0");
	vi.stubEnv("PAGS_RUNNER_CHROME_USER_DATA_DIR", "");
	for (const launch of Object.values(launches)) launch.mockReset().mockImplementation(async () => context());
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const options = () => ({ headless: true, profilePolicy: "persistent" as const, preference: "default" as const, profileRoot: dir });

describe("explicit engine launches and truthful receipts (#1431)", () => {
	it.each(BROWSER_ENGINES)("launches %s through its supported Playwright browser/channel", async (engine) => {
		const owned = await launchRunnerBrowser({ ...options(), engine });
		try {
			const kind = engine === "firefox" || engine === "webkit" ? engine : "chromium";
			expect(launches[kind]).toHaveBeenCalledOnce();
			const args = launches[kind].mock.calls[0][1];
			expect(args.headless).toBe(true);
			expect(args.channel).toBe(kind === "chromium" ? engine : undefined);
			if (kind !== "chromium") expect(args.args).toBeUndefined();
			expect(owned.receipt).toMatchObject({ engine, requestedEngine: engine, browserType: kind, version: "verified-test-version", mode: "headless", profilePolicy: "persistent", active: true, transport: "playwright", fallbackReason: null });
			expect(owned.receipt.executable).toBe(engine === "chrome" || engine === "msedge" ? null : `/playwright/${kind}`);
		} finally { await owned.stop(); }
		expect(owned.receipt.active).toBe(false);
	});

	it("does not fall back when an explicitly selected browser is unavailable", async () => {
		launches.chromium.mockRejectedValue(new Error("Chrome channel is not installed"));
		await expect(launchRunnerBrowser({ ...options(), engine: "chrome" })).rejects.toThrow(/selected chrome/);
		expect(launches.chromium).toHaveBeenCalledTimes(1);
		expect(launches.firefox).not.toHaveBeenCalled();
	});

	it("retains legacy engine preference only when unset and records any fallback", async () => {
		launches.chromium.mockRejectedValueOnce(new Error("Installed Chrome unavailable"));
		const owned = await launchRunnerBrowser(options());
		expect(launches.chromium.mock.calls.map((call) => call[1].channel)).toEqual(["chrome", "chromium"]);
		expect(owned.receipt).toMatchObject({ engine: "chromium", requestedEngine: null, fallbackReason: "Installed Chrome unavailable" });
		await owned.stop();
	});

	it("separates persistent profiles by engine and preserves each when switching back", async () => {
		const first = await launchRunnerBrowser({ ...options(), engine: "firefox" });
		const profile = launches.firefox.mock.calls[0][0];
		writeFileSync(join(profile, "owner-session"), "retained");
		await first.stop();
		const other = await launchRunnerBrowser({ ...options(), engine: "webkit" });
		expect(launches.webkit.mock.calls[0][0]).not.toBe(profile);
		await other.stop();
		const again = await launchRunnerBrowser({ ...options(), engine: "firefox" });
		expect(again.receipt.profileId).toBe(first.receipt.profileId);
		expect(readFileSync(join(profile, "owner-session"), "utf8")).toBe("retained");
		await again.stop();
	});

	it("ephemeral profiles are fresh and removed on stop", async () => {
		const first = await launchRunnerBrowser({ ...options(), engine: "firefox", profilePolicy: "ephemeral" });
		const profile = launches.firefox.mock.calls[0][0];
		writeFileSync(join(profile, "owner-session"), "temporary");
		await first.stop();
		expect(existsSync(profile)).toBe(false);
		const next = await launchRunnerBrowser({ ...options(), engine: "firefox", profilePolicy: "ephemeral" });
		expect(next.receipt.profileId).not.toBe(first.receipt.profileId);
		await next.stop();
	});

	it("closes a successfully launched context if receipt delivery fails", async () => {
		const ctx = context();
		launches.firefox.mockResolvedValue(ctx);
		await expect(launchRunnerBrowser({ ...options(), engine: "firefox", profilePolicy: "ephemeral", onLaunch: () => { throw new Error("receipt failed"); } })).rejects.toThrow(/receipt failed/);
		expect(ctx.close).toHaveBeenCalledOnce();
		expect(existsSync(launches.firefox.mock.calls[0][0])).toBe(false);
	});
});

describe("runner session lifecycle and settings routing (#1431)", () => {
	const create = () => new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
	it("ephemeral workflow profiles survive a human wait, refuse sharing, then disappear on completion", async () => {
		const runner = create();
		const settings = { engine: "firefox", profilePolicy: "ephemeral" };
		let id = "";
		try {
			await runner.browsers.run("a", "headed", true, async () => { const task = runner.createTask({ type: "browser.task" }); id = task.id; await runner["getBrowserContext"](); task.status = "needs_human"; runner.store.putTask(task); }, true, settings);
			const path = launches.firefox.mock.calls[0][0];
			expect(existsSync(path)).toBe(true);
			await expect(runner.browsers.run("a", "headed", true, async () => undefined, true, settings)).rejects.toThrow(/still in use/);
			await runner.browsers.run("a", "headed", false, () => runner.browserComplete(id, "completed"), false, settings);
			expect(existsSync(path)).toBe(false);
			await runner.browsers.run("a", "headed", false, async () => expect(runner.browsers.sessionReceipt().launch).toMatchObject({ engine: "firefox", active: false }), false);
		} finally { await runner.close(); }
	});

	it.each([[false, "isolated", "ephemeral"], [true, "isolated", "persistent"], [false, "default", "persistent"]] as const)("engine-only uses workflow profile default: apply=%s profile=%s", async (apply, profile, policy) => {
		const runner = create();
		try {
			await runner.browsers.run("a", "headless", true, async () => {
				const browser = await runner.browsers.browserFor(profile, join(dir, "run"), apply, () => runner["getMcp"](), () => runner["getBrowserContext"]());
				expect(runner.browsers.sessionReceipt().launch).toMatchObject({ engine: "firefox", profilePolicy: policy });
				await browser.stop();
			}, true, { engine: "firefox" });
		} finally { await runner.close(); }
	});

	it.each(["persistent", "ephemeral"] as const)("explicit %s overrides the isolated research default", async (profilePolicy) => {
		const runner = create();
		try {
			await runner.browsers.run("a", "headless", true, async () => {
				const browser = await runner.browsers.browserFor("isolated", join(dir, "run"), false, () => runner["getMcp"](), () => runner["getBrowserContext"]());
				expect(runner.browsers.sessionReceipt().launch).toMatchObject({ engine: "chromium", profilePolicy });
				await browser.stop();
			}, true, { profilePolicy });
		} finally { await runner.close(); }
	});

	it("explicit profile retains default engine preference but never imports personal Chrome", async () => {
		const personal = join(dir, "personal");
		mkdirSync(join(personal, "Default"), { recursive: true });
		writeFileSync(join(personal, "Default", "Cookies"), "private");
		vi.stubEnv("PAGS_RUNNER_CHROME_USER_DATA_DIR", personal);
		const runner = create();
		try {
			await runner.browsers.run("a", "headless", true, async () => {
				await runner["getBrowserContext"]();
				expect(runner.browsers.sessionReceipt().launch).toMatchObject({ engine: "chrome", profilePolicy: "persistent" });
				const profile = launches.chromium.mock.calls[0][0];
				expect(existsSync(join(profile, "Default", "Cookies"))).toBe(false);
			}, true, { profilePolicy: "persistent" });
		} finally { await runner.close(); }
	});

	it("releases an idle generic browser before a local run opens the same persistent profile", async () => {
		const runner = create();
		try {
			await runner.browsers.run("a", "headless", true, async () => { await runner["getBrowserContext"](); }, true, { engine: "firefox" });
			const old = await launches.firefox.mock.results[0].value;
			await runner.browsers.run("a", "headless", true, async () => {
				const browser = await runner.browsers.browserFor("isolated", join(dir, "run"), true, () => runner["getMcp"](), () => runner["getBrowserContext"]());
				expect(old.close).toHaveBeenCalledOnce();
				expect(launches.firefox.mock.calls[1][0]).toBe(launches.firefox.mock.calls[0][0]);
				await browser.stop();
			}, true, { engine: "firefox" });
		} finally { await runner.close(); }
	});

	it("same-settings newRun rotates an idle ephemeral browser instead of reusing its state", async () => {
		const runner = create();
		const settings = { engine: "firefox", profilePolicy: "ephemeral" };
		try {
			await runner.browsers.run("a", "headless", true, () => runner["getBrowserContext"](), true, settings);
			const oldPath = launches.firefox.mock.calls[0][0];
			await runner.browsers.run("a", "headless", true, () => runner["getBrowserContext"](), true, settings);
			expect(existsSync(oldPath)).toBe(false);
			expect(launches.firefox.mock.calls[1][0]).not.toBe(oldPath);
		} finally { await runner.close(); }
	});

	it("a completed browser.open takeover releases its ephemeral profile", async () => {
		const runner = create();
		try {
			await runner.browsers.run("a", "headless", true, async () => {
				const task = runner.createTask({ type: "browser.open", input: { url: "https://fixture.test" } });
				await runner.browserHandoff(task.id, "test challenge");
				const path = launches.firefox.mock.calls[0][0];
				expect(existsSync(path)).toBe(true);
				await runner.resumeTakeover(task.id);
				expect(runner.store.getTask(task.id)?.status).toBe("completed");
				expect(existsSync(path)).toBe(false);
			}, true, { engine: "firefox", profilePolicy: "ephemeral" });
		} finally { await runner.close(); }
	});

	it("the application sign-in ledger follows the actual profile when a legacy browser preference falls back", async () => {
		const runner = create();
		try {
			await runner.browsers.run("a", "headless", true, async () => {
				const first = await runner.browsers.browserFor("default", join(dir, "run1"), true, () => runner["getMcp"](), () => runner["getBrowserContext"]());
				await first.sessions!.completeSignIn("seek.com");
				expect(await first.sessions!.check("https://seek.com/job")).toMatchObject({ state: "ok" });
				await first.stop();
			}, true, { profilePolicy: "persistent" });
			launches.chromium.mockRejectedValueOnce(new Error("Chrome unavailable"));
			await runner.browsers.run("a", "headless", true, async () => {
				const second = await runner.browsers.browserFor("default", join(dir, "run2"), true, () => runner["getMcp"](), () => runner["getBrowserContext"]());
				expect(runner.browsers.sessionReceipt().launch?.engine).toBe("chromium");
				expect(await second.sessions!.check("https://seek.com/job")).toMatchObject({ state: "missing", reason: "never_signed_in" });
				await second.stop();
			}, true, { profilePolicy: "persistent" });
		} finally { await runner.close(); }
	});

	it("session inspection is read-only and headers select engine/profile for the next task", async () => {
		const started = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true, token: "test" });
		const headers = { Authorization: "Bearer test", "Content-Type": "application/json", "X-PAGS-Instance-Id": "a", "X-PAGS-Browser-Engine": "webkit", "X-PAGS-Browser-Profile-Policy": "ephemeral" };
		try {
			const read = await fetch(started.url + "/browser/session", { method: "POST", headers, body: "{}" });
			expect(await read.json()).toEqual({ launch: null });
			expect(launches.webkit).not.toHaveBeenCalled();
			const task = await fetch(started.url + "/tasks", { method: "POST", headers, body: JSON.stringify({ type: "browser.task" }) });
			expect(task.status).toBe(202);
			await started.runner.browsers.run("a", undefined, false, async () => { await started.runner["getBrowserContext"](); }, false);
			const receipt = await fetch(started.url + "/browser/session", { method: "POST", headers, body: "{}" });
			expect(await receipt.json()).toMatchObject({ launch: { engine: "webkit", profilePolicy: "ephemeral", active: true } });
		} finally { await started.close(); }
	});
});
