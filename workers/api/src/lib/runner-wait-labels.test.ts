/**
 * #1359 — every Workflow step name the runner wait/park logic emits, recorded as GOLDENS.
 *
 * A Workflow journals each `step.do`/`step.sleep` by name and replays by name. A run parked on its machine can wait up to a day
 * (RUNNER_PARK_MS), so the code deployed while it waits must emit EXACTLY the names the old code did, in the same order, or the
 * replay diverges from the journal. These snapshots were taken from the implementation BEFORE the wait/park logic was rewritten as
 * an explicit state machine (`runner-wait-machine.ts`); the rewrite had to reproduce them byte for byte.
 *
 * If a snapshot here must change, the change is a replay break for every in-flight run: version the labels instead.
 */
import { describe, expect, it } from "vitest";
import type { RuntimeFacts } from "./instance-connectivity.js";
import {
	makeRunnerGuard,
	RECONNECT_ROUNDS,
	RUNNER_PROBE_INTERVAL_MS,
	RunnerUnreachableError,
	UNRESPONSIVE_MARKER,
	type RunnerParkDeps,
	type RunnerWaitDeps,
	type RunStep,
} from "./runner-availability.js";

const OFFLINE: RuntimeFacts = { hasRuntimeRow: true, relayConnected: false, node: "macbook", runnerVersion: null, lastSeenAt: "2000-01-01 00:00:00" };
const ONLINE: RuntimeFacts = { ...OFFLINE, relayConnected: true };
const TICK = RUNNER_PROBE_INTERVAL_MS;
const disconnect = () => new RunnerUnreachableError("Runner disconnected");
const silent = () => new RunnerUnreachableError(`Runner /coding/capture → 504: Relay command timed out — the runner is ${UNRESPONSIVE_MARKER}.`);

interface Script {
	/** Facts for the Nth probe call (0-based), by label — the default is OFFLINE. */
	probe?: (label: string | undefined, n: number) => RuntimeFacts | "unknown";
	healthy?: (label: string, n: number) => boolean;
	/** The Nth park wait: true when the machine's event arrived. */
	waitForBack?: (label: string, ms: number, n: number) => boolean;
	reconnectFails?: (label: string, n: number) => Error | null;
	stepFails?: (name: string, n: number) => Error | null;
	sessionLost?: boolean;
	withPark?: boolean;
	withState?: boolean;
	withHealth?: boolean;
	waitMsPerLoss?: number;
	totalWaitMs?: number;
	parkTotalMs?: number;
}

/** Drive one guarded step through fakes that write every label-bearing call, in order, to a log. */
async function record(script: Script, name = "s1"): Promise<string> {
	const log: string[] = [];
	let clock = 1_000;
	let probes = 0;
	let healths = 0;
	let backs = 0;
	let reconnects = 0;
	let steps = 0;
	const wait: RunnerWaitDeps = {
		probe: async (label) => {
			log.push(`probe ${label ?? "(live)"}`);
			const f = script.probe ? script.probe(label, probes++) : OFFLINE;
			if (f === "unknown") throw new Error("probe blip");
			return f;
		},
		sleep: async (label) => {
			log.push(`sleep ${label}`);
			clock += TICK;
		},
		announce: async (message, label) => void log.push(`announce ${label} :: ${message.slice(0, 28)}`),
		tick: async (ms, label) => void log.push(`tick ${label} ${ms}`),
		...(script.withState
			? {
					state: {
						now: async (label: string) => {
							log.push(`state.now ${label}`);
							return clock;
						},
						begin: async (label: string, until: number) => void log.push(`state.begin ${label} ${until}`),
						end: async (label: string) => void log.push(`state.end ${label}`),
					},
				}
			: {}),
		...(script.withHealth
			? {
					healthy: async (label: string) => {
						const ok = script.healthy ? script.healthy(label, healths++) : true;
						log.push(`healthy ${label} -> ${ok}`);
						return ok;
					},
				}
			: {}),
	};
	const park: RunnerParkDeps | undefined = script.withPark
		? {
				now: async (label) => {
					log.push(`park.now ${label}`);
					return clock;
				},
				begin: async (label, until) => void log.push(`park.begin ${label} ${until}`),
				waitForBack: async (label, ms) => {
					log.push(`park.waitForBack ${label} ${ms}`);
					clock += ms;
					return script.waitForBack ? script.waitForBack(label, ms, backs++) : false;
				},
				end: async (label) => void log.push(`park.end ${label}`),
			}
		: undefined;
	const guard = makeRunnerGuard({
		wait,
		reconnect: async (label) => {
			log.push(`reconnect ${label}`);
			const e = script.reconnectFails?.(label, reconnects++);
			if (e) throw e;
		},
		...(script.sessionLost ? { sessionLost: async () => true } : {}),
		...(park ? { park } : {}),
		...(script.waitMsPerLoss !== undefined ? { waitMsPerLoss: script.waitMsPerLoss } : {}),
		...(script.totalWaitMs !== undefined ? { totalWaitMs: script.totalWaitMs } : {}),
		...(script.parkTotalMs !== undefined ? { parkTotalMs: script.parkTotalMs } : {}),
	});
	const run: RunStep = async (stepName, fn) => {
		log.push(`step ${stepName}`);
		return fn();
	};
	try {
		await guard(run, name, async () => {
			const e = script.stepFails?.(name, steps++);
			if (e) throw e;
			return "ok";
		});
		log.push("=> resolved");
	} catch (e) {
		log.push(`=> threw ${(e as Error).name}: ${(e as Error).message.slice(0, 48)}`);
	}
	return log.join("\n");
}

const after = (n: number) => (_l: string | undefined, i: number) => (i >= n ? ONLINE : OFFLINE);

describe("the labels the runner guard emits are frozen (#1359)", () => {
	it("a healthy step: one step, nothing else", async () => {
		expect(await record({})).toMatchInlineSnapshot(`
			"step s1
			=> resolved"
		`);
	});

	it("a disconnect that heals during the poll: wait, ticks, announce, resume, reconnect", async () => {
		expect(await record({ withState: true, stepFails: (_n, i) => (i === 0 ? disconnect() : null), probe: after(3) })).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			state.now s1-w0-t0
			state.begin s1-w0-w0 601000
			announce s1-w0-n :: ⏸ **Runner unreachable — pau
			sleep s1-w0-p0
			tick s1-w0-k0 15000
			probe s1-w0-q0
			sleep s1-w0-p1
			tick s1-w0-k1 30000
			probe s1-w0-q1
			sleep s1-w0-p2
			tick s1-w0-k2 45000
			probe s1-w0-q2
			state.end s1-w0-w1
			announce s1-w0-back :: ▶️ **Runner is back** on mac
			reconnect s1-rc0
			step s1-r1
			=> resolved"
		`);
	});

	it("a blip that healed before the wait began returns at once, announcing nothing", async () => {
		expect(await record({ stepFails: (_n, i) => (i === 0 ? disconnect() : null), probe: () => ONLINE })).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			reconnect s1-rc0
			step s1-r1
			=> resolved"
		`);
	});

	it("a runner that stays connected but silent: waits for /health to answer, with health labels", async () => {
		expect(await record({ withState: true, withHealth: true, healthy: (_l, i) => i >= 2, probe: () => ONLINE, stepFails: (_n, i) => (i === 0 ? silent() : null) })).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			state.now s1-w0-t0
			state.begin s1-w0-w0 601000
			announce s1-w0-n :: ⏸ **Runner not answering — p
			sleep s1-w0-p0
			tick s1-w0-k0 15000
			probe s1-w0-q0
			healthy s1-w0-h0 -> false
			sleep s1-w0-p1
			tick s1-w0-k1 30000
			probe s1-w0-q1
			healthy s1-w0-h1 -> false
			sleep s1-w0-p2
			tick s1-w0-k2 45000
			probe s1-w0-q2
			healthy s1-w0-h2 -> true
			state.end s1-w0-w1
			announce s1-w0-back :: ▶️ **Runner is back** on mac
			reconnect s1-rc0
			step s1-r1
			=> resolved"
		`);
	});

	it("a poll that runs out with no park ends the run", async () => {
		expect(await record({ withState: true, waitMsPerLoss: 2 * TICK, stepFails: () => disconnect() })).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			state.now s1-w0-t0
			state.begin s1-w0-w0 31000
			announce s1-w0-n :: ⏸ **Runner unreachable — pau
			sleep s1-w0-p0
			tick s1-w0-k0 15000
			probe s1-w0-q0
			sleep s1-w0-p1
			tick s1-w0-k1 30000
			probe s1-w0-q1
			=> threw RunnerGoneError: The runner did not come back after waiting 30s. "
		`);
	});

	it("a poll that runs out PARKS the run; the first park check times out, the second is woken and the machine is back", async () => {
		expect(
			await record({
				withState: true,
				withPark: true,
				waitMsPerLoss: 2 * TICK,
				stepFails: (_n, i) => (i === 0 ? disconnect() : null),
				waitForBack: (_l, _ms, n) => n >= 1,
				probe: (label) => (label?.includes("-pk1-") || label?.endsWith("-pk1-q") ? ONLINE : OFFLINE),
			}),
		).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			state.now s1-w0-t0
			state.begin s1-w0-w0 86431000
			announce s1-w0-n :: ⏸ **Runner unreachable — pau
			sleep s1-w0-p0
			tick s1-w0-k0 15000
			probe s1-w0-q0
			sleep s1-w0-p1
			tick s1-w0-k1 30000
			probe s1-w0-q1
			park.now s1-w0-pk
			probe s1-w0-pk-q
			park.begin s1-w0-pk-begin 86431000
			announce s1-w0-pk-n :: ⏸ **Runner away — the run is
			park.now s1-w0-pk0-at
			park.waitForBack s1-w0-pk0 600000
			park.now s1-w0-pk0-t
			tick s1-w0-pk0-k 600000
			probe s1-w0-pk0-q
			park.now s1-w0-pk1-at
			park.waitForBack s1-w0-pk1 600000
			park.now s1-w0-pk1-t
			tick s1-w0-pk1-k 1200000
			probe s1-w0-pk1-w-q
			probe s1-w0-pk1-q
			park.end s1-w0-pk-end
			announce s1-w0-pk-back :: ▶️ **Runner is back** on mac
			reconnect s1-rc0
			step s1-r1
			=> resolved"
		`);
	});

	it("a park whose machine never returns runs out its budget", async () => {
		expect(await record({ withState: true, withPark: true, waitMsPerLoss: 2 * TICK, parkTotalMs: 25 * 60_000, stepFails: () => disconnect() })).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			state.now s1-w0-t0
			state.begin s1-w0-w0 1531000
			announce s1-w0-n :: ⏸ **Runner unreachable — pau
			sleep s1-w0-p0
			tick s1-w0-k0 15000
			probe s1-w0-q0
			sleep s1-w0-p1
			tick s1-w0-k1 30000
			probe s1-w0-q1
			park.now s1-w0-pk
			probe s1-w0-pk-q
			park.begin s1-w0-pk-begin 1531000
			announce s1-w0-pk-n :: ⏸ **Runner away — the run is
			park.now s1-w0-pk0-at
			park.waitForBack s1-w0-pk0 600000
			park.now s1-w0-pk0-t
			tick s1-w0-pk0-k 600000
			probe s1-w0-pk0-q
			park.now s1-w0-pk1-at
			park.waitForBack s1-w0-pk1 600000
			park.now s1-w0-pk1-t
			tick s1-w0-pk1-k 1200000
			probe s1-w0-pk1-q
			park.now s1-w0-pk2-at
			park.waitForBack s1-w0-pk2 300000
			park.now s1-w0-pk2-t
			tick s1-w0-pk2-k 1500000
			probe s1-w0-pk2-q
			park.now s1-w0-pk3-at
			park.end s1-w0-pk-end
			=> threw RunnerGoneError: The runner did not come back: this run waited 25"
		`);
	});

	it("a woken park polls quietly, and a machine still away sends it round again", async () => {
		expect(
			await record({
				withState: true,
				withPark: true,
				waitMsPerLoss: 2 * TICK,
				stepFails: (_n, i) => (i === 0 ? disconnect() : null),
				waitForBack: () => true,
				probe: (label) => (label?.includes("-pk1-") ? ONLINE : OFFLINE),
			}),
		).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			state.now s1-w0-t0
			state.begin s1-w0-w0 86431000
			announce s1-w0-n :: ⏸ **Runner unreachable — pau
			sleep s1-w0-p0
			tick s1-w0-k0 15000
			probe s1-w0-q0
			sleep s1-w0-p1
			tick s1-w0-k1 30000
			probe s1-w0-q1
			park.now s1-w0-pk
			probe s1-w0-pk-q
			park.begin s1-w0-pk-begin 86431000
			announce s1-w0-pk-n :: ⏸ **Runner away — the run is
			park.now s1-w0-pk0-at
			park.waitForBack s1-w0-pk0 600000
			park.now s1-w0-pk0-t
			tick s1-w0-pk0-k 600000
			probe s1-w0-pk0-w-q
			sleep s1-w0-pk0-w-p0
			tick s1-w0-pk0-w-k0 15000
			probe s1-w0-pk0-w-q0
			sleep s1-w0-pk0-w-p1
			tick s1-w0-pk0-w-k1 30000
			probe s1-w0-pk0-w-q1
			sleep s1-w0-pk0-w-p2
			tick s1-w0-pk0-w-k2 45000
			probe s1-w0-pk0-w-q2
			sleep s1-w0-pk0-w-p3
			tick s1-w0-pk0-w-k3 60000
			probe s1-w0-pk0-w-q3
			sleep s1-w0-pk0-w-p4
			tick s1-w0-pk0-w-k4 75000
			probe s1-w0-pk0-w-q4
			sleep s1-w0-pk0-w-p5
			tick s1-w0-pk0-w-k5 90000
			probe s1-w0-pk0-w-q5
			sleep s1-w0-pk0-w-p6
			tick s1-w0-pk0-w-k6 105000
			probe s1-w0-pk0-w-q6
			sleep s1-w0-pk0-w-p7
			tick s1-w0-pk0-w-k7 120000
			probe s1-w0-pk0-w-q7
			probe s1-w0-pk0-q
			park.now s1-w0-pk1-at
			park.waitForBack s1-w0-pk1 600000
			park.now s1-w0-pk1-t
			tick s1-w0-pk1-k 1320000
			probe s1-w0-pk1-w-q
			probe s1-w0-pk1-q
			park.end s1-w0-pk-end
			announce s1-w0-pk-back :: ▶️ **Runner is back** on mac
			reconnect s1-rc0
			step s1-r1
			=> resolved"
		`);
	});

	it("a session the runner lost over a live relay: relaunch, then the step again under its own name", async () => {
		expect(await record({ sessionLost: true, stepFails: (_n, i) => (i === 0 ? new Error("No coding session") : null) })).toMatchInlineSnapshot(`
			"step s1
			reconnect s1-lost0
			step s1-r1
			=> resolved"
		`);
	});

	it("a genuine error checks the relay and fails at once; an unanswerable check is unknown and fails at once too", async () => {
		const boom = () => new Error("boom");
		expect(await record({ stepFails: () => boom(), probe: () => ONLINE })).toMatchInlineSnapshot(`
			"step s1
			probe s1-chk0
			=> threw Error: boom"
		`);
		expect(await record({ stepFails: () => boom(), probe: () => "unknown" })).toMatchInlineSnapshot(`
			"step s1
			probe s1-chk0
			=> threw Error: boom"
		`);
	});

	it("a genuine error while the relay says disconnected waits, as a disconnect does", async () => {
		expect(await record({ stepFails: (_n, i) => (i === 0 ? new Error("boom") : null), probe: (_label, i) => (i < 4 ? OFFLINE : ONLINE) })).toMatchInlineSnapshot(`
			"step s1
			probe s1-chk0
			probe s1-w0-q
			announce s1-w0-n :: ⏸ **Runner unreachable — pau
			sleep s1-w0-p0
			tick s1-w0-k0 15000
			probe s1-w0-q0
			sleep s1-w0-p1
			tick s1-w0-k1 30000
			probe s1-w0-q1
			sleep s1-w0-p2
			tick s1-w0-k2 45000
			probe s1-w0-q2
			announce s1-w0-back :: ▶️ **Runner is back** on mac
			reconnect s1-rc0
			step s1-r1
			=> resolved"
		`);
	});

	it("a reconnect that meets the same disconnect waits again under a numbered tag", async () => {
		expect(await record({ withState: true, stepFails: (_n, i) => (i === 0 ? disconnect() : null), probe: after(2), reconnectFails: (_l, i) => (i === 0 ? disconnect() : null) })).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			state.now s1-w0-t0
			state.begin s1-w0-w0 601000
			announce s1-w0-n :: ⏸ **Runner unreachable — pau
			sleep s1-w0-p0
			tick s1-w0-k0 15000
			probe s1-w0-q0
			sleep s1-w0-p1
			tick s1-w0-k1 30000
			probe s1-w0-q1
			state.end s1-w0-w1
			announce s1-w0-back :: ▶️ **Runner is back** on mac
			reconnect s1-rc0
			probe s1-w0-1-q
			reconnect s1-rc0-1
			step s1-r1
			=> resolved"
		`);
	});

	it(`a flapping runner is re-attempted ${RECONNECT_ROUNDS} times under -r1…-r${RECONNECT_ROUNDS}, then the error escapes`, async () => {
		expect(await record({ stepFails: () => disconnect(), probe: () => ONLINE })).toMatchInlineSnapshot(`
			"step s1
			probe s1-w0-q
			reconnect s1-rc0
			step s1-r1
			probe s1-w1-q
			reconnect s1-rc1
			step s1-r2
			probe s1-w2-q
			reconnect s1-rc2
			step s1-r3
			=> threw RunnerUnreachableError: Runner disconnected"
		`);
	});

	it("never reuses a label within one guarded run (a Workflow step name must be unique)", async () => {
		const scenarios = [
			record({ withState: true, withPark: true, waitMsPerLoss: 2 * TICK, stepFails: (_n, i) => (i < 2 ? disconnect() : null), waitForBack: (_l, _m, n) => n % 2 === 1, probe: (label) => (label?.includes("-pk1-") || label?.includes("-w1-") ? ONLINE : OFFLINE) }),
			record({ withState: true, stepFails: (_n, i) => (i < 3 ? disconnect() : null), probe: after(1), reconnectFails: (_l, i) => (i === 0 ? disconnect() : null) }),
			record({ stepFails: () => disconnect(), probe: () => ONLINE }),
		];
		for (const text of await Promise.all(scenarios)) {
			const durable = text.split("\n").filter((l) => /^(step|sleep|probe|healthy|state\.now|state\.begin|state\.end|park\.now|park\.begin|park\.waitForBack|park\.end|announce|tick|reconnect) /.test(l));
			const keys = durable.map((l) => l.split(" ").slice(0, 2).join(" "));
			// `probe`/`healthy`/`tick`/`announce` journal by label; every labelled call is unique within a run
			expect(new Set(keys).size, `a label repeated in:\n${text}`).toBe(keys.length);
		}
	});
});
