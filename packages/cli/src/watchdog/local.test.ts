/** #1320 — the watchdog's real hands, against temp folders and fake locks: the payload cache, the runner lock, the log, and the rollback end to end. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedPayloads } from "../bootstrap/payload.js";
import { beginTrial, badVersions, markBad } from "../bootstrap/trial.js";
import { writeInstalled } from "../bootstrap/test-payload.js";
import { executeCommand, type WatchdogDeps } from "./core.js";
import { logHistory, payloadFacts, runnerFromLocks, tailOf } from "./local.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-watchdog-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-24T12:00:00Z");
const line = (minutesAgo: number, text: string) => `[${new Date(NOW - minutesAgo * 60_000).toISOString()}] supervisor: ${text}`;

describe("crashes and the last error come from the service log (#1320)", () => {
	it("counts deaths in the last 24 hours, ignores asked-for restarts (exit 75) and older lines, and scrubs the last error", () => {
		const log = join(dir, "pags-up.log");
		writeFileSync(
			log,
			[
				line(60 * 30, "pags up exited (1); starting it again in 10s"), // older than a day
				line(300, "pags up exited (1); starting it again in 10s"),
				line(200, "pags up exited (75); starting it again in 1s"), // an update, not a crash
				line(100, "pags up exited (null); starting it again in 20s"),
				line(50, "could not start pags up: spawn /Users/serge/.nvm/node ENOENT"),
				"pags up wrote something unrelated",
			].join("\n"),
		);
		const h = logHistory(log, NOW);
		expect(h.crashes24h).toBe(2);
		expect(h.lastError).toBe("could not start pags up: spawn <path> ENOENT");
		expect(JSON.stringify(h)).not.toContain("serge");
	});
	it("an unreadable log is unknown, not zero", () => {
		expect(logHistory(join(dir, "nope.log"), NOW)).toEqual({ crashes24h: null, lastError: null });
	});
	it("the log tail is bounded and has paths and token-shaped strings removed", () => {
		const log = join(dir, "pags-up.log");
		writeFileSync(log, `${Array.from({ length: 80 }, (_, i) => `row ${i} ${"x".repeat(300)}`).join("\n")}\nopened /Users/serge/.config/proagentstore/session.json with sk-ant-abcdef123456789012345\n`);
		const t = tailOf(log);
		expect(t.length).toBeLessThanOrEqual(4_000);
		expect(t.split("\n").length).toBeLessThanOrEqual(30);
		expect(t).toContain("opened <path> with <secret>");
		expect(t).not.toMatch(/serge|sk-ant/);
		expect(tailOf(join(dir, "none.log"))).toMatch(/no runner log/);
	});
});

describe("is a runner alive? (#1320)", () => {
	const lock = (name: string, pid: number, launch = "service") => writeFileSync(join(dir, name), JSON.stringify({ v: 1, rsid: "r", pid, pidStartedAt: "", startedAt: NOW - 90_000, port: null, node: "n", machineId: null, account: "a", version: "0.4.177", launch, launchDetail: "", childPids: [], nonce: "n", runnerToken: "t", heartbeatAt: NOW }));
	it("finds a live holder in the machine's lock folder and says how long it has run", () => {
		lock("up-abc.lock", process.pid);
		expect(runnerFromLocks(dir, NOW)).toEqual({ alive: true, uptimeSec: 90, launch: "service" });
	});
	it("a lock whose process is gone, a foreign file and a missing folder all read as not running", () => {
		lock("up-dead.lock", 2_000_000_000);
		writeFileSync(join(dir, "other.json"), "{}");
		expect(runnerFromLocks(dir, NOW).alive).toBe(false);
		expect(runnerFromLocks(join(dir, "missing"), NOW)).toEqual({ alive: false, uptimeSec: null, launch: null });
	});
});

describe("rolling back, against the real payload cache (#1320)", () => {
	const real = (root: string, restarts: string[]): WatchdogDeps => ({
		now: () => NOW,
		startedAt: NOW - 1000,
		version: "0.4.177",
		nodeVersion: "22.4.0",
		payloads: () => payloadFacts(root),
		runner: () => ({ alive: false, uptimeSec: null }),
		history: () => ({ crashes24h: 0, lastError: null }),
		machine: () => ({ cpuLoad1: 0, memUsedPct: 10, diskUsedPct: 10, diskFreeGb: 100 }),
		service: () => "launchd",
		restartRunner: async () => {
			restarts.push("restart");
			return "ok";
		},
		latestRelease: async () => ({ version: "0.4.178" }),
		install: async () => undefined,
		markBad: (v, why, to) => markBad(root, v, why, to),
		logTail: () => "",
		serviceDescription: () => "",
		log: () => undefined,
	});
	const cache = (root: string, versions: string[]) => {
		for (const v of versions) writeInstalled(join(root, v), v);
	};

	it("the rollback command marks the newest version bad, leaves a notice for the version that runs next, and the cache then falls back", async () => {
		const root = join(dir, "payloads");
		mkdirSync(root, { recursive: true });
		cache(root, ["0.4.176", "0.4.177"]);
		beginTrial(root, "0.4.177", "0.4.176");
		const restarts: string[] = [];
		const d = real(root, restarts);
		expect(payloadFacts(root)).toMatchObject({ versions: ["0.4.177", "0.4.176"], trial: { version: "0.4.177", previous: "0.4.176" } });
		const r = await executeCommand({ id: "c1", kind: "rollback", args: {} }, d);
		expect(r.state).toBe("done");
		expect(restarts).toEqual(["restart"]);
		expect(badVersions(root)).toEqual({ "0.4.177": "rolled back by the owner's command" });
		const after = payloadFacts(root);
		expect(after.trial).toBeNull(); // the trial ended with the version
		expect(after.rollback).toEqual({ from: "0.4.177", to: "0.4.176", reason: "rolled back by the owner's command" });
		expect(cachedPayloads(root).map((p) => p.version).filter((v) => !after.bad[v])).toEqual(["0.4.176"]); // what the stub will run
		// …and a second rollback has nothing to go back to, and says so.
		expect((await executeCommand({ id: "c2", kind: "rollback", args: {} }, d)).state).toBe("failed");
	});

	it("a version given up on is never installed again by an update command", async () => {
		const root = join(dir, "payloads");
		mkdirSync(root, { recursive: true });
		cache(root, ["0.4.176", "0.4.177"]);
		markBad(root, "0.4.178", "never registered", "0.4.177");
		const r = await executeCommand({ id: "c3", kind: "update", args: {} }, real(root, []));
		expect(r).toMatchObject({ state: "failed", detail: expect.stringContaining("0.4.178 was installed here and rolled back (never registered)") });
	});
});
