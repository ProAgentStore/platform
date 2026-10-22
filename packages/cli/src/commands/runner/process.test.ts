/**
 * Spawning the local runtime on Windows (#1033): an absolute command such as `process.execPath`
 * under `C:\Program Files\nodejs` must not go through `cmd.exe`, which splits it at the space.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const existsMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", async (orig) => ({ ...(await orig<typeof import("node:fs")>()), existsSync: existsMock }));

import { buildRunnerArgs, bundledRunnerPath, runnerSecretEnv, runnerSpawnSpec, spawnNeedsShell, startRunnerForeground } from "./process.js";

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

describe("the runtime's bearer token never reaches its argv (#1182)", () => {
	const SECRET = "pags_runner_0123456789-secret-shape-AbCdEf";

	beforeEach(() => {
		existsMock.mockImplementation((p: string) => p === bundledRunnerPath());
		spawnMock.mockReset();
	});

	it("buildRunnerArgs and the spawn spec carry no token in args, whatever the source layout", () => {
		expect(buildRunnerArgs({ token: SECRET, host: "127.0.0.1", port: "49171" })).not.toContain(SECRET);
		expect(buildRunnerArgs({ token: SECRET })).not.toContain("--token");
		for (const bundled of [true, false]) {
			existsMock.mockImplementation((p: string) => bundled && p === bundledRunnerPath());
			const spec = runnerSpawnSpec({ token: SECRET, headless: true });
			expect(JSON.stringify([spec.command, ...spec.args])).not.toContain(SECRET);
		}
	});

	it("travels in the child's environment instead, and only when there is one", () => {
		expect(runnerSecretEnv({ token: SECRET })).toEqual({ PAGS_RUNNER_TOKEN: SECRET });
		expect(runnerSecretEnv({ token: "  " })).toEqual({});
		expect(runnerSecretEnv({})).toEqual({});
		expect(runnerSpawnSpec({ token: SECRET }).env).toEqual({ PAGS_RUNNER_TOKEN: SECRET });
	});

	it("startRunnerForeground hands the token to the child through env, not args", async () => {
		const child = new EventEmitter();
		spawnMock.mockReturnValue(child);
		const done = startRunnerForeground({ token: SECRET, headless: true });
		setImmediate(() => child.emit("exit", 0));
		await done;
		const [, args, options] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
		expect(JSON.stringify(args)).not.toContain(SECRET);
		expect(options.env.PAGS_RUNNER_TOKEN).toBe(SECRET);
	});

	it("the connect command spawns with the spec's env (source check - the action is a long-running process)", () => {
		const src = readFileSync(new URL("./command.ts", import.meta.url), "utf-8");
		expect(src).toMatch(/\.\.\.spec\.env,\s*\n\s*PAGS_RUNNER_BUILD/);
	});
});
