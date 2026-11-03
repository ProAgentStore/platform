import { describe, expect, it, vi } from "vitest";
import { McpRuntime } from "../mcp-runtime.js";
import { createRunnerBrowserFactories } from "./live-run-browser.js";

describe("default-profile sign-in secrets", () => {
	it.each(["browserFor", "applyBrowserFor"] as const)("%s provisions and clears secrets on the same MCP runtime that drives the page", async (factory) => {
		// The default profile reuses the already-owned runtime. Losing its secret store
		// leaves a real login_required pause unable to accept the platform's sign-in.
		const mcp = new McpRuntime();
		const defaultTools = vi.fn(async () => mcp);
		const factories = createRunnerBrowserFactories({
			headless: true,
			dataDir: "/unused-default-profile-test",
			defaultTools,
			defaultCookies: async () => [],
			sharedPage: () => null,
		});
		const browser = await factories[factory]("default", "/unused-run-test");
		expect(defaultTools).toHaveBeenCalledTimes(1);
		expect(browser.tools).toBe(mcp);
		expect(browser.secrets).toBeDefined();
		browser.secrets!.provideSecrets({ PAGS_LOGIN_USERNAME: "synthetic@example.test" });
		expect(mcp.secretNames()).toEqual(["PAGS_LOGIN_USERNAME"]);
		browser.secrets!.clearSecrets();
		expect(mcp.secretNames()).toEqual([]);
		await browser.stop();
	});
});
