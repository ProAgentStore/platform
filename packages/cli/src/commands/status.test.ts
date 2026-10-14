/**
 * #499 — `pags status`: read from the #896 lock verdict, so it cannot disagree with what `pags up`
 * would refuse on. Invariants: a dead or absent holder is "not running" (exit 1) whatever a stale
 * background record says; a background runner shows what it serves, where its log is and how to stop
 * it; an unresponsive holder is reported as running-but-silent, never as gone (slow is not dead).
 */
import { describe, expect, it } from "vitest";
import type { BackgroundState } from "../background.js";
import type { RunnerLockFile } from "../runner-lock.js";
import { describeStatus } from "./status.js";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const LOCK = (over: Partial<RunnerLockFile> = {}) =>
	({ v: 1, rsid: "r", pid: 4242, pidStartedAt: "", startedAt: NOW - 30 * 60_000, port: 49171, node: "pink-laptop", machineId: null, account: "serge-ivo", version: "0.4.125", launch: "background", launchDetail: "/l/runner.log", childPids: [], nonce: "n", runnerToken: "t", heartbeatAt: NOW, ...over }) as RunnerLockFile;
const BG: BackgroundState = { v: 1, pid: 4242, startedAt: NOW - 30 * 60_000, logPath: "/l/runner.log", args: ["up", "--background"], instances: [{ id: "i1-aaaaaaaa", name: "Repo Coder" }], watching: true };

describe("pags status", () => {
	it("a live background runner: running, what it serves, its log and how to stop it", () => {
		const { running, lines } = describeStatus(LOCK(), "live", BG, NOW);
		const text = lines.join("\n");
		expect(running).toBe(true);
		expect(text).toMatch(/^Running — pid 4242, up 30 min, CLI 0\.4\.125, machine pink-laptop\./);
		expect(text).toMatch(/pags up --background/);
		expect(text).toMatch(/Repo Coder \(i1-aaaaa\)/);
		expect(text).toMatch(/newly eligible ones attach/);
		expect(text).toMatch(/Stop: `pags down`/);
	});

	it("a foreground runner: running, and where — no background details borrowed from an old record", () => {
		const { running, lines } = describeStatus(LOCK({ launch: "tty", launchDetail: "ttys003", pid: 99 }), "live", BG, NOW);
		expect(running).toBe(true);
		expect(lines.join("\n")).toMatch(/terminal ttys003/);
		expect(lines.join("\n")).not.toMatch(/Repo Coder/);
	});

	it("nothing holding the lock — or a dead holder — is NOT running, and names the stopped background runner's log", () => {
		for (const [lock, verdict] of [[null, null], [LOCK(), "dead"]] as const) {
			const { running, lines } = describeStatus(lock, verdict, BG, NOW);
			expect(running).toBe(false);
			expect(lines.join("\n")).toMatch(/^Not running/);
			expect(lines.join("\n")).toMatch(/has stopped\. Its log: \/l\/runner\.log/);
		}
	});

	it("an unresponsive holder is running-but-silent, never reported as gone", () => {
		const { running, lines } = describeStatus(LOCK(), "unresponsive", BG, NOW);
		expect(running).toBe(true);
		expect(lines[0]).toMatch(/NOT answering its health check/);
	});
});
