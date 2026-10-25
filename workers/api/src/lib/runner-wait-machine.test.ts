import { describe, expect, it, vi } from "vitest";
import type { RuntimeFacts } from "./instance-connectivity.js";
import { RUNNER_PROBE_INTERVAL_MS } from "./runner-availability.js";
import { RUNNER_PROBE_INTERVAL_MS_M, checkRunner, labelFor, nextPark, nextWait, parkStart, waitStart, type Label, type Observation, type ParkAction, type ParkInput, type ParkState, type WaitAction, type WaitInput, type WaitState } from "./runner-wait-machine.js";

// #1359: the runner wait/park state machines are pure, so they are tested without a Workflow, a clock or a relay.
// runner-wait-labels.test.ts holds the byte-for-byte goldens of the names a whole guarded run emits.
const OFF: RuntimeFacts = { hasRuntimeRow: true, relayConnected: false, node: "macbook", runnerVersion: null, lastSeenAt: "2000-01-01 00:00:00" };
const ON: RuntimeFacts = { ...OFF, relayConnected: true };
const TICK = 15_000;

describe("the machine's copy of the probe interval", () => {
	it("is the real one (the machine cannot import it without a cycle)", () => {
		expect(RUNNER_PROBE_INTERVAL_MS_M).toBe(RUNNER_PROBE_INTERVAL_MS);
		expect(TICK).toBe(RUNNER_PROBE_INTERVAL_MS);
	});
});

describe("labelFor — the one place a step name is built", () => {
	it("freezes every shape", () => {
		const table: Array<[Label, string]> = [
			[{ of: "step", name: "s1", round: 0 }, "s1"],
			[{ of: "step", name: "s1", round: 2 }, "s1-r2"],
			[{ of: "lost", name: "s1", round: 1 }, "s1-lost1"],
			[{ of: "check", name: "s1", round: 0 }, "s1-chk0"],
			[{ of: "wait", name: "s1", round: 1, attempt: 0 }, "s1-w1"],
			[{ of: "wait", name: "s1", round: 1, attempt: 2 }, "s1-w1-2"],
			[{ of: "reconnect", name: "s1", round: 0, attempt: 0 }, "s1-rc0"],
			[{ of: "reconnect", name: "s1", round: 0, attempt: 1 }, "s1-rc0-1"],
			[{ of: "poll", base: "s1-w0", part: "q" }, "s1-w0-q"],
			[{ of: "poll", base: "s1-w0", part: "t0" }, "s1-w0-t0"],
			[{ of: "poll", base: "s1-w0", part: "w0" }, "s1-w0-w0"],
			[{ of: "poll", base: "s1-w0", part: "n" }, "s1-w0-n"],
			[{ of: "poll", base: "s1-w0", part: "w1" }, "s1-w0-w1"],
			[{ of: "poll", base: "s1-w0", part: "back" }, "s1-w0-back"],
			[{ of: "pollTick", base: "s1-w0", i: 3, part: "p" }, "s1-w0-p3"],
			[{ of: "pollTick", base: "s1-w0", i: 3, part: "k" }, "s1-w0-k3"],
			[{ of: "pollTick", base: "s1-w0", i: 3, part: "q" }, "s1-w0-q3"],
			[{ of: "pollTick", base: "s1-w0", i: 3, part: "h" }, "s1-w0-h3"],
			[{ of: "park", base: "s1-w0", part: "pk" }, "s1-w0-pk"],
			[{ of: "park", base: "s1-w0", part: "pk-q" }, "s1-w0-pk-q"],
			[{ of: "park", base: "s1-w0", part: "pk-begin" }, "s1-w0-pk-begin"],
			[{ of: "park", base: "s1-w0", part: "pk-n" }, "s1-w0-pk-n"],
			[{ of: "park", base: "s1-w0", part: "pk-end" }, "s1-w0-pk-end"],
			[{ of: "park", base: "s1-w0", part: "pk-back" }, "s1-w0-pk-back"],
			[{ of: "parkTick", base: "s1-w0", i: 1, part: "" }, "s1-w0-pk1"],
			[{ of: "parkTick", base: "s1-w0", i: 1, part: "at" }, "s1-w0-pk1-at"],
			[{ of: "parkTick", base: "s1-w0", i: 1, part: "t" }, "s1-w0-pk1-t"],
			[{ of: "parkTick", base: "s1-w0", i: 1, part: "k" }, "s1-w0-pk1-k"],
			[{ of: "parkTick", base: "s1-w0", i: 1, part: "w" }, "s1-w0-pk1-w"],
			[{ of: "parkTick", base: "s1-w0", i: 1, part: "q" }, "s1-w0-pk1-q"],
			[{ of: "parkTick", base: "s1-w0", i: 1, part: "h" }, "s1-w0-pk1-h"],
		];
		for (const [label, expected] of table) expect(labelFor(label)).toBe(expected);
	});

	it("is unique across a whole run's rounds, attempts and ticks, for several step names", () => {
		const seen = new Set<string>();
		let count = 0;
		const add = (l: Label) => {
			seen.add(labelFor(l));
			count++;
		};
		for (const name of ["s1", "s2", "s48-waitidle-c63"]) {
			for (let round = 0; round < 4; round++) {
				add({ of: "step", name, round });
				add({ of: "lost", name, round });
				add({ of: "check", name, round });
				for (let attempt = 0; attempt < 4; attempt++) {
					add({ of: "reconnect", name, round, attempt });
					const base = labelFor({ of: "wait", name, round, attempt });
					add({ of: "wait", name, round, attempt });
					for (const part of ["q", "t0", "w0", "n", "w1", "back"] as const) add({ of: "poll", base, part });
					for (let i = 0; i < 40; i++) for (const part of ["p", "k", "q", "h"] as const) add({ of: "pollTick", base, i, part });
					for (const part of ["pk", "pk-q", "pk-begin", "pk-n", "pk-end", "pk-back"] as const) add({ of: "park", base, part });
					for (let i = 0; i < 6; i++) for (const part of ["", "at", "t", "k", "w", "q", "h"] as const) add({ of: "parkTick", base, i, part });
				}
			}
		}
		expect(seen.size).toBe(count);
	});
});

/** Drive a machine with scripted observations until it is done; returns every action it asked for. */
function runWait(input: WaitInput, reply: (a: WaitAction, n: number) => Observation): WaitAction[] {
	const actions: WaitAction[] = [];
	let state: WaitState = waitStart;
	let obs: Observation = { ack: true };
	for (let n = 0; n < 500; n++) {
		const step = nextWait(input, state, obs);
		state = step.state;
		actions.push(step.action);
		if (step.action.do === "done") return actions;
		obs = reply(step.action, n);
	}
	throw new Error("the wait machine did not finish");
}
const checkReply = (facts: RuntimeFacts, answered = facts.relayConnected): Observation => ({ facts, answered });

describe("nextWait", () => {
	const input = (over: Partial<WaitInput> = {}): WaitInput => ({ label: "s1-w0", waitMs: 3 * TICK, unresponsive: false, extraMs: 0, ...over });

	it("returns at once, announcing nothing, when the runner is already back", () => {
		const acts = runWait(input(), (a) => (a.do === "check" ? checkReply(ON) : { ack: true }));
		expect(acts.map((a) => a.do)).toEqual(["check", "done"]);
		expect(acts.at(-1)).toEqual({ do: "done", result: { returned: true, waitedMs: 0 } });
	});

	it("does NOT trust that instant read after an unanswered command", () => {
		const acts = runWait(input({ unresponsive: true, waitMs: TICK }), (a) => (a.do === "check" ? checkReply(ON, !a.target.health) : a.do === "now" ? { time: 5 } : { ack: true }));
		expect(acts.map((a) => a.do)).toContain("sleep");
		expect(acts.at(-1)).toEqual({ do: "done", result: expect.objectContaining({ returned: false, waitedMs: TICK }) });
	});

	it("announces once, records the wait's end instant, sleeps and ticks each interval, and says it is back", () => {
		let probes = 0;
		const acts = runWait(input({ extraMs: 1000 }), (a) => {
			if (a.do === "check") return checkReply(probes++ >= 3 ? ON : OFF);
			if (a.do === "now") return { time: 100 };
			return { ack: true };
		});
		expect(acts).toContainEqual({ do: "begin", label: "s1-w0-w0", until: 100 + 3 * TICK + 1000 });
		expect(acts.filter((a) => a.do === "say")).toHaveLength(2);
		expect(acts.filter((a) => a.do === "sleep").map((a) => (a as { label: string }).label)).toEqual(["s1-w0-p0", "s1-w0-p1", "s1-w0-p2"]);
		expect(acts.filter((a) => a.do === "tick").map((a) => (a as { waitedMs: number }).waitedMs)).toEqual([TICK, 2 * TICK, 3 * TICK]);
		expect(acts.at(-1)).toEqual({ do: "done", result: { returned: true, waitedMs: 3 * TICK } });
	});

	it("asks for a health answer only when the command went unanswered, and a listed socket alone is not 'back'", () => {
		const silent = runWait(input({ unresponsive: true }), (a) => (a.do === "check" ? checkReply(ON, false) : a.do === "now" ? { time: 0 } : { ack: true }));
		const targets = silent.filter((a) => a.do === "check").map((a) => (a as { target: { probe?: string; health?: string } }).target);
		expect(targets[0]).toEqual({ probe: "s1-w0-q" });
		expect(targets.slice(1)).toEqual([0, 1, 2].map((i) => ({ probe: `s1-w0-q${i}`, health: `s1-w0-h${i}` })));
		const plain = runWait(input(), (a) => (a.do === "check" ? checkReply(OFF) : a.do === "now" ? { time: 0 } : { ack: true }));
		expect(plain.filter((a) => a.do === "check").every((a) => !(a as { target: { health?: string } }).target.health)).toBe(true);
	});

	it("gives up after the budget with the last facts, counted in ticks", () => {
		const acts = runWait(input(), (a) => (a.do === "check" ? checkReply(OFF) : a.do === "now" ? { time: 0 } : { ack: true }));
		expect(acts.at(-1)).toEqual({ do: "done", result: { returned: false, waitedMs: 3 * TICK, facts: OFF } });
	});

	it("a budget under one interval waits for nothing and announces nothing", () => {
		const acts = runWait(input({ waitMs: TICK - 1 }), (a) => (a.do === "check" ? checkReply(OFF) : { ack: true }));
		expect(acts.map((a) => a.do)).toEqual(["check", "done"]);
		expect(acts.at(-1)).toEqual({ do: "done", result: { returned: false, waitedMs: 0, facts: OFF } });
	});

	it("is pure and refuses to be driven past its end", () => {
		const first = nextWait(input(), waitStart, { ack: true });
		expect(nextWait(input(), waitStart, { ack: true })).toEqual(first);
		expect(() => nextWait(input(), { at: "finished" }, { ack: true })).toThrow(/past its end/);
	});
});

function runPark(input: ParkInput, reply: (a: ParkAction, n: number) => Observation): ParkAction[] {
	const actions: ParkAction[] = [];
	let state: ParkState = parkStart;
	let obs: Observation = { ack: true };
	for (let n = 0; n < 500; n++) {
		const step = nextPark(input, state, obs);
		state = step.state;
		actions.push(step.action);
		if (step.action.do === "done") return actions;
		obs = reply(step.action, n);
	}
	throw new Error("the park machine did not finish");
}

describe("nextPark", () => {
	const input = (over: Partial<ParkInput> = {}): ParkInput => ({ base: "s1-w0", unresponsive: false, parkTotal: 60 * 60_000, parked: 0, wakePollMs: 120_000, checkMs: 600_000, ...over });
	/** A clock that advances by each park wait's timeout. */
	function world(opts: { woken?: (n: number) => boolean; back?: (n: number) => boolean; waitReturns?: boolean }) {
		let clock = 1_000;
		let waits = 0;
		let checks = 0;
		return (a: ParkAction): Observation => {
			switch (a.do) {
				case "now":
					return { time: clock };
				case "waitBack":
					clock += a.timeoutMs;
					return { woken: opts.woken ? opts.woken(waits++) : false };
				case "wait":
					return { wait: opts.waitReturns ? { returned: true, waitedMs: 1 } : { returned: false, waitedMs: a.waitMs, facts: OFF } };
				case "check": {
					const on = opts.back ? opts.back(checks++) : false;
					const facts = on ? ON : OFF;
					return { facts, answered: facts.relayConnected };
				}
				default:
					return { ack: true };
			}
		};
	}

	it("announces the park, checks every interval, and returns when the machine answers, naming how long it was parked", () => {
		const acts = runPark(input(), (() => {
			const w = world({ back: (n) => n >= 3 });
			return (a) => w(a);
		})());
		expect(acts.find((a) => a.do === "begin")).toMatchObject({ label: "s1-w0-pk-begin", until: 1_000 + 60 * 60_000 });
		expect(acts.filter((a) => a.do === "waitBack").map((a) => (a as { timeoutMs: number }).timeoutMs)).toEqual([600_000, 600_000, 600_000]);
		const last = acts.at(-1);
		expect(last).toEqual({ do: "done", result: { kind: "back", parkedMs: 1_800_000 } });
		expect(acts.map((a) => a.do).slice(-3)).toEqual(["end", "say", "done"]);
	});

	it("ends the park when the run's budget is spent: ends the record, then reports the spend", () => {
		const acts = runPark(input({ parkTotal: 25 * 60_000 }), world({}));
		expect(acts.at(-1)).toMatchObject({ do: "done", result: { kind: "expired", parkedMs: 25 * 60_000 } });
		expect(acts.at(-2)).toEqual({ do: "end", label: "s1-w0-pk-end" });
		// the last check is shortened to the time left, never past the deadline
		expect(Math.min(...acts.filter((a) => a.do === "waitBack").map((a) => (a as { timeoutMs: number }).timeoutMs))).toBeLessThanOrEqual(600_000);
	});

	it("a park with nothing left expires at once, without recording anything", () => {
		const acts = runPark(input({ parked: 60 * 60_000 }), world({}));
		expect(acts.map((a) => a.do)).toEqual(["now", "check", "done"]);
		expect(acts.at(-1)).toMatchObject({ do: "done", result: { kind: "expired", parkedMs: 60 * 60_000 } });
	});

	it("a woken machine gets a quiet poll first, and when it returned the health check is NOT asked again", () => {
		const acts = runPark(input({ unresponsive: true }), world({ woken: () => true, waitReturns: true }));
		const wait = acts.find((a) => a.do === "wait");
		expect(wait).toEqual({ do: "wait", label: "s1-w0-pk0-w", waitMs: 120_000 });
		const check = acts.find((a) => a.do === "check" && (a as { target: { probe?: string } }).target.probe === "s1-w0-pk0-q") as { target: { health?: string } };
		expect(check.target.health).toBeUndefined();
		expect(acts.at(-1)).toMatchObject({ do: "done", result: { kind: "back" } });
	});

	it("without a wake it asks for health on its own check when the command went unanswered", () => {
		const acts = runPark(input({ unresponsive: true }), world({ back: () => true }));
		const check = acts.find((a) => a.do === "check" && (a as { target: { probe?: string } }).target.probe === "s1-w0-pk0-q") as { target: { health?: string } };
		expect(check.target.health).toBe("s1-w0-pk0-h");
	});

	it("is refused past its end", () => {
		expect(() => nextPark(input(), { at: "finished" }, { ack: true })).toThrow(/past its end/);
	});
});

describe("checkRunner — the one health check", () => {
	it("reads connectivity only at depth relay, and never asks the runner", async () => {
		const healthy = vi.fn(async () => true);
		const r = await checkRunner({ probe: async () => ON, healthy }, { probe: "p", health: "h" }, { depth: "relay" });
		expect(r).toEqual({ facts: ON, answered: true });
		expect(healthy).not.toHaveBeenCalled();
	});

	it("at depth health asks the runner to ANSWER, but only when its socket is listed", async () => {
		const healthy = vi.fn(async () => false);
		expect((await checkRunner({ probe: async () => ON, healthy }, { probe: "p", health: "h" }, { depth: "health" })).answered).toBe(false);
		expect(healthy).toHaveBeenCalledWith("h");
		healthy.mockClear();
		expect((await checkRunner({ probe: async () => OFF, healthy }, { probe: "p", health: "h" }, { depth: "health" })).answered).toBe(false);
		expect(healthy).not.toHaveBeenCalled();
	});

	it("a health check that throws is 'did not answer'; a probe that throws propagates; no health dep means connectivity decides", async () => {
		expect((await checkRunner({ probe: async () => ON, healthy: async () => { throw new Error("x"); } }, { probe: "p", health: "h" }, { depth: "health" })).answered).toBe(false);
		await expect(checkRunner({ probe: async () => { throw new Error("blip"); } }, { probe: "p" }, { depth: "relay" })).rejects.toThrow("blip");
		expect((await checkRunner({ probe: async () => ON }, { probe: "p", health: "h" }, { depth: "health" })).answered).toBe(true);
	});

	it("passes the probe's label through, and none when there is none (a live read)", async () => {
		const probe = vi.fn(async (_l?: string) => ON);
		await checkRunner({ probe }, { probe: "s1-w0-q" }, { depth: "relay" });
		await checkRunner({ probe }, {}, { depth: "relay" });
		expect(probe.mock.calls.map((c) => c[0])).toEqual(["s1-w0-q", undefined]);
	});
});
