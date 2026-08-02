import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

export function buildRunnerArgs(opts: RunnerStartOptions): string[] {
	const args: string[] = [];
	if (clean(opts.host)) args.push("--host", clean(opts.host) as string);
	if (clean(opts.port)) args.push("--port", clean(opts.port) as string);
	if (clean(opts.dataDir)) args.push("--data-dir", clean(opts.dataDir) as string);
	if (clean(opts.token)) args.push("--token", clean(opts.token) as string);
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

export function bundledRunnerPath(): string {
	return fileURLToPath(new URL("./browser-runner/index.js", import.meta.url));
}

export function runnerSpawnSpec(opts: RunnerStartOptions): { command: string; args: string[]; cwd: string } {
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
	return { command, args, cwd };
}

export function startRunnerForeground(opts: RunnerStartOptions): Promise<void> {
	const spec = runnerSpawnSpec(opts);

	return new Promise((resolvePromise, reject) => {
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			stdio: "inherit",
			shell: process.platform === "win32",
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
