/**
 * What the git and gh guards share to install on native Windows (#1719, #1653).
 *
 * The shims are POSIX `sh` text and stay that way: on POSIX nothing here changes a byte. Windows
 * differs in four ways, each handled once, here:
 *
 *   - PATH separates with `;`, not `:`, and the variable may be spelled `Path`.
 *   - A real tool is `git.exe` / `gh.exe`; a plain `git` file is only an executable to an MSYS shell.
 *   - Process spawn and `cmd.exe` resolve `.exe`/`.com` (spawn) or `PATHEXT` (cmd, PowerShell), never a
 *     `#!` line. So beside the extensionless script (found by Git Bash, which is what an Engine
 *     runs in) the installer writes `<name>.cmd`, which hands the same script to Git for Windows' `sh`.
 *   - A shell must receive forward-slash paths.
 *
 * The `.cmd` carries no logic of its own: one line that runs the script, so there is exactly one
 * policy to review and one set of tests to trust.
 */

import { accessSync, constants, existsSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const win = () => process.platform === "win32";

/** A path as a POSIX shell wants it. Identity off Windows. */
export const shellPath = (value: string) => (win() ? value.replaceAll("\\", "/") : value);

/** Is `dir` (a PATH entry) inside `root`? Case and slash direction do not matter on Windows. */
function under(dir: string, root: string): boolean {
	if (!win()) return dir.startsWith(root);
	const norm = (v: string) => v.replaceAll("\\", "/").toLowerCase();
	return norm(dir).startsWith(norm(root));
}

/** First executable `name` on `path` that is not under `skip` (our own shims). */
export function findOnPath(name: string, path: string | undefined, skip: string): string | null {
	const names = win() ? [`${name}.exe`, name] : [name];
	for (const dir of (path ?? "").split(delimiter)) {
		if (!dir || (skip && under(dir, skip))) continue;
		for (const file of names) {
			const candidate = join(dir, file);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				/* not here — keep looking */
			}
		}
	}
	return null;
}

/** The environment key that holds PATH: `Path` on a Windows env copied out of `process.env`. */
export function pathKey(env: NodeJS.ProcessEnv): string {
	if (!win()) return "PATH";
	return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/** `env` with `dir` first on PATH, under whatever name PATH already has. */
export function withPathFront(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
	const key = pathKey(env);
	return { ...env, [key]: `${dir}${delimiter}${env[key] ?? ""}` };
}

/**
 * The `sh` that runs the script on Windows: the one shipped with the git being guarded
 * (`<git>/usr/bin/sh.exe`, `<git>/bin/sh.exe`), else any `sh` on PATH. Null off Windows or if none.
 */
export function findPosixShell(realTool: string, path: string | undefined): string | null {
	if (!win()) return null;
	let dir = dirname(realTool);
	for (let i = 0; i < 4; i++, dir = dirname(dir)) {
		for (const rel of [["usr", "bin", "sh.exe"], ["bin", "sh.exe"]]) {
			const candidate = join(dir, ...rel);
			if (existsSync(candidate)) return candidate;
		}
	}
	return findOnPath("sh", path, "");
}

/** Install `script` as `<dir>/<name>`, plus `<name>.cmd` on Windows. Existing files are left alone. */
export function writeShim(dir: string, name: string, script: string, sh: string | null): void {
	const shim = join(dir, name);
	if (!existsSync(shim)) writeFileSync(shim, script, { mode: 0o755 });
	if (!win() || !sh) return;
	const cmd = join(dir, `${name}.cmd`);
	if (existsSync(cmd)) return;
	const text = ["@echo off", `rem ProAgentStore ${name} guard - GENERATED; runs ${name} beside it unchanged.`, `"${shellPath(sh)}" "${shellPath(shim)}" %*`, "exit /b %ERRORLEVEL%", ""].join("\r\n");
	writeFileSync(cmd, text);
}
