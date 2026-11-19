/** #1151 — a command-started restart is verified, and started again if no runner came up. Real processes, real lock files. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GuardConfig, guardScript, startRestartGuard } from "./restart-guard.js";

let dir: string;
let locks: string;
let log: string;
let script: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-guard-"));
	locks = join(dir, "locks");
	mkdirSync(locks);
	log = join(dir, "update.log");
	script = join(dir, "guard.mjs");
	writeFileSync(script, guardScript());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Timing = Omit<GuardConfig, "command" | "oldPid" | "lockDir" | "log">;
/**
 * A window has to cover a COLD NODE START of the "runner" the guard launches (#1482). 700 ms did on a quiet machine and not
 * on a busy one: the 2nd re-run's lock landed after the 3rd window closed and the guard gave up (exit 1) with the invariant
 * intact and the fixture wrong. A window that sees a live runner returns at once, so a generous one costs nothing on those
 * paths; only a window that must EXPIRE (nothing came up) pays it in full, so only those tests keep it short.
 */
const WAIT_FOR_LIVE: Timing = { attempts: 3, windowMs: 8_000, exitWaitMs: 2_000, pollMs: 50 };
/** The windows that must run out are the cost; the command there never starts a runner, so its startup time cannot matter. */
const EXPIRES: Timing = { attempts: 3, windowMs: 700, exitWaitMs: 2_000, pollMs: 50 };

/** A "runner": a script that counts its starts and, from the `upOn`-th, writes a lock naming its own live pid and stays alive a few seconds. */
const runnerCommand = (counter: string, upOn: number, startDelayMs = 0) => {
	const file = join(dir, `runner-${upOn}.cjs`);
	writeFileSync(
		file,
		`const fs=require("fs");const c=${JSON.stringify(counter)};const n=(fs.existsSync(c)?+fs.readFileSync(c,"utf8"):0)+1;fs.writeFileSync(c,String(n));
const up=()=>{fs.writeFileSync(${JSON.stringify(join(locks, "up-abc.lock"))},JSON.stringify({pid:process.pid}));setTimeout(()=>{},6000)};
if(n>=${upOn}){${startDelayMs}?setTimeout(up,${startDelayMs}):up()}`,
	);
	return `"${process.execPath}" "${file}"`;
};

function runGuard(command: string, oldPid: number, timing: Timing = WAIT_FOR_LIVE) {
	const config: GuardConfig = { command, oldPid, lockDir: locks, log, ...timing };
	return new Promise<number | null>((ok) => {
		const child = spawn(process.execPath, [script, JSON.stringify(config)], { stdio: "ignore" });
		child.on("close", ok);
	});
}
const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

describe("the restart guard", () => {
	it("sees a live runner that is not the old one and stops: the command is not run again", async () => {
		const counter = join(dir, "starts");
		// the command was already started by the leaving runner (simulated: run it once here)
		spawn(runnerCommand(counter, 1), { shell: true, stdio: "ignore", detached: true }).unref();
		const code = await runGuard(runnerCommand(counter, 1), 999_999_999);
		expect(code, logText()).toBe(0);
		expect(logText()).toMatch(/guard: the restarted runner is up/);
		expect(readFileSync(counter, "utf8")).toBe("1");
	});

	it("starts the command again when nothing comes up, until it does", async () => {
		const counter = join(dir, "starts");
		// the first start (by the caller, not simulated here) never came up; the guard's 1st re-run does not either; its 2nd does
		// Two windows must run out (starts 1 and 2 of the guard's re-runs) before the 2nd re-run's runner is seen.
		const code = await runGuard(runnerCommand(counter, 2), 999_999_999, { ...WAIT_FOR_LIVE, windowMs: 3_000 });
		expect(code, logText()).toBe(0);
		expect(logText()).toMatch(/starting it again \(2\/3\)/);
		expect(logText()).toMatch(/starting it again \(3\/3\)/);
		expect(logText()).toMatch(/the runner is up after 2 more start/);
		expect(Number(readFileSync(counter, "utf8"))).toBe(2);
	});

	it("a runner slower to start than one old window is still seen and not restarted again (#1482)", async () => {
		// The fixture's own flake, made deterministic: the runner takes 1.2 s to write its lock — longer than the 700 ms the
		// windows used to be. A live replacement must be detected, never replaced; the retry invariant is unchanged.
		const counter = join(dir, "starts");
		spawn(runnerCommand(counter, 1, 1_200), { shell: true, stdio: "ignore", detached: true }).unref();
		const code = await runGuard(runnerCommand(counter, 1, 1_200), 999_999_999, { ...WAIT_FOR_LIVE, windowMs: 4_000 });
		expect(code, logText()).toBe(0);
		expect(logText()).toMatch(/guard: the restarted runner is up/);
		expect(logText()).not.toMatch(/starting it again/);
		expect(readFileSync(counter, "utf8")).toBe("1");
	});

	it("gives up after its attempts, says so in the update log, and exits non-zero", async () => {
		const code = await runGuard(`"${process.execPath}" -e "process.exit(1)"`, 999_999_999, EXPIRES);
		expect(code, logText()).toBe(1);
		const text = logText();
		expect(text).toMatch(/starting it again \(2\/3\)/);
		expect(text).toMatch(/starting it again \(3\/3\)/);
		expect(text).toMatch(/GAVE UP: no runner came up after 3 start\(s\)/);
	});

	it("does not count the old runner's own lock, or a lock whose process is gone", async () => {
		writeFileSync(join(locks, "up-old.lock"), JSON.stringify({ pid: process.pid })); // alive, but it is the old one
		writeFileSync(join(locks, "up-dead.lock"), JSON.stringify({ pid: 2_147_483_000 })); // not alive
		writeFileSync(join(locks, "up-junk.lock"), "{not json");
		const code = await runGuard(`"${process.execPath}" -e "process.exit(1)"`, process.pid, EXPIRES);
		expect(code, logText()).toBe(1);
		expect(logText()).toMatch(/GAVE UP/);
	});

	it("waits for the old runner to leave before it starts judging", async () => {
		const old = spawn(process.execPath, ["-e", "setTimeout(()=>{},900)"], { stdio: "ignore" });
		const started = Date.now();
		const counter = join(dir, "starts");
		spawn(runnerCommand(counter, 1), { shell: true, stdio: "ignore", detached: true }).unref();
		const code = await runGuard(runnerCommand(counter, 1), old.pid as number);
		expect(code, logText()).toBe(0);
		expect(Date.now() - started).toBeGreaterThanOrEqual(800);
	});
});

describe("startRestartGuard", () => {
	it("writes the guard script beside the update log and starts it detached with the command and the old pid", () => {
		const unref = vi.fn();
		const spawned: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
		const written: string[] = [];
		const lines: string[] = [];
		const ok = startRestartGuard("pags up --background", 4242, { attempts: 2 }, {
			env: { PAGS_UPDATE_LOG: join(dir, "x", "update.log") },
			write: (path) => void written.push(path),
			spawn: ((file: string, args: string[], opts: Record<string, unknown>) => { spawned.push({ file, args, opts }); return { unref }; }) as never,
			log: (l) => void lines.push(l),
		});
		expect(ok).toBe(true);
		expect(written).toEqual([join(dir, "x", "pags-restart-guard.mjs")]);
		expect(spawned[0].file).toBe(process.execPath);
		expect(spawned[0].opts).toMatchObject({ detached: true, stdio: "ignore" });
		expect(JSON.parse(spawned[0].args[1])).toMatchObject({ command: "pags up --background", oldPid: 4242, attempts: 2, log: join(dir, "x", "update.log") });
		expect(unref).toHaveBeenCalled();
		expect(lines[0]).toMatch(/guard started/);
	});
	it("never throws: a guard that cannot start leaves the restart unverified and says so", () => {
		const lines: string[] = [];
		const ok = startRestartGuard("c", 1, {}, { env: { PAGS_UPDATE_LOG: join(dir, "update.log") }, write: () => { throw new Error("EACCES"); }, log: (l) => void lines.push(l) });
		expect(ok).toBe(false);
		expect(lines[0]).toMatch(/guard could not start \(EACCES\); the restart is unverified/);
	});
});
