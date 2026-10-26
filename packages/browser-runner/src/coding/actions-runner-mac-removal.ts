/** Fail-closed local check before a user-context relay deregisters a macOS runner. */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

interface RemovalProbe {
	exists(path: string): boolean;
	plists(root: string): string[] | null;
	parsePlist(path: string): unknown;
	runnerProcessCwds(): string[] | null;
}

const liveProbe: RemovalProbe = {
	exists: existsSync,
	plists: (root) => {
		try { return existsSync(root) ? readdirSync(root).filter((name) => name.endsWith(".plist")).map((name) => join(root, name)) : []; }
		catch { return null; }
	},
	parsePlist: (path) => {
		const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8", timeout: 5000 });
		if (r.status !== 0) return null;
		try { return JSON.parse(String(r.stdout)); } catch { return null; }
	},
	runnerProcessCwds: () => {
		const r = spawnSync("pgrep", ["-f", "Runner\\.Listener|Runner\\.Worker|runsvc\\.sh"], { encoding: "utf8", timeout: 5000 });
		if (r.status === 1) return [];
		if (r.status !== 0) return null;
		const pids = String(r.stdout).trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid));
		if (!pids.length) return null;
		const paths: string[] = [];
		for (const pid of pids) {
			const cwd = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 5000 });
			if (cwd.status !== 0) {
				try { process.kill(Number(pid), 0); return null; }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return null; continue; }
			}
			const found = String(cwd.stdout).split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
			if (!found.length) return null;
			paths.push(...found);
		}
		return paths;
	},
};

/** A user-writable approval receipt alone is never evidence that the service stopped. */
export function macRunnerServiceRemoved(dir: string, home: string, probe: RemovalProbe = liveProbe): boolean {
	const label = `online.proagentstore.actions.${basename(dir).toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
	if (probe.exists(`/Library/LaunchDaemons/${label}.plist`)) return false;
	for (const root of ["/Library/LaunchDaemons", join(home, "Library", "LaunchAgents")]) {
		const plists = probe.plists(root);
		if (!plists) return false;
		for (const path of plists) {
			const value = probe.parsePlist(path) as { WorkingDirectory?: unknown; ProgramArguments?: unknown } | null;
			if (value?.WorkingDirectory === dir || (Array.isArray(value?.ProgramArguments) && value.ProgramArguments.some((arg) => arg === dir || arg === join(dir, "runsvc.sh") || arg === join(dir, "run.sh")))) return false;
		}
	}
	const processes = probe.runnerProcessCwds();
	return !!processes && !processes.some((cwd) => cwd === dir || cwd.startsWith(`${dir}/`));
}
