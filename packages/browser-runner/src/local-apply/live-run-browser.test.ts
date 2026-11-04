import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { McpRuntime } from "../mcp-runtime.js";
import { createRunnerBrowserFactories } from "./live-run-browser.js";

let runDir: string;
beforeEach(() => { runDir = mkdtempSync(join(tmpdir(), "borrowed-browser-")); });
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

describe("default-profile sign-in secrets", () => {
	it.each(["browserFor", "applyBrowserFor"] as const)("%s provisions and clears secrets on the same MCP runtime that drives the page", async (factory) => {
		// The default profile reuses the already-owned runtime. Losing its secret store
		// leaves a real login_required pause unable to accept the platform's sign-in.
		const mcp = new McpRuntime();
		const configure = vi.spyOn(mcp, "configureToolAccess").mockResolvedValue();
		const setPolicy = vi.spyOn(mcp, "setCallPolicy");
		const setSubject = vi.spyOn(mcp, "setSubject");
		const defaultTools = vi.fn(async () => mcp);
		const factories = createRunnerBrowserFactories({
			headless: true,
			dataDir: "/unused-default-profile-test",
			defaultTools,
			defaultCookies: async () => [],
			sharedPage: () => null,
		});
		const browser = await factories[factory]("default", runDir);
		expect(defaultTools).toHaveBeenCalledTimes(1);
		expect(browser.tools).toBe(mcp);
		expect(browser.secrets).toBeDefined();
		browser.secrets!.provideSecrets({ PAGS_LOGIN_USERNAME: "synthetic@example.test" });
		expect(mcp.secretNames()).toEqual(["PAGS_LOGIN_USERNAME"]);
		browser.secrets!.clearSecrets();
		expect(mcp.secretNames()).toEqual([]);
		await browser.stop(); await browser.stop();
		expect(configure.mock.calls).toEqual([["guarded", runDir], ["guarded", runDir]]);
		expect(setPolicy).toHaveBeenLastCalledWith({}); expect(setSubject).toHaveBeenLastCalledWith(null);
	});
});

it("resets a Full borrowed application lease before the next research run uses its cached runtime", async () => {
	const mcp = new McpRuntime(); let configured = "guarded"; let authorized = false;
	vi.spyOn(mcp, "configureToolAccess").mockImplementation(async (mode) => { configured = mode; });
	vi.spyOn(mcp, "setCallPolicy").mockImplementation((policy) => { authorized = policy.toolAccess === "full"; });
	const factories = createRunnerBrowserFactories({ headless: true, dataDir: "/unused", defaultTools: async () => mcp, defaultCookies: async () => [], sharedPage: () => null });
	const apply = await factories.applyBrowserFor("default", join(runDir, "first"));
	await apply.tools.configureToolAccess!("full", join(runDir, "first")); apply.tools.setCallPolicy!({ toolAccess: "full" });
	apply.secrets!.provideSecrets({ PAGS_LOGIN_PASSWORD: "synthetic-secret" });
	expect(configured).toBe("full"); expect(authorized).toBe(true);
	await apply.stop(); expect(configured).toBe("guarded"); expect(authorized).toBe(false); expect(mcp.secretNames()).toEqual([]);
	const research = await factories.browserFor("default", join(runDir, "second"));
	expect(configured).toBe("guarded"); expect(authorized).toBe(false);
	await research.stop();
});

it("revokes Full policy and subject even when restoring the borrowed native configuration fails", async () => {
	const mcp = new McpRuntime(); const configure = vi.spyOn(mcp, "configureToolAccess").mockResolvedValue();
	const policy = vi.spyOn(mcp, "setCallPolicy"); const subject = vi.spyOn(mcp, "setSubject");
	const factories = createRunnerBrowserFactories({ headless: true, dataDir: "/unused", defaultTools: async () => mcp, defaultCookies: async () => [], sharedPage: () => null });
	const browser = await factories.browserFor("default", join(runDir, "run"));
	mcp.setCallPolicy({ toolAccess: "full" }); mcp.setSubject({ kind: "local_apply_run", id: "run" });
	configure.mockRejectedValueOnce(new Error("Native reconfigure failed"));
	await expect(browser.stop()).rejects.toThrow("Native reconfigure failed");
	expect(policy).toHaveBeenLastCalledWith({}); expect(subject).toHaveBeenLastCalledWith(null);
});
