import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchRunnerBrowser } from "./browser-launch.js";

const io = vi.hoisted(() => ({ target: "", code: "", attempts: 0, launch: vi.fn() }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs, rmSync: (...args: Parameters<typeof fs.rmSync>) => {
		if (args[0] === io.target && io.code) throw Object.assign(new Error("profile handle is busy"), { code: io.code });
		return fs.rmSync(...args);
	} };
});
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => {
		if (args[0] === io.target) {
			io.attempts++;
			if (io.code) throw Object.assign(new Error("profile handle is busy"), { code: io.code });
		}
		return fs.rm(...args);
	} };
});
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: io.launch, executablePath: () => "/test/chromium" } }));

let root: string;
let ctx: EventEmitter & { close: ReturnType<typeof vi.fn>; browser(): { version(): string } };
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pags-profile-cleanup-"));
	io.target = "";
	io.code = "";
	io.attempts = 0;
	ctx = Object.assign(new EventEmitter(), {
		close: vi.fn(async () => { ctx.emit("close"); }),
		browser: () => ({ version: () => "test" }),
	});
	io.launch.mockReset().mockImplementation(async (dir: string) => { io.target = dir; return ctx; });
	vi.stubEnv("PAGS_SKIP_PLAYWRIGHT_INSTALL", "1");
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	io.code = "";
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
const launch = (profilePolicy: "ephemeral" | "persistent" = "ephemeral") => launchRunnerBrowser({
	headless: true, engine: "chromium", preference: "isolated", profilePolicy, profileRoot: root,
});

describe("temporary profile cleanup cannot crash browser lifecycle events", () => {
	it.each(["ENOTEMPTY", "EPERM", "EBUSY"])("contains exhausted %s cleanup on close and shares it with stop", async (code) => {
		const owned = await launch();
		io.code = code;
		expect(() => ctx.emit("close")).not.toThrow();
		expect(owned.receipt.active).toBe(false);
		await expect(owned.stop()).resolves.toBeUndefined();
		await owned.stop();
		expect(io.attempts).toBe(1);
		expect(existsSync(owned.profileDir)).toBe(true);
		expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`cleanup failed (${code})`));
	});

	it("waits for successful cleanup on stop without removing a sibling profile", async () => {
		const owned = await launch();
		const sibling = join(root, "owner-profile");
		writeFileSync(sibling, "retained");
		await owned.stop();
		expect(existsSync(owned.profileDir)).toBe(false);
		expect(existsSync(sibling)).toBe(true);
		expect(io.attempts).toBe(1);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("preserves the original launch failure when cleanup also fails", async () => {
		io.launch.mockImplementation(async (dir: string) => {
			io.target = dir;
			io.code = "EPERM";
			throw new Error("browser executable unavailable");
		});
		await expect(launch()).rejects.toThrow("browser executable unavailable");
		expect(io.attempts).toBe(1);
		expect(console.warn).toHaveBeenCalledOnce();
	});

	it("never removes persistent profiles on close or stop", async () => {
		const owned = await launch("persistent");
		io.code = "EPERM";
		ctx.emit("close");
		await owned.stop();
		expect(existsSync(owned.profileDir)).toBe(true);
		expect(io.attempts).toBe(0);
		expect(console.warn).not.toHaveBeenCalled();
	});
});
