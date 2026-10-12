/**
 * Spawning the local runtime on Windows (#1033): an absolute command such as `process.execPath`
 * under `C:\Program Files\nodejs` must not go through `cmd.exe`, which splits it at the space.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const existsMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", async (orig) => ({ ...(await orig<typeof import("node:fs")>()), existsSync: existsMock }));

import { bundledRunnerPath, runnerSpawnSpec, spawnNeedsShell, startRunnerForeground } from "./process.js";

const SPACED_NODE = "C:\\Program Files\\nodejs\\node.exe";

describe("spawnNeedsShell (#1033)", () => {
	it("never uses a shell for an absolute Windows path, even one with a space", () => {
		expect(spawnNeedsShell(SPACED_NODE, "win32")).toBe(false);
		expect(spawnNeedsShell("\\\\server\\share\\node.exe", "win32")).toBe(false);
	});

	it("keeps the shell for bare names on Windows so .cmd shims resolve", () => {
		expect(spawnNeedsShell("pnpm", "win32")).toBe(true);
		expect(spawnNeedsShell("pags-browser-runner", "win32")).toBe(true);
	});

	it("never uses a shell off Windows", () => {
		expect(spawnNeedsShell("pnpm", "darwin")).toBe(false);
		expect(spawnNeedsShell("/usr/local/bin/node", "linux")).toBe(false);
	});
});

describe("runnerSpawnSpec + spawn on win32 with a spaced execPath (#1033)", () => {
	const realPlatform = process.platform;
	const realExecPath = process.execPath;

	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		Object.defineProperty(process, "execPath", { value: SPACED_NODE, configurable: true });
		// The npm-install layout: no source checkout, only the bundled runtime.
		existsMock.mockImplementation((p: string) => p === bundledRunnerPath());
		spawnMock.mockReset();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
		Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
	});

	it("runs the bundled runtime with process.execPath and no shell", () => {
		const spec = runnerSpawnSpec({ headless: true });
		expect(spec.command).toBe(SPACED_NODE);
		expect(spec.args).toEqual([bundledRunnerPath(), "--headless"]);
		expect(spec.shell).toBe(false);
	});

	it("falls back to the pags-browser-runner shim through the shell", () => {
		existsMock.mockReturnValue(false);
		const spec = runnerSpawnSpec({});
		expect(spec.command).toBe("pags-browser-runner");
		expect(spec.shell).toBe(true);
	});

	it("startRunnerForeground spawns the spaced node path without a shell", async () => {
		const child = new EventEmitter();
		spawnMock.mockReturnValue(child);
		const done = startRunnerForeground({ headless: true });
		setImmediate(() => child.emit("exit", 0));
		await done;
		expect(spawnMock).toHaveBeenCalledWith(SPACED_NODE, [bundledRunnerPath(), "--headless"], expect.objectContaining({ shell: false }));
	});
});
