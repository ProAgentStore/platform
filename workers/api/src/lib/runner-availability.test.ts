import { describe, expect, it, vi } from "vitest";
import {
	isRunnerGone,
	isRunnerUnreachable,
	makeRunnerGuard,
	noRunnerDetail,
	relayFailureIsDisconnect,
	RunnerGoneError,
	RunnerUnreachableError,
	runnerGoneMessage,
	describeFacts,
	waitForRunner,
	NO_SOCKET_MARKER,
	RECONNECT_ROUNDS,
	RUNNER_PROBE_INTERVAL_MS,
	RUNNER_WAIT_MS,
	RUNNER_WAIT_TOTAL_MS,
	type RunnerWaitDeps,
	type RunStep,
} from "./runner-availability.js";
import { STALE_DRIVER_MS } from "./coding-store.js";
import type { RuntimeFacts } from "./instance-connectivity.js";

const OFFLINE: RuntimeFacts = { hasRuntimeRow: true, relayConnected: false, node: "macbook", runnerVersion: null, lastSeenAt: "2000-01-01 00:00:00" };
const ONLINE: RuntimeFacts = { ...OFFLINE, relayConnected: true };
/** Registered, heartbeating within 90s, but no socket — the `pags up --force` case (#237). */
const DETACHED: RuntimeFacts = { ...OFFLINE, lastSeenAt: new Date(Date.now() - 5_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "") };
const NEVER: RuntimeFacts = { hasRuntimeRow: false, relayConnected: false, node: null, runnerVersion: null, lastSeenAt: null };
/**
 * The production shape of #461, and DELIBERATELY built on `DETACHED`: the heartbeat lands on the
 * shared default row, so the pinned-at-a-dead-machine case is byte-identical to the `--force` case
 * except for the two fields the adapter used to drop.
 */
const PINNED: RuntimeFacts = { ...DETACHED, node: "Mac", pinnedNode: "Sergeys-Mac-mini.local", liveNodeExcludedByPin: "Mac" };

function waitDeps(probes: RuntimeFacts[], overrides: Partial<RunnerWaitDeps> = {}): RunnerWaitDeps & { said: string[]; slept: string[]; ticks: number[] } {
	const said: string[] = [];
	const slept: string[] = [];
	const ticks: number[] = [];
	let i = 0;
	return {
		said,
		slept,
		ticks,
		probe: async () => probes[Math.min(i++, probes.length - 1)],
		sleep: async (label) => { slept.push(label); },
		announce: async (m) => { said.push(m); },
		tick: async (ms) => { ticks.push(ms); },
		...overrides,
	};
}

describe("the budget is sized against what it waits for (#341)", () => {
	it("outlasts the runner's own 30s reconnect cap by a wide margin", () => {
		// The bug: a ~4 second tolerance for a runner that reconnects with backoff capped at 30s.
		// Any budget under that loses a race the runner is designed to win.
		expect(RUNNER_WAIT_MS).toBeGreaterThan(30_000 * 10);
	});

	it("notices a reconnect within one backoff cap", () => {
		expect(RUNNER_PROBE_INTERVAL_MS).toBeLessThanOrEqual(30_000);
	});

	it("cannot outlive the single-flight claim the run holds on its session", () => {
		expect(RUNNER_WAIT_MS).toBeLessThan(STALE_DRIVER_MS);
	});

	it("bounds the whole run, so a flapping machine cannot hold a workflow open forever", () => {
		expect(RUNNER_WAIT_TOTAL_MS).toBeGreaterThanOrEqual(RUNNER_WAIT_MS);
		expect(RUNNER_WAIT_TOTAL_MS).toBeLessThanOrEqual(60 * 60_000);
	});
});

describe("a connectivity failure carries whether it is transient (#339's shape)", () => {
	it("recognises its own error class", () => {
		expect(isRunnerUnreachable(new RunnerUnreachableError("x"))).toBe(true);
	});

	it("still recognises it after a Workflow step boundary has flattened it to a plain Error", () => {
		// The engine serialises a thrown step error; the receiving side gets the message, not the
		// prototype. Without the marker the whole classification would silently stop working.
		expect(isRunnerUnreachable(new Error(`No runner connected — ${NO_SOCKET_MARKER} for this agent.`))).toBe(true);
	});

	it("treats a socket that dropped mid-command as a disconnect", () => {
		expect(isRunnerUnreachable(new Error('Runner /coding/capture → 504: {"error":"Runner disconnected"}'))).toBe(true);
		expect(isRunnerUnreachable(new Error('Runner /coding/act → 504: {"error":"Runner WebSocket error"}'))).toBe(true);
	});

	it("does NOT treat a connected-but-silent runner as a disconnect", () => {
		// A wedged engine is present. Waiting ten minutes for a machine that is here would turn a
		// fast honest failure into a slow one.
		expect(isRunnerUnreachable(new Error('Runner /coding/capture → 504: {"error":"Relay command timed out"}'))).toBe(false);
		expect(isRunnerUnreachable(new Error("boom"))).toBe(false);
		expect(isRunnerUnreachable(null)).toBe(false);
	});

	it("classifies relay responses the same way callRunner does", () => {
		expect(relayFailureIsDisconnect(503, '{"error":"No runner connected"}')).toBe(true);
		expect(relayFailureIsDisconnect(504, '{"error":"Runner disconnected"}')).toBe(true);
		expect(relayFailureIsDisconnect(504, '{"error":"Relay command timed out"}')).toBe(false);
		expect(relayFailureIsDisconnect(500, "boom")).toBe(false);
	});

	it("marks a waited-out runner as NOT retryable", () => {
		expect(isRunnerGone(new RunnerGoneError("gone"))).toBe(true);
		expect(new RunnerGoneError("gone").retryable).toBe(false);
		expect(new RunnerUnreachableError("blip").retryable).toBe(true);
	});
});

describe("waitForRunner", () => {
	it("returns at once, silently, when the blip already healed", async () => {
		const d = waitDeps([ONLINE]);
		const r = await waitForRunner(d, { label: "s1", waitMs: RUNNER_WAIT_MS });
		expect(r).toMatchObject({ returned: true, waitedMs: 0 });
		expect(d.said).toEqual([]);
		expect(d.slept).toEqual([]);
	});

	it("announces the pause, waits, and announces the recovery", async () => {
		const d = waitDeps([OFFLINE, OFFLINE, ONLINE]);
		const r = await waitForRunner(d, { label: "s1", waitMs: RUNNER_WAIT_MS });
		expect(r.returned).toBe(true);
		expect(r.waitedMs).toBe(2 * RUNNER_PROBE_INTERVAL_MS);
		// A pause nobody can see is indistinguishable from a hang (#252).
		expect(d.said[0]).toContain("pausing, not stopping");
		expect(d.said[0]).toContain("resumes at the same step");
		expect(d.said[1]).toContain("Runner is back");
		expect(d.said[1]).toContain("macbook");
		// The claim heartbeat runs while paused, or the run would expire its own session lock.
		expect(d.ticks).toEqual([RUNNER_PROBE_INTERVAL_MS, 2 * RUNNER_PROBE_INTERVAL_MS]);
	});

	it("gives up after the budget and says the runner did not come back", async () => {
		const d = waitDeps([OFFLINE]);
		const r = await waitForRunner(d, { label: "s1", waitMs: 3 * RUNNER_PROBE_INTERVAL_MS });
		expect(r.returned).toBe(false);
		expect(r.state).toBe("runner-offline");
		expect(d.slept).toHaveLength(3);
		expect(r.message).toContain("did not come back");
		// The sentence this ticket exists to delete.
		expect(r.message).not.toContain("run `pags up`");
	});

	it("uses each state's own remedy — including the one a hardcoded string can never give", () => {
		expect(runnerGoneMessage(describeFacts(DETACHED), 60_000)).toContain("pags up --force");
		expect(runnerGoneMessage(describeFacts(OFFLINE), 60_000)).toContain("`pags up`");
		expect(runnerGoneMessage(describeFacts(NEVER), 0)).toContain("No runner has registered");
	});

	// #461 — the ADAPTER, which is what was untested. `diagnoseAttachment`'s pinned branch has had
	// a test since #380; `describeFacts` forwarded three of its five inputs, so every sentence in
	// this file described a pinned agent as one that needs `--force`.
	it("forwards the pin, so a pinned agent is never told to --force a machine that is off", () => {
		const d = describeFacts(PINNED);
		expect(d.state).toBe("pinned-machine-offline");
		expect(d.remedy).toBeNull();
		expect(d.message).toContain("Sergeys-Mac-mini.local");
		expect(d.message).toContain("Mac");
	});

	it("carries that through both pause announcements and the no-runner line", async () => {
		// A Workflow pausing for up to 30 minutes announces this into the owner's thread — the
		// harder of the three call sites to notice, because it appears mid-run rather than in a
		// response somebody is reading.
		const paused = waitDeps([PINNED, PINNED]);
		const r = await waitForRunner(paused, { label: "pin", waitMs: RUNNER_PROBE_INTERVAL_MS });
		expect(paused.said[0]).toContain("Runs on");
		expect(paused.said[0]).not.toContain("--force");
		expect(r.state).toBe("pinned-machine-offline");
		expect(r.message).not.toContain("--force");
		expect(noRunnerDetail(PINNED)).toContain("Runs on");
		expect(noRunnerDetail(PINNED)).not.toContain("--force");
		// The unpinned case is untouched — it is the one `--force` is actually the answer to.
		expect(noRunnerDetail(DETACHED)).toContain("--force");
	});
});

describe("makeRunnerGuard", () => {
	/** A fake `step.do` that ignores retries: the guard's job starts after they are exhausted. */
	const stepper = (): RunStep & { names: string[] } => {
		const names: string[] = [];
		const run = (async (name: string, fn: () => Promise<unknown>) => {
			names.push(name);
			return fn();
		}) as RunStep & { names: string[] };
		run.names = names;
		return run;
	};

	it("passes a healthy step straight through", async () => {
		const guard = makeRunnerGuard({ wait: waitDeps([ONLINE]), reconnect: async () => undefined });
		await expect(guard(stepper(), "s0", async () => "ok")).resolves.toBe("ok");
	});

	it("fails a GENUINE error immediately — no pause, no sleeping", async () => {
		// The acceptance criterion this change is most likely to break: only connectivity waits.
		const wait = waitDeps([ONLINE]);
		const guard = makeRunnerGuard({ wait, reconnect: async () => undefined });
		await expect(guard(stepper(), "s0", async () => { throw new Error("typecheck failed"); })).rejects.toThrow("typecheck failed");
		expect(wait.slept).toEqual([]);
		expect(wait.said).toEqual([]);
	});

	it("survives a disconnect, relaunches the engine, and resumes at the same step", async () => {
		const wait = waitDeps([OFFLINE, ONLINE]);
		const reconnect = vi.fn(async () => undefined);
		const guard = makeRunnerGuard({ wait, reconnect });
		const run = stepper();
		let attempts = 0;
		const out = await guard(run, "s7-snapshot", async () => {
			if (attempts++ === 0) throw new RunnerUnreachableError(`No runner connected — ${NO_SOCKET_MARKER} for this agent.`);
			return "pane";
		});
		expect(out).toBe("pane");
		expect(reconnect).toHaveBeenCalledTimes(1);
		// Same logical step, re-run under a fresh durable name (Workflow step names are unique).
		expect(run.names).toEqual(["s7-snapshot", "s7-snapshot-r1"]);
	});

	it("ends the run only when the runner never comes back, with the diagnosed remedy", async () => {
		const wait = waitDeps([DETACHED]);
		const guard = makeRunnerGuard({ wait, reconnect: async () => undefined, waitMsPerLoss: 2 * RUNNER_PROBE_INTERVAL_MS });
		const err = await guard(stepper(), "s0", async () => { throw new RunnerUnreachableError("No runner connected — " + NO_SOCKET_MARKER); })
			.then(() => null, (e) => e);
		expect(isRunnerGone(err)).toBe(true);
		expect((err as Error).message).toContain("did not come back");
		expect((err as Error).message).toContain("pags up --force");
	});

	it("spends the run-level budget across separate losses and then stops waiting", async () => {
		const wait = waitDeps([OFFLINE], { probe: async () => OFFLINE });
		const guard = makeRunnerGuard({
			wait,
			reconnect: async () => undefined,
			waitMsPerLoss: 2 * RUNNER_PROBE_INTERVAL_MS,
			totalWaitMs: 2 * RUNNER_PROBE_INTERVAL_MS,
		});
		const boom = async () => { throw new RunnerUnreachableError(NO_SOCKET_MARKER); };
		await expect(guard(stepper(), "a", boom)).rejects.toThrow("did not come back");
		const second = await guard(stepper(), "b", boom).then(() => null, (e) => e as Error);
		expect(second?.message).toContain("already spent its");
		// Budget gone → it stopped sleeping rather than waiting a second full window.
		expect(wait.slept.filter((s) => s.startsWith("b"))).toEqual([]);
	});

	it("does not retry a step forever when the runner keeps flapping", async () => {
		const wait = waitDeps([], { probe: async () => ONLINE });
		const guard = makeRunnerGuard({ wait, reconnect: async () => undefined });
		let calls = 0;
		await expect(
			guard(stepper(), "s0", async () => { calls++; throw new RunnerUnreachableError(NO_SOCKET_MARKER); }),
		).rejects.toThrow(NO_SOCKET_MARKER);
		expect(calls).toBe(RECONNECT_ROUNDS + 1);
	});
});

describe("noRunnerDetail", () => {
	it("names the remedy that fits what was observed", () => {
		expect(noRunnerDetail(NEVER)).toContain("`pags up`");
		expect(noRunnerDetail(NEVER)).toContain("No runner has registered");
		expect(noRunnerDetail(DETACHED)).toContain("`pags up --force`");
		expect(noRunnerDetail(OFFLINE)).toContain("isn't running");
	});

	it("degrades to the plain sentence when the diagnosis could not be read", () => {
		expect(noRunnerDetail(null)).toContain("No coding runner connected.");
	});
});
