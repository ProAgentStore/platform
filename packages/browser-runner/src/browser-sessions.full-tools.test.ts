import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { expect, it, vi } from "vitest";
import { BrowserSessions } from "./browser-sessions.js";
import { McpRuntime } from "./mcp-runtime.js";

it("retires a cached default session when restoring native tool access fails, before releasing its lease", async () => {
	const dir = mkdtempSync(join(tmpdir(), "failed-native-reset-"));
	const mcp = new McpRuntime();
	vi.spyOn(mcp, "configureToolAccess").mockResolvedValueOnce().mockRejectedValueOnce(new Error("reset failed"));
	const stop = vi.spyOn(mcp, "stop").mockResolvedValue();
	const close = vi.fn(async () => {});
	const context = { close } as unknown as BrowserContext;
	const sessions = new BrowserSessions(dir, true, () => false);
	sessions.current.mcp = mcp; sessions.current.context = context;
	try {
		const browser = await sessions.browserFor("default", join(dir, "run"), false, async () => mcp, async () => context);
		expect(sessions.current.leases).toBe(1);
		await expect(browser.stop()).rejects.toThrow("reset failed");
		expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
		expect(sessions.current).toMatchObject({ leases: 0, mcp: null, context: null, activePage: null });
	} finally { await sessions.close(); rmSync(dir, { recursive: true, force: true }); }
});
