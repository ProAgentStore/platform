import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { clean, requestRunner } from "./http.js";
import type { RunnerRequestOptions, RunnerStartOptions } from "./types.js";

export const CLI_VERSION: string = (() => { try { return (createRequire(import.meta.url)("../package.json") as { version: string }).version; } catch { return ""; } })();

/** First free TCP port at/after `start` on 127.0.0.1 — avoids EADDRINUSE collisions. */
export async function findFreePort(start: number): Promise<number> {
	for (let p = start; p < start + 25; p++) {
		const free = await new Promise<boolean>((res) => {
			const s = createServer();
			s.once("error", () => res(false));
			s.once("listening", () => s.close(() => res(true)));
			s.listen(p, "127.0.0.1");
		});
		if (free) return p;
	}
	return start;
}

/** Where the runtime looks first when no `--port` is given. */
export const DEFAULT_RUNNER_PORT = 49171;

/**
 * The port `runner connect` serves on (#1296). An explicit `--port` is honoured exactly — a collision on it is reported as
 * one, never quietly moved. With none, the first free port from {@link DEFAULT_RUNNER_PORT}. The option must therefore carry NO
 * commander default: a default always populates `opts.port`, and this fallback was unreachable (the bug).
 */
export async function selectConnectPort(requested: string | undefined, find: (start: number) => Promise<number> = findFreePort): Promise<string> {
	return clean(requested) || String(await find(DEFAULT_RUNNER_PORT));
}

/**
 * The runtime's bearer token never goes on its command line (#1182): `--token <t>` is in the process table, where `ps` shows it to every
 * other user on the host - and the token plus no `Origin` is all a request to the runtime's 127.0.0.1 port needs. It travels in the
 * child's ENVIRONMENT instead (`PAGS_RUNNER_TOKEN`, which the runtime already reads), readable only by the same user. The runtime keeps
 * it out of every engine and tool it starts (`PLATFORM_CREDENTIAL_ENV`).
 */
export function runnerSecretEnv(opts: RunnerStartOptions): { PAGS_RUNNER_TOKEN?: string } {
	const token = clean(opts.token);
	return token ? { PAGS_RUNNER_TOKEN: token } : {};
}

/** The runtime's arguments: everything EXCEPT the token (see {@link runnerSecretEnv}). */
export function buildRunnerArgs(opts: RunnerStartOptions): string[] {
	const args: string[] = [];
	if (clean(opts.host)) args.push("--host", clean(opts.host) as string);
	if (clean(opts.port)) args.push("--port", clean(opts.port) as string);
	if (clean(opts.dataDir)) args.push("--data-dir", clean(opts.dataDir) as string);
	if (clean(opts.instanceId)) args.push("--instance-id", clean(opts.instanceId) as string);
	if (opts.headless) args.push("--headless");
	return args;
}

function findWorkspaceRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

/** Running from a source checkout (`pnpm dev`) rather than an npm install — the same test `runnerSpawnSpec` makes. */
export function runsFromSource(): boolean {
	return existsSync(resolve(findWorkspaceRoot(), "packages", "browser-runner", "src", "index.ts"));
}

export function bundledRunnerPath(): string {
	return fileURLToPath(new URL("./browser-runner/index.js", import.meta.url));
}

/**
 * Whether spawning `command` needs a shell. Only a bare name on Windows does — `pnpm` and
 * `pags-browser-runner` are `.cmd` shims that only `cmd.exe` resolves. An absolute path such as
 * `process.execPath` must NOT go through the shell: Node joins command + args into one unquoted
 * `cmd.exe` string, so `C:\Program Files\nodejs\node.exe` runs `C:\Program` (#1033).
 */
export function spawnNeedsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" && !win32.isAbsolute(command);
}

export function runnerSpawnSpec(opts: RunnerStartOptions): { command: string; args: string[]; cwd: string; shell: boolean; env: { PAGS_RUNNER_TOKEN?: string } } {
	const root = findWorkspaceRoot();
	const localPackage = resolve(root, "packages", "browser-runner", "src", "index.ts");
	const bundledPackage = bundledRunnerPath();
	const runnerArgs = buildRunnerArgs(opts);
	let cwd = root;
	let command = "pags-browser-runner";
	let args = runnerArgs;

	if (existsSync(localPackage)) {
		command = "pnpm";
		args = ["--filter", "@proagentstore/browser-runner", "dev", "--", ...runnerArgs];
	} else if (existsSync(bundledPackage)) {
		cwd = process.cwd();
		command = process.execPath;
		args = [bundledPackage, ...runnerArgs];
	}
	return { command, args, cwd, shell: spawnNeedsShell(command), env: runnerSecretEnv(opts) };
}

export function startRunnerForeground(opts: RunnerStartOptions): Promise<void> {
	const spec = runnerSpawnSpec(opts);

	return new Promise((resolvePromise, reject) => {
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			stdio: "inherit",
			shell: spec.shell,
			env: { ...process.env, ...spec.env },
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code && code !== 0) reject(new Error(`runner exited with code ${code}`));
			else resolvePromise();
		});
	});
}

export async function waitForLocalRunner(opts: RunnerRequestOptions, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	let lastError: unknown;
	while (Date.now() - started < timeoutMs) {
		try {
			await requestRunner("GET", "/health", opts);
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
		}
	}
	throw new Error(`runner did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
