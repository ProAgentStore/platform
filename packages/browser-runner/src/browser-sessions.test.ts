import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSessions, type BrowserSession } from "./browser-sessions.js";
import { seedAgentBrowserProfiles } from "./browser-profile.js";
import type { BrowserContext } from "playwright";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "pags-modes-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("per-agent browser mode (#1429)", () => {
	it("closes the owned browser while MCP teardown is waiting for its page to close", async () => {
		const sessions = new BrowserSessions(dir(), true, () => false);
		let release!: () => void;
		const pageClosed = new Promise<void>((resolve) => { release = resolve; });
		const stop = vi.fn(() => pageClosed);
		const close = vi.fn(async () => { release(); });
		sessions.current.mcp = { stop } as never;
		sessions.current.context = { close } as unknown as BrowserContext;
		try {
			await sessions.close();
			expect(stop).toHaveBeenCalledOnce();
			expect(close).toHaveBeenCalledOnce();
			expect(sessions.current.context).toBeNull();
		} finally { release(); }
	});
	it("requires the live task's identity for every request, including taskless chat and snapshots (#1441)", async () => {
		let local = false;
		const sessions = new BrowserSessions(dir(), true, (id) => id === "owner", () => local);
		await sessions.run("a", undefined, true, async () => {
			sessions.current.taskIds.add("owner");
			expect(() => sessions.assertTaskAccess()).toThrow(/owned by another/);
			expect(() => sessions.assertTaskAccess("foreign")).toThrow(/owned by another/);
			expect(() => sessions.assertTaskAccess("owner")).not.toThrow();
		});
		await sessions.run("b", undefined, true, async () => {
			expect(() => sessions.assertTaskAccess()).not.toThrow();
			sessions.current.leases = 1;
			expect(() => sessions.assertTaskAccess()).toThrow(/owned by another/);
			sessions.current.leases = 0;
			local = true;
			expect(() => sessions.assertTaskAccess()).toThrow(/owned by another/);
		});
	});
	it("refuses a second run even when it inherits identical legacy browser settings (#1441)", async () => {
		let active = true;
		const sessions = new BrowserSessions(dir(), true, () => active);
		await sessions.run("a", undefined, true, async () => { sessions.current.taskIds.add("first"); });
		const second = vi.fn(async () => undefined);
		await expect(sessions.run("a", undefined, true, second)).rejects.toThrow(/still in use/);
		expect(second).not.toHaveBeenCalled();
		await sessions.run("b", undefined, true, second);
		active = false;
		await sessions.run("a", undefined, true, second);
		expect(second).toHaveBeenCalledTimes(2);
	});
	it("explicit headed overrides a headless service, explicit headless overrides a headed process, and absence uses fallback", async () => {
		for (const fallback of [true, false]) {
			const sessions = new BrowserSessions(dir(), fallback, () => false);
			for (const [mode, expected] of [["headed", false], ["headless", true], [undefined, fallback]] as const) {
				await sessions.run("agent", mode, true, async () => expect(sessions.current.headless).toBe(expected));
			}
		}
	});

	it("uses independent browser state and profile directories for different agents on one runner", async () => {
		const sessions = new BrowserSessions(dir(), true, () => false);
		let a!: BrowserSession;
		await sessions.run("../agent-a", "headed", true, async () => { a = sessions.current; });
		await sessions.run("agent-b", "headless", true, async () => {
			expect(sessions.current).not.toBe(a);
			expect(sessions.current.dataDir).not.toBe(a.dataDir);
			expect(a.dataDir).toMatch(/agent-browsers\/[a-f0-9]{64}$/);
			expect(a.headless).toBe(false);
			expect(sessions.current.headless).toBe(true);
		});
	});

	it("pins a running task's mode, refuses a conflicting new run, then closes only that agent's idle browser", async () => {
		let active = true;
		const sessions = new BrowserSessions(dir(), true, () => active);
		const closeA = vi.fn(async () => undefined);
		const closeB = vi.fn(async () => undefined);
		await sessions.run("a", "headed", true, async () => { sessions.current.taskIds.add("task"); sessions.current.context = { close: closeA } as unknown as BrowserContext; });
		await sessions.run("b", "headless", true, async () => { sessions.current.context = { close: closeB } as unknown as BrowserContext; });
		await sessions.run("a", "headless", false, async () => expect(sessions.current.headless).toBe(false));
		await expect(sessions.run("a", "headless", true, async () => undefined)).rejects.toThrow(/current task finishes/);
		expect(closeA).not.toHaveBeenCalled();
		active = false;
		await sessions.run("a", "headless", true, async () => expect(sessions.current.headless).toBe(true));
		expect(closeA).toHaveBeenCalledOnce();
		expect(closeB).not.toHaveBeenCalled();
		await sessions.close();
		expect(closeB).toHaveBeenCalledOnce();
	});

	it("pins a local run even before its browser launches (waiting for profile consent)", async () => {
		let active = false;
		const sessions = new BrowserSessions(dir(), true, () => false, () => active);
		await sessions.run("a", "headed", true, async () => { active = true; });
		await sessions.run("a", "headless", false, async () => expect(sessions.current.headless).toBe(false));
		await expect(sessions.run("a", "headless", true, async () => undefined)).rejects.toThrow(/current task finishes/);
	});

	it("serializes same-agent browser requests but health and another agent remain responsive", async () => {
		const sessions = new BrowserSessions(dir(), true, () => false);
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		let started!: () => void;
		const entered = new Promise<void>((resolve) => { started = resolve; });
		const first = sessions.run("a", "headed", true, async () => { started(); await barrier; });
		await entered;
		let secondRan = false;
		const second = sessions.run("a", "headed", false, async () => { secondRan = true; });
		await sessions.run("a", undefined, false, async () => expect(sessions.current.headless).toBe(false), false);
		await sessions.run("b", "headless", true, async () => expect(sessions.current.headless).toBe(true));
		expect(secondRan).toBe(false);
		release();
		await Promise.all([first, second]);
		expect(secondRan).toBe(true);
	});

	it("keeps recorded actions after recycling the browser for a mode change", async () => {
		const sessions = new BrowserSessions(dir(), true, () => false);
		await sessions.run("a", "headed", true, async () => {
			sessions.current.calls.record({ subject: { kind: "runtime_task", id: "old" }, tool: "browser_navigate", args: { url: "https://example.org" }, startedAt: Date.now(), outcome: "ok", internal: false });
		});
		await sessions.run("a", "headless", true, async () => expect(sessions.current.calls.page({ kind: "runtime_task", id: "old" }, 0).calls).toHaveLength(1));
	});

	it("seeds existing sign-ins without locks or overwriting an agent's later profile", () => {
		const legacy = dir();
		const agent = join(legacy, "agent-browsers", "a");
		mkdirSync(join(legacy, "chrome-profile", "Default"), { recursive: true });
		writeFileSync(join(legacy, "chrome-profile", "Default", "Cookies"), "legacy-cookies");
		writeFileSync(join(legacy, "chrome-profile", "SingletonLock"), "locked");
		seedAgentBrowserProfiles(legacy, agent);
		const cookie = join(agent, "chrome-profile", "Default", "Cookies");
		expect(readFileSync(cookie, "utf8")).toBe("legacy-cookies");
		expect(() => readFileSync(join(agent, "chrome-profile", "SingletonLock"))).toThrow();
		writeFileSync(cookie, "agent-cookies");
		seedAgentBrowserProfiles(legacy, agent);
		expect(readFileSync(cookie, "utf8")).toBe("agent-cookies");
		expect(readFileSync(join(legacy, "chrome-profile", "Default", "Cookies"), "utf8")).toBe("legacy-cookies");
	});
});
