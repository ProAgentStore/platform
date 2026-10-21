/**
 * The real machine behind the Windows runner modules (#1272): thin, effect-only glue, kept out of the logic modules so they stay
 * testable. Nothing here decides anything — every policy is in windows-runner-root / -migration / -readiness. It is only ever built
 * on Windows (`liveWindowsDeps` throws elsewhere), and it is the part that needs a person on a real machine to verify
 * (platform-docs/windows.md, "Verifying a Windows runner").
 */
import { execFile, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { promisify } from "node:util";
import type { MigrationDeps } from "./windows-runner-migration.js";
import { scheduledTaskProbe, type WindowsRootDeps } from "./windows-runner-root.js";
import type { WindowsReadinessDeps } from "./windows-runner-readiness.js";

const run = promisify(execFile);

export interface LiveWindows {
	root: WindowsRootDeps;
	migration: MigrationDeps;
	readiness: WindowsReadinessDeps;
}

export function liveWindowsDeps(): LiveWindows {
	if (process.platform !== "win32") throw new Error("The Windows runner deps only exist on Windows.");
	const programData = process.env.ProgramData || "C:\\ProgramData";
	const userProfile = process.env.USERPROFILE || homedir();
	const exec = async (file: string, args: string[], cwd?: string) => {
		try {
			return await run(file, args, { cwd, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, shell: file.toLowerCase().endsWith(".cmd") });
		} catch (e) {
			const err = e as { stderr?: string; stdout?: string; message?: string };
			// File name and output only — the command line may carry a registration token.
			throw new Error(`${file.split(/[\\/]/).pop()} failed: ${(err.stderr || err.stdout || err.message || "").trim().split("\n").slice(-5).join(" | ")}`);
		}
	};
	const root: WindowsRootDeps = {
		platform: "win32",
		programData,
		userProfile,
		exists: existsSync,
		mkdir: (p) => mkdirSync(p, { recursive: true }),
		exec: (file, args) => exec(file, args),
		writeText: (p, content) => writeFileSync(p, content),
		removeFile: (p) => {
			try {
				unlinkSync(p);
			} catch {
				/* already gone */
			}
		},
		probeAs: scheduledTaskProbe((file, args) => exec(file, args)),
	};
	const migration: MigrationDeps = {
		...root,
		home: userProfile,
		exec,
		readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
		listDirs: (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
		copyTree: async (src, dest, exclude) => {
			const skip = new Set(exclude.map((x) => x.toLowerCase()));
			cpSync(src, dest, { recursive: true, filter: (from) => !skip.has(win32.basename(from).toLowerCase()) });
		},
		removeTree: async (p) => rmSync(p, { recursive: true, force: true }),
		// A job is a Runner.Worker process started from this folder's bin.
		busy: async (dir) => {
			const ps = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'" | Where-Object { $_.ExecutablePath -like '${dir.replace(/'/g, "''")}\\*' } | Measure-Object).Count`], { encoding: "utf8", timeout: 15_000 });
			return ps.status === 0 && Number.parseInt(String(ps.stdout).trim(), 10) > 0;
		},
		now: Date.now,
	};
	const readiness: WindowsReadinessDeps = {
		platform: "win32",
		userProfile,
		probe: (file, args) => {
			const r = spawnSync(file, args, { encoding: "utf8", timeout: 5000 });
			return r.status === 0 ? String(r.stdout).trim() : null;
		},
		whichPath: (bin) => {
			const r = spawnSync("where", [bin], { encoding: "utf8", timeout: 5000 });
			return r.status === 0 ? (String(r.stdout).split(/\r?\n/)[0]?.trim() || null) : null;
		},
	};
	return { root, migration, readiness };
}
