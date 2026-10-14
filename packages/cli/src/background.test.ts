/**
 * #499 — the background mode's moving parts, on real files and a real detached process.
 *
 * Invariants held here: a background runner's output lands in its log file (there is no window to
 * read); it is detached into its own process group, so closing the terminal does not take it down;
 * "running" is reported only once the child holds the lock AND answers as itself; a restart waits,
 * bounded, for the old holder to leave and never takes a live one; and the restart command a remote
 * update runs is the same `pags up --background`, quoted for the shell that runs it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backgroundLogPath,
	backgroundRestartCommand,
	backgroundStatePath,
	readBackgroundState,
	rotateLog,
	shellQuote,
	spawnDetached,
	tailLines,
	waitForBackgroundHolder,
	waitUntilTakeable,
	writeBackgroundState,
} from "./background.js";
import { pidAlive, type HolderVerdict, type RunnerLockFile } from "./runner-lock.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-bg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lock = (pid: number) => ({ pid }) as RunnerLockFile;
const until = async (ok: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	return ok();
};

describe("the detached runner process", () => {
	it("writes its stdout AND stderr to the log, and leads its own process group (no SIGHUP from the terminal)", async () => {
		const log = join(dir, "logs", "runner.log");
		const pid = spawnDetached(process.execPath, ["-e", "console.log('relay connected'); console.error('a warning'); setTimeout(() => {}, 60000)"], process.env, log);
		try {
			expect(pidAlive(pid)).toBe(true);
			expect(await until(() => existsSync(log) && /a warning/.test(readFileSync(log, "utf-8")))).toBe(true);
			expect(readFileSync(log, "utf-8")).toMatch(/relay connected/);
			if (process.platform !== "win32") {
				const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf-8" }).trim();
				expect(Number(pgid)).toBe(pid);
			}
		} finally {
			process.kill(pid, "SIGKILL");
		}
	});

	it("rotates a log over the cap to `.1` before the next runner starts writing", () => {
		const log = join(dir, "runner.log");
		writeFileSync(log, "x".repeat(20));
		expect(rotateLog(log, 10)).toBe(true);
		expect(readFileSync(`${log}.1`, "utf-8")).toHaveLength(20);
		expect(existsSync(log)).toBe(false);
		expect(rotateLog(log, 10), "no log yet: nothing to rotate").toBe(false);
	});

	it("tails the last lines, and says there is no log rather than an empty one", () => {
		const log = join(dir, "runner.log");
		expect(tailLines(log, 5)).toBeNull();
		writeFileSync(log, "a\nb\nc\n");
		expect(tailLines(log, 2)).toEqual(["b", "c"]);
		expect(tailLines(log, 50)).toEqual(["a", "b", "c"]);
	});
});

describe("where it keeps its files", () => {
	it("per account, under the config dir, never spelling the account out", () => {
		const env = { PAGS_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
		expect(backgroundLogPath("serge-ivo", env)).toMatch(new RegExp(`^${dir}/logs/runner-[0-9a-f]{12}\\.log$`));
		expect(backgroundLogPath("serge-ivo", env)).not.toBe(backgroundLogPath("someone-else", env));
		expect(backgroundStatePath("serge-ivo", env)).not.toContain("serge-ivo");
	});

	it("the state round-trips, and a foreign or broken file reads as none", () => {
		const path = join(dir, "background.json");
		const state = { v: 1 as const, pid: 42, startedAt: 1, logPath: "/l", args: ["up", "--background"], instances: [{ id: "i1", name: "Coder" }], watching: true };
		writeBackgroundState(path, state);
		expect(readBackgroundState(path)).toEqual(state);
		writeFileSync(path, "{oops");
		expect(readBackgroundState(path)).toBeNull();
		writeFileSync(path, JSON.stringify({ v: 2, pid: 1 }));
		expect(readBackgroundState(path)).toBeNull();
	});
});

describe("ready means holding the lock and answering as itself", () => {
	it("live only when the lock names THIS child and its health check matches", async () => {
		const reads: Array<{ lock: RunnerLockFile | null; verdict: HolderVerdict }> = [
			{ lock: null, verdict: "unknown" },
			{ lock: lock(77), verdict: "live" }, // somebody else's runner — not ours
			{ lock: lock(42), verdict: "unresponsive" },
			{ lock: lock(42), verdict: "live" },
		];
		let i = 0;
		const outcome = await waitForBackgroundHolder(42, async () => reads[Math.min(i++, reads.length - 1)], () => true, { intervalMs: 1 });
		expect(outcome).toBe("live");
		expect(i).toBe(4);
	});

	it("exited when the child dies first — never reported as running", async () => {
		let alive = true;
		const outcome = await waitForBackgroundHolder(42, async () => {
			alive = false;
			return { lock: null, verdict: "unknown" };
		}, () => alive, { intervalMs: 1 });
		expect(outcome).toBe("exited");
	});

	it("timeout when it stays alive but never proves itself", async () => {
		expect(await waitForBackgroundHolder(42, async () => ({ lock: null, verdict: "unknown" }), () => true, { timeoutMs: 20, intervalMs: 5 })).toBe("timeout");
	});
});

describe("a restart after a remote update", () => {
	it("waits for the old holder to leave", async () => {
		let n = 0;
		const ok = await waitUntilTakeable(async () => (++n < 3 ? { lock: lock(1), verdict: "live" } : { lock: lock(1), verdict: "dead" }), { intervalMs: 1 });
		expect(ok).toBe(true);
		expect(n).toBe(3);
	});

	it("gives up on a holder that stays — it is a real one, and `pags up` then refuses as usual", async () => {
		expect(await waitUntilTakeable(async () => ({ lock: lock(1), verdict: "live" }), { timeoutMs: 20, intervalMs: 5 })).toBe(false);
		expect(await waitUntilTakeable(async () => ({ lock: lock(1), verdict: "unresponsive" }), { timeoutMs: 20, intervalMs: 5 }), "slow is not dead (#896)").toBe(false);
	});

	it("re-runs the same `pags up` flags with --background, quoted for its shell", () => {
		expect(backgroundRestartCommand("/usr/local/bin/node", "/opt/my tools/pags", ["up", "--instance", "abc"], "darwin")).toBe(
			"PAGS_BACKGROUND_RESTART=1 /usr/local/bin/node '/opt/my tools/pags' up --instance abc --background",
		);
		expect(backgroundRestartCommand("C:\\node.exe", "C:\\pags.js", ["up"], "win32")).toBe('set PAGS_BACKGROUND_RESTART=1&& "C:\\node.exe" "C:\\pags.js" "up" "--background"');
		expect(shellQuote("it's", "linux")).toBe(`'it'\\''s'`);
	});
});
