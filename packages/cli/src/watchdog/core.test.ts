/**
 * #1320 — the always-on control channel's behaviour, on synthetic machines: every command, the loop around them, and the guarantees that
 * make it safe to leave running — a closed command set, an update that cannot half-install, a live runner never cut off by one.
 */
import { describe, expect, it, vi } from "vitest";
import { COMMAND_TIMEOUT_MS, type CommandResult, collectStatus, executeCommand, type PayloadFacts, runWatchdogLoop, WATCHDOG_AFTER_COMMAND_MS, WATCHDOG_BACKOFF_MAX_MS, WATCHDOG_BACKOFF_MIN_MS, WATCHDOG_HEARTBEAT_MS, type WatchdogCommand, type WatchdogDeps, type WatchdogLink } from "./core.js";

function deps(over: Partial<WatchdogDeps> & { facts?: Partial<PayloadFacts>; runnerAlive?: boolean } = {}): WatchdogDeps & { lines: string[]; installed: Array<[string, string | null]>; bad: Array<[string, string, string | null]>; restarts: number } {
	const lines: string[] = [];
	const installed: Array<[string, string | null]> = [];
	const bad: Array<[string, string, string | null]> = [];
	const state = { restarts: 0 };
	const facts: PayloadFacts = { versions: ["0.4.177", "0.4.176"], bad: {}, trial: null, rollback: null, ...over.facts };
	const d: WatchdogDeps = {
		now: () => 1_000_000,
		startedAt: 880_000,
		version: "0.4.177",
		nodeVersion: "22.4.0",
		payloads: () => facts,
		runner: () => ({ alive: over.runnerAlive ?? true, uptimeSec: over.runnerAlive === false ? null : 600 }),
		history: () => ({ crashes24h: 3, lastError: "pags up exited (1)" }),
		machine: () => ({ cpuLoad1: 0.5, memUsedPct: 61, diskUsedPct: 91, diskFreeGb: 40 }),
		service: () => "launchd",
		restartRunner: async () => {
			state.restarts++;
			return "restart the runner's LaunchAgent: ok";
		},
		latestRelease: async () => ({ version: "0.4.178" }),
		install: async (v, prev) => {
			installed.push([v, prev]);
		},
		markBad: (v, why, to) => {
			bad.push([v, why, to]);
		},
		logTail: () => "line1\nline2",
		serviceDescription: () => "launchd (runner service installed)",
		log: (l) => lines.push(l),
		...over,
	};
	const out = Object.assign(d, { lines, installed, bad, restarts: 0 });
	Object.defineProperty(out, "restarts", { get: () => state.restarts }); // a live reading, not the value at construction
	return out;
}
const cmd = (kind: WatchdogCommand["kind"], args: Record<string, string> = {}): WatchdogCommand => ({ id: "11111111-aaaa-bbbb-cccc-000000000000", kind, args });

describe("the status it reports (#1320)", () => {
	it("carries versions, the runner's life, crashes, the last error, load, disk and any trial or rollback", () => {
		const s = collectStatus(deps({ facts: { trial: { version: "0.4.177", previous: "0.4.176", starts: 2 }, rollback: { from: "0.4.175", to: "0.4.176", reason: "never registered" } } }));
		expect(s).toMatchObject({ version: "0.4.177", uptimeSec: 120, running: "0.4.177", payloads: ["0.4.177", "0.4.176"], runner: { alive: true, uptimeSec: 600 }, crashes24h: 3, lastError: "pags up exited (1)", diskUsedPct: 91, service: "launchd", trial: { version: "0.4.177", startsLeft: 4 }, rollback: { from: "0.4.175" } });
	});
	it("names the newest payload that has NOT been given up on as what is running", () => {
		expect(collectStatus(deps({ facts: { versions: ["0.4.178", "0.4.177"], bad: { "0.4.178": "crashed" } } })).running).toBe("0.4.177");
	});
});

describe("update (#1320)", () => {
	it("installs the latest beside the current one, on trial; a live runner is NOT restarted — it takes it at its next restart", async () => {
		const d = deps();
		const r = await executeCommand(cmd("update"), d);
		expect(r).toMatchObject({ state: "done", detail: expect.stringMatching(/installed 0\.4\.178 beside 0\.4\.177 \(on trial\).*picks 0\.4\.178 up at its next restart/) });
		expect(d.installed).toEqual([["0.4.178", "0.4.177"]]);
		expect(d.restarts).toBe(0);
	});
	it("starts a runner that is NOT running on the new release straight away — the case the channel exists for", async () => {
		const d = deps({ runnerAlive: false });
		const r = await executeCommand(cmd("update"), d);
		expect(r.state).toBe("done");
		expect(r.detail).toContain("the runner was not running, so it was started");
		expect(d.restarts).toBe(1);
	});
	it("a failed install (pre-flight, npm, a full disk) is a failed result, installs nothing else and restarts nothing", async () => {
		const d = deps({ runnerAlive: false, install: async () => { throw new Error("update pre-flight failed: only 90 MB free where the update installs"); } });
		const r = await executeCommand(cmd("update"), d);
		expect(r).toEqual({ id: cmd("update").id, state: "failed", detail: expect.stringContaining("only 90 MB free") });
		expect(d.restarts).toBe(0);
	});
	it("is a no-op when already on the latest, and says so", async () => {
		const r = await executeCommand(cmd("update"), deps({ latestRelease: async () => ({ version: "0.4.177" }) }));
		expect(r).toMatchObject({ state: "done", detail: "already on 0.4.177, the latest release" });
	});
	it("never installs a release this machine rolled back from, named or latest", async () => {
		const bad = { "0.4.178": "never registered" };
		const named = await executeCommand(cmd("update", { version: "0.4.178" }), deps({ facts: { bad } }));
		expect(named).toMatchObject({ state: "failed", detail: expect.stringContaining("rolled back (never registered)") });
		const latest = await executeCommand(cmd("update"), deps({ facts: { bad } }));
		expect(latest.state).toBe("failed");
	});
	it("an owner-named version installs even if it is older (a deliberate downgrade), but a bad name is refused", async () => {
		const d = deps();
		expect((await executeCommand(cmd("update", { version: "0.4.170" }), d)).state).toBe("done");
		expect(d.installed).toEqual([["0.4.170", "0.4.177"]]);
		expect((await executeCommand(cmd("update", { version: "latest; id" }), d)).state).toBe("failed");
	});
	it("says why when npm cannot be asked", async () => {
		const r = await executeCommand(cmd("update"), deps({ latestRelease: async () => ({ error: "ENOTFOUND registry.npmjs.org" }) }));
		expect(r).toMatchObject({ state: "failed", detail: expect.stringContaining("npm could not be asked") });
	});
});

describe("restart and rollback (#1320)", () => {
	it("restart brings the runner back through the service manager and reports what it did", async () => {
		const d = deps({ runnerAlive: false });
		expect(await executeCommand(cmd("restart"), d)).toMatchObject({ state: "done", detail: "restarted: restart the runner's LaunchAgent: ok" });
	});
	it("a restart that cannot happen is a failed result with the reason, never a silent success", async () => {
		const d = deps({ restartRunner: async () => { throw new Error("no service manager is installed for the runner"); } });
		expect(await executeCommand(cmd("restart"), d)).toMatchObject({ state: "failed", detail: "no service manager is installed for the runner" });
	});
	it("rollback gives up the newest version, falls back to the one before, and restarts onto it", async () => {
		const d = deps();
		const r = await executeCommand(cmd("rollback"), d);
		expect(r.state).toBe("done");
		expect(r.detail).toContain("rolled back from 0.4.177 to 0.4.176 (0.4.177 will not be installed again)");
		expect(d.bad).toEqual([["0.4.177", "rolled back by the owner's command", "0.4.176"]]);
		expect(d.restarts).toBe(1);
	});
	it("rollback with nothing older cached, or with older ones already given up on, refuses and changes nothing", async () => {
		const only = deps({ facts: { versions: ["0.4.177"] } });
		expect(await executeCommand(cmd("rollback"), only)).toMatchObject({ state: "failed", detail: expect.stringContaining("nothing to roll back to") });
		const allBad = deps({ facts: { versions: ["0.4.177", "0.4.176"], bad: { "0.4.176": "crashed" } } });
		expect((await executeCommand(cmd("rollback"), allBad)).state).toBe("failed");
		expect(only.bad).toEqual([]);
		expect(allBad.bad).toEqual([]);
		expect(only.restarts + allBad.restarts).toBe(0);
	});
});

describe("diagnose reads from a fixed list (#1320)", () => {
	it.each(["disk", "node", "payloads", "runner", "service", "log_tail"])("%s answers", async (check) => {
		const r = await executeCommand(cmd("diagnose", { check }), deps());
		expect(r.state).toBe("done");
		expect(r.detail.length).toBeGreaterThan(3);
	});
	it("anything else is refused — there is no way to ask it to run a command", async () => {
		for (const check of ["cat /etc/passwd", "rm -rf /", "", "env"]) expect((await executeCommand(cmd("diagnose", { check }), deps())).state).toBe("failed");
		expect((await executeCommand({ id: "x", kind: "exec" as never, args: { command: "id" } }, deps())).state).toBe("failed");
	});
	it("the payload and runner answers carry the facts an owner needs to decide", async () => {
		const d = deps({ facts: { bad: { "0.4.175": "crashed on import" }, trial: { version: "0.4.177", previous: "0.4.176", starts: 2 } } });
		expect((await executeCommand(cmd("diagnose", { check: "payloads" }), d)).detail).toBe("cached 0.4.177, 0.4.176; given up on 0.4.175 (crashed on import); 0.4.177 on trial (started 2×)");
		expect((await executeCommand(cmd("diagnose", { check: "runner" }), d)).detail).toBe("runner alive, up 600s; 3 restart(s) in 24h; last error: pags up exited (1)");
	});
});

describe("a command is bounded (#1320)", () => {
	it("a command that never finishes becomes a failed result at the timeout", async () => {
		vi.useFakeTimers();
		try {
			const p = executeCommand(cmd("restart"), deps({ restartRunner: () => new Promise(() => undefined) }));
			await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS + 1);
			expect(await p).toMatchObject({ state: "failed", detail: expect.stringContaining("timed out after 10 minutes") });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the loop (#1320)", () => {
	function link(script: Array<() => Promise<Awaited<ReturnType<WatchdogLink["beat"]>>>>) {
		const beats: Array<Parameters<WatchdogLink["beat"]>[0]> = [];
		const sleeps: number[] = [];
		let n = 0;
		const l: WatchdogLink = {
			beat: async (body) => {
				beats.push(body);
				const step = script[n++];
				if (!step) throw new Error("script ended");
				return step();
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			stopped: () => n >= script.length,
		};
		return { l, beats, sleeps };
	}
	const reporter = { payload: () => ({ capabilityHash: "h" }), accept: vi.fn() };

	it("beats, runs the commands it was handed, and sends their results on the very next beat", async () => {
		const d = deps({ runnerAlive: false });
		const { l, beats, sleeps } = link([async () => ({ commands: [cmd("diagnose", { check: "disk" })] }), async () => ({ commands: [] })]);
		await runWatchdogLoop(d, l, reporter);
		expect(beats[0].results).toEqual([]);
		expect(beats[1].results).toEqual([{ id: cmd("x").id, state: "done", detail: expect.stringContaining("disk 91% used") }]);
		expect(sleeps).toEqual([WATCHDOG_AFTER_COMMAND_MS, WATCHDOG_HEARTBEAT_MS]);
		expect(beats[0].capabilityHash).toBe("h"); // the capability report rides every beat
		expect(reporter.accept).toHaveBeenCalled();
	});

	it("runs at most three commands per beat and in order, and a failing command does not stop the next", async () => {
		const many = ["status", "restart", "rollback", "update"].map((k, i) => ({ ...cmd(k as WatchdogCommand["kind"]), id: `id-${i}` }));
		const d = deps({ restartRunner: async () => { throw new Error("nope"); } });
		const { l, beats } = link([async () => ({ commands: many }), async () => ({})]);
		await runWatchdogLoop(d, l, reporter);
		expect((beats[1].results as CommandResult[]).map((r) => [r.id, r.state])).toEqual([["id-0", "done"], ["id-1", "failed"], ["id-2", "failed"]]);
	});

	it("when the platform cannot be reached it backs off 5s → 10s → … → 5min, says so once, keeps the results to send, and says when it is back", async () => {
		const d = deps({ runnerAlive: false });
		const fail = () => Promise.reject(new Error("fetch failed"));
		const { l, beats, sleeps } = link([async () => ({ commands: [cmd("diagnose", { check: "node" })] }), fail, fail, fail, async () => ({})]);
		await runWatchdogLoop(d, l, reporter);
		expect(sleeps).toEqual([WATCHDOG_AFTER_COMMAND_MS, WATCHDOG_BACKOFF_MIN_MS, WATCHDOG_BACKOFF_MIN_MS * 2, WATCHDOG_BACKOFF_MIN_MS * 4, WATCHDOG_HEARTBEAT_MS]);
		expect(d.lines.filter((x) => x.includes("cannot reach the platform"))).toHaveLength(1);
		expect(d.lines).toContain("the platform is reachable again");
		// The result produced before the outage is delivered once the link returns, not lost.
		expect(beats[4].results).toHaveLength(1);
		expect(WATCHDOG_BACKOFF_MAX_MS).toBe(300_000);
	});

	it("never throws, whatever the link does", async () => {
		const { l } = link([() => { throw new Error("sync throw"); }, async () => ({ commands: [{ id: "x", kind: "restart", args: {} }] })]);
		await expect(runWatchdogLoop(deps(), l, reporter)).resolves.toBeUndefined();
	});
});
