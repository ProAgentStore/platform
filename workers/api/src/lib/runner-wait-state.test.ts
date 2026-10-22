/**
 * #1177 — a run waiting for its machine says so, stays alive without claiming progress, and its guard survives a workflow replay.
 *
 * The guard's probes and notices used to run outside `step.do`, and the body of a Workflow replays after every `step.sleep`. A live
 * probe on the replay answers differently (the machine is back), so the replay took another path than the original: the 30-minute
 * budget was undercounted and the pause notice was posted again. Here the journal is a Map keyed by step name, the way a Workflow's is.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { RuntimeFacts } from "./instance-connectivity.js";
import { recordLiveness } from "./agent-loop-store.js";
import { runHealth, waitClause } from "./work-report.js";
import { makeRunnerGuard, NO_SOCKET_MARKER, RUNNER_PROBE_INTERVAL_MS, RUNNER_PARK_MS, RunnerUnreachableError, type RunnerParkDeps, type RunnerWaitDeps, type RunStep } from "./runner-availability.js";
import { runnerWaitState } from "./runner-park.js";
import type { Env } from "../types.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 1, 0);
const OFFLINE: RuntimeFacts = { hasRuntimeRow: true, relayConnected: false, node: "mac", runnerVersion: null, lastSeenAt: "2026-10-22 01:00:00" };
const ONLINE: RuntimeFacts = { ...OFFLINE, relayConnected: true };
const gone = () => new RunnerUnreachableError(`${NO_SOCKET_MARKER} for test`);

/** A Workflow's journal: a step runs once per name; a replay gets the recorded result (or the recorded error). */
function journal() {
	const memo = new Map<string, { ok: true; value: unknown } | { ok: false; error: unknown }>();
	const executed: string[] = [];
	const run: RunStep = async (name, fn) => {
		const hit = memo.get(name);
		if (hit) {
			if (hit.ok) return hit.value;
			throw hit.error;
		}
		executed.push(name);
		try {
			const value = await fn();
			memo.set(name, { ok: true, value });
			return value;
		} catch (error) {
			memo.set(name, { ok: false, error });
			throw error;
		}
	};
	return { memo, run, executed };
}

/**
 * The world the guard lives in: a fake clock that only `step.sleep` advances, a machine that is back from `backAt`, and every side effect
 * (a post, a state write) counted. The `live` flag makes a probe answer from the CURRENT clock, like a real relay read.
 */
function world(j: ReturnType<typeof journal>, opts: { backAt: () => number; clock: { now: number } }) {
	const posted: string[] = [];
	const states: Array<{ op: "begin" | "end"; until?: number; at: number }> = [];
	const beats: number[] = [];
	const liveReads: string[] = [];
	const wait: RunnerWaitDeps = {
		probe: async (label) => {
			const read = async () => {
				liveReads.push(label ?? "unlabelled");
				return opts.clock.now >= opts.backAt() ? ONLINE : OFFLINE;
			};
			return label ? ((await j.run(label, read)) as RuntimeFacts) : read();
		},
		sleep: async (label) => {
			await j.run(label, async () => {
				opts.clock.now += RUNNER_PROBE_INTERVAL_MS;
				return null;
			});
		},
		announce: async (m, label) => {
			if (!label) return void posted.push(m);
			await j.run(`say-${label}`, async () => {
				posted.push(m);
				return null;
			});
		},
		tick: async (_ms, label) => {
			const beat = async () => {
				beats.push(opts.clock.now);
				return null;
			};
			if (label) await j.run(label, beat);
			else await beat();
		},
		state: {
			now: async (label) => (await j.run(label, async () => opts.clock.now)) as number,
			begin: async (label, until) => {
				await j.run(label, async () => {
					states.push({ op: "begin", until, at: opts.clock.now });
					return null;
				});
			},
			end: async (label) => {
				await j.run(label, async () => {
					states.push({ op: "end", at: opts.clock.now });
					return null;
				});
			},
		},
	};
	return { wait, posted, states, beats, liveReads };
}

/** A guarded step that meets a disconnect on its first attempt and succeeds on the next. */
const flaky = () => {
	let calls = 0;
	return async () => {
		calls++;
		if (calls === 1) throw gone();
		return "ok";
	};
};

describe("the wait is run state: a reason, a deadline, a current heartbeat", () => {
	it("begins `runner_away` with the instant the wait gives up, ticks the heartbeat, and ends when the machine is back", async () => {
		const j = journal();
		const clock = { now: T0 };
		const w = world(j, { backAt: () => T0 + 3 * MIN, clock });
		const guard = makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined, waitMsPerLoss: 10 * MIN, totalWaitMs: 30 * MIN });
		await guard(j.run, "capture", flaky());
		expect(w.states[0]).toEqual({ op: "begin", until: T0 + 10 * MIN, at: T0 });
		expect(w.states.at(-1)).toMatchObject({ op: "end" });
		expect(w.states.filter((s) => s.op === "begin")).toHaveLength(1);
		// one heartbeat per probe interval waited, each at its own instant
		expect(w.beats).toEqual(Array.from({ length: 12 }, (_v, i) => T0 + (i + 1) * RUNNER_PROBE_INTERVAL_MS));
	});

	it("states the real give-up instant when the run can park: the poll PLUS the park that follows it", async () => {
		const j = journal();
		const clock = { now: T0 };
		const w = world(j, { backAt: () => T0 + 60 * MIN, clock });
		const park: RunnerParkDeps = {
			now: async (label) => (await j.run(label, async () => clock.now)) as number,
			begin: async () => undefined,
			waitForBack: async (_label, ms) => {
				clock.now += ms;
				return false;
			},
			end: async () => undefined,
		};
		const guard = makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined, park, waitMsPerLoss: 10 * MIN, totalWaitMs: 30 * MIN });
		await guard(j.run, "capture", flaky());
		expect(w.states[0]).toEqual({ op: "begin", until: T0 + 10 * MIN + RUNNER_PARK_MS, at: T0 });
	});

	it("a blip that heals before the first probe records no wait at all", async () => {
		const j = journal();
		const w = world(j, { backAt: () => 0, clock: { now: T0 } });
		const guard = makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined });
		await guard(j.run, "capture", flaky());
		expect(w.states).toEqual([]);
		expect(w.posted).toEqual([]);
	});

	it("a failure that is not a disconnect fails at once and writes no wait state", async () => {
		const j = journal();
		const w = world(j, { backAt: () => 0, clock: { now: T0 } });
		const guard = makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined });
		await expect(guard(j.run, "capture", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		expect(w.states).toEqual([]);
		expect(w.beats).toEqual([]);
	});
});

describe("replay: the journal, not a live read, decides what the guard did", () => {
	/** Two guarded calls in one run, each meeting a disconnect; the first outage lasts 10 minutes (the whole per-loss poll). */
	async function twoOutages(j: ReturnType<typeof journal>, w: ReturnType<typeof world>) {
		const guard = makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined, waitMsPerLoss: 20 * MIN, totalWaitMs: 25 * MIN });
		await guard(j.run, "cap-1", flaky());
		await guard(j.run, "cap-2", flaky());
	}

	it("a replay after the machine is back reproduces the budget, posts nothing again and writes no state again", async () => {
		const j = journal();
		const clock = { now: T0 };
		// first outage: back after 10 minutes; second: back after 2 more
		const backAt = { t: T0 + 10 * MIN };
		const first = world(j, { backAt: () => backAt.t, clock });
		const originalRun = twoOutagesObserving(j, first, backAt, clock);
		await originalRun;
		const said = [...first.posted];
		const wrote = first.states.length;
		expect(said.some((m) => m.includes("Waiting up to 15 minutes"))).toBe(true); // 25 − the 10 already spent
		const executedBefore = j.executed.length;

		// REPLAY: new closures, the same journal, a world where the machine has been back all along.
		const replayClock = { now: T0 + 12 * MIN };
		const replay = world(j, { backAt: () => 0, clock: replayClock });
		await twoOutages(j, replay);
		expect(replay.posted, "a replay re-posted a notice").toEqual([]);
		expect(replay.states, "a replay rewrote the wait state").toEqual([]);
		expect(replay.beats, "a replay re-ticked the heartbeat").toEqual([]);
		expect(j.executed.length, "a replay executed steps that were journalled").toBe(executedBefore);
		// and not one live relay read: every probe came from the journal
		expect(replay.liveReads).toEqual([]);
		expect(said.length).toBe(first.posted.length);
		expect(wrote).toBe(first.states.length);
	});

	it("each notice is posted once per label, however often the body is replayed", async () => {
		const j = journal();
		const clock = { now: T0 };
		const w = world(j, { backAt: () => T0 + MIN, clock });
		const guard = () => makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined });
		await guard()(j.run, "capture", flaky());
		const once = [...w.posted];
		expect(once).toHaveLength(2); // the pause and the resume
		for (let i = 0; i < 3; i++) await guard()(j.run, "capture", flaky());
		expect(w.posted).toEqual(once);
	});
});

describe("the deadline is the budget, not a second clock", () => {
	it("a run that has already spent its total budget is told so, and no wait is begun", async () => {
		const j = journal();
		const clock = { now: T0 };
		const w = world(j, { backAt: () => Number.MAX_SAFE_INTEGER, clock });
		const guard = makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined, waitMsPerLoss: 5 * MIN, totalWaitMs: 5 * MIN });
		// the first outage spends the whole budget and gives up
		await expect(guard(j.run, "cap-1", async () => { throw gone(); })).rejects.toThrow(/did not come back/);
		const begins = w.states.filter((s) => s.op === "begin").length;
		await expect(guard(j.run, "cap-2", async () => { throw gone(); })).rejects.toThrow(/already spent its 5 minutes/);
		expect(w.states.filter((s) => s.op === "begin")).toHaveLength(begins);
	});
});

/** Drives the two outages of the replay test with a machine that returns at `backAt.t`, moving it for the second outage. */
async function twoOutagesObserving(j: ReturnType<typeof journal>, w: ReturnType<typeof world>, backAt: { t: number }, clock: { now: number }) {
	const guard = makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined, waitMsPerLoss: 20 * MIN, totalWaitMs: 25 * MIN });
	await guard(j.run, "cap-1", flaky());
	backAt.t = clock.now + 2 * MIN;
	await guard(j.run, "cap-2", flaky());
}

describe("health reads the wait: waiting, not working and then stalled (real schema)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
		env = { DB: d1.DB } as unknown as Env;
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, last_alive_at, last_progress_at)
		  VALUES ('run-1', 'u1', 'i1', 'x', 'running', 10, ${T0 - 60 * MIN}, ${T0}, ${T0 - 5 * MIN})`);
	});
	afterEach(() => d1.close());
	const row = () =>
		d1.sqlite.prepare("SELECT waiting_reason AS waitingReason, waiting_until AS waitingUntil, last_alive_at AS lastAliveAt, last_progress_at AS lastProgressAt, parked_since AS parkedSince, started_at AS startedAt, status FROM agent_loop_runs WHERE run_id = 'run-1'").get() as unknown as Parameters<typeof runHealth>[0];

	it("without a wait state a silent run reads `working` and then `stalled` — the defect", () => {
		expect(runHealth(row(), T0 + 5 * MIN)).toBe("working");
		expect(runHealth(row(), T0 + 20 * MIN)).toBe("stalled");
	});

	it("with the wait begun the run reads `waiting` for its machine, names the give-up, and stays current on heartbeats", async () => {
		const j = journal();
		const ws = runnerWaitState(env, j.run, { runId: "run-1" });
		await ws.begin("w0", T0 + 10 * MIN);
		expect(row()).toMatchObject({ waitingReason: "runner_away", waitingUntil: T0 + 10 * MIN });
		expect(runHealth(row(), T0 + 5 * MIN)).toBe("waiting");
		expect(waitClause({ ...row(), status: "running" }, T0 + 5 * MIN)).toMatch(/GIVES UP/);
		// heartbeat ticks while waiting: liveness moves, progress does not
		const before = row();
		await recordLiveness(env, "run-1", T0 + 4 * MIN);
		const after = row();
		expect(after.lastAliveAt).toBe(T0 + 4 * MIN);
		expect(after.lastProgressAt).toBe(before.lastProgressAt);
		expect(after.waitingReason).toBe("runner_away");
		// the machine is back: the reason clears and the run reads as working again
		await ws.end("w1");
		expect(row()).toMatchObject({ waitingReason: null, waitingUntil: null });
		expect(runHealth(row(), T0 + 5 * MIN)).toBe("working");
	});

	it("replaying the begin does not rewrite it: the journalled write runs once", async () => {
		const j = journal();
		const ws = runnerWaitState(env, j.run, { runId: "run-1" });
		await ws.begin("w0", T0 + 10 * MIN);
		d1.exec(`UPDATE agent_loop_runs SET waiting_until = ${T0 + 99 * MIN} WHERE run_id = 'run-1'`);
		await ws.begin("w0", T0 + 10 * MIN); // the replay
		expect(row().waitingUntil).toBe(T0 + 99 * MIN);
		expect(j.executed).toEqual(["w0"]);
	});
});
