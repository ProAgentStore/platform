/**
 * The runner wait and park as explicit state machines (#1359).
 *
 * `waitForRunner` and the guard's `parkUntilBack` used to be loops with closure counters and step labels assembled by
 * template string at each call site. A Workflow replays its body and matches durable steps BY NAME, so a label that changed,
 * or collided with another in the same run, broke the replay of every run waiting on its machine — and a parked run can
 * wait a day. Here each is a pure `next(state, observation) → { state, action }`, the driver in `runner-availability.ts`
 * performs the action and feeds back what it saw, and every label comes from {@link labelFor}.
 *
 * Nothing in this file talks to the world: no probe, no sleep, no clock. The names are FROZEN by
 * `runner-wait-labels.test.ts`, whose goldens were recorded from the loops this replaced.
 */
import type { RuntimeFacts } from "./instance-connectivity.js";

/** One probe the machine can ask the driver for. `health` is set when "back" must also mean "answers its health check" (#1341). */
export interface CheckTarget {
	probe?: string;
	health?: string;
}

export const RUNNER_PROBE_INTERVAL_MS_M = 15_000;

// ── Labels ──────────────────────────────────────────────────────────────────

/** A part of a labelled sequence hanging off a base label. */
export type PollPart = "q" | "t0" | "w0" | "n" | "w1" | "back";
export type PollTickPart = "p" | "k" | "q" | "h";
export type ParkPart = "pk" | "pk-q" | "pk-begin" | "pk-n" | "pk-end" | "pk-back";
export type ParkTickPart = "at" | "" | "t" | "k" | "w" | "q" | "h";

export type Label =
	/** A guarded step: the first attempt keeps the caller's name, a re-attempt gets its own (a step name is unique within an instance). */
	| { of: "step"; name: string; round: number }
	| { of: "lost"; name: string; round: number }
	| { of: "check"; name: string; round: number }
	/** The wait for one loss; `attempt` > 0 is a reconnect that met the same disconnect (#913). */
	| { of: "wait"; name: string; round: number; attempt: number }
	| { of: "reconnect"; name: string; round: number; attempt: number }
	| { of: "poll"; base: string; part: PollPart }
	| { of: "pollTick"; base: string; i: number; part: PollTickPart }
	| { of: "park"; base: string; part: ParkPart }
	| { of: "parkTick"; base: string; i: number; part: ParkTickPart };

const tagOf = (round: number, attempt: number) => (attempt === 0 ? `${round}` : `${round}-${attempt}`);

/** The ONE place a runner-wait Workflow step name is built. Frozen by `runner-wait-labels.test.ts`. */
export function labelFor(l: Label): string {
	switch (l.of) {
		case "step":
			return l.round === 0 ? l.name : `${l.name}-r${l.round}`;
		case "lost":
			return `${l.name}-lost${l.round}`;
		case "check":
			return `${l.name}-chk${l.round}`;
		case "wait":
			return `${l.name}-w${tagOf(l.round, l.attempt)}`;
		case "reconnect":
			return `${l.name}-rc${tagOf(l.round, l.attempt)}`;
		case "poll":
			return `${l.base}-${l.part}`;
		case "pollTick":
			return `${l.base}-${l.part}${l.i}`;
		case "park":
			return `${l.base}-${l.part}`;
		case "parkTick":
			return l.part === "" ? `${l.base}-pk${l.i}` : `${l.base}-pk${l.i}-${l.part}`;
	}
}

// ── What a machine says and hears ───────────────────────────────────────────

/** A sentence the driver words from facts it already holds. */
export type Say =
	| { kind: "pause"; facts: RuntimeFacts; waitMs: number; slow: boolean }
	| { kind: "resume"; node: string | null; waitedMs: number }
	| { kind: "park"; facts: RuntimeFacts; until: number; left: number };

export type Observation = { facts: RuntimeFacts; answered: boolean } | { time: number } | { woken: boolean } | { wait: WaitDone } | { ack: true } | { start: true };

export type WaitDone = { returned: true; waitedMs: number } | { returned: false; waitedMs: number; facts: RuntimeFacts };

export type WaitAction =
	| { do: "check"; target: CheckTarget }
	| { do: "now"; label: string }
	| { do: "begin"; label: string; until: number }
	| { do: "end"; label: string }
	| { do: "say"; say: Say; label: string }
	| { do: "sleep"; label: string }
	| { do: "tick"; waitedMs: number; label: string }
	| { do: "done"; result: WaitDone };

// ── The wait ────────────────────────────────────────────────────────────────

export interface WaitInput {
	label: string;
	waitMs: number;
	unresponsive: boolean;
	extraMs: number;
}

export type WaitState =
	| { at: "start" }
	| { at: "probed"; ticks: number }
	| { at: "clocked"; ticks: number; facts: RuntimeFacts }
	| { at: "begun"; ticks: number; facts: RuntimeFacts }
	| { at: "announced"; ticks: number; facts: RuntimeFacts }
	| { at: "slept"; ticks: number; i: number; facts: RuntimeFacts }
	| { at: "ticked"; ticks: number; i: number; facts: RuntimeFacts }
	| { at: "checked"; ticks: number; i: number }
	| { at: "ended"; ticks: number; i: number; facts: RuntimeFacts }
	| { at: "resumed"; waitedMs: number }
	| { at: "finished" };

export const waitStart: WaitState = { at: "start" };

const L = (base: string, part: PollPart): string => labelFor({ of: "poll", base, part });
const LT = (base: string, i: number, part: PollTickPart): string => labelFor({ of: "pollTick", base, i, part });

function sleepFor(input: WaitInput, ticks: number, i: number, facts: RuntimeFacts): { state: WaitState; action: WaitAction } {
	if (i >= ticks) return { state: { at: "finished" }, action: { do: "done", result: { returned: false, waitedMs: ticks * RUNNER_PROBE_INTERVAL_MS_M, facts } } };
	return { state: { at: "slept", ticks, i, facts }, action: { do: "sleep", label: LT(input.label, i, "p") } };
}

/** The wait for a runner to come back: `next(state, observation) → { state, action }`. Pure. */
export function nextWait(input: WaitInput, state: WaitState, obs: Observation): { state: WaitState; action: WaitAction } {
	switch (state.at) {
		case "start":
			// The instant read is journalled under `-q`.
			return { state: { at: "probed", ticks: Math.max(0, Math.floor(input.waitMs / RUNNER_PROBE_INTERVAL_MS_M)) }, action: { do: "check", target: { probe: L(input.label, "q") } } };
		case "probed": {
			const facts = (obs as { facts: RuntimeFacts }).facts;
			// Healed between the failure and this probe — unless the runner did not ANSWER, where the instant read is the one fact not to trust (#913).
			if (facts.relayConnected && !input.unresponsive) return { state: { at: "finished" }, action: { do: "done", result: { returned: true, waitedMs: 0 } } };
			if (state.ticks > 0) return { state: { at: "clocked", ticks: state.ticks, facts }, action: { do: "now", label: L(input.label, "t0") } };
			return sleepFor(input, state.ticks, 0, facts);
		}
		case "clocked":
			// The wait is run state before it is a notice (#1177): `runner_away` until the instant it gives up.
			return { state: { at: "begun", ticks: state.ticks, facts: state.facts }, action: { do: "begin", label: L(input.label, "w0"), until: (obs as { time: number }).time + input.waitMs + input.extraMs } };
		case "begun":
			return {
				state: { at: "announced", ticks: state.ticks, facts: state.facts },
				action: { do: "say", label: L(input.label, "n"), say: { kind: "pause", facts: state.facts, waitMs: input.waitMs, slow: input.unresponsive && state.facts.relayConnected } },
			};
		case "announced":
			return sleepFor(input, state.ticks, 0, state.facts);
		case "slept":
			return { state: { at: "ticked", ticks: state.ticks, i: state.i, facts: state.facts }, action: { do: "tick", waitedMs: (state.i + 1) * RUNNER_PROBE_INTERVAL_MS_M, label: LT(input.label, state.i, "k") } };
		case "ticked":
			return { state: { at: "checked", ticks: state.ticks, i: state.i }, action: { do: "check", target: { probe: LT(input.label, state.i, "q"), ...(input.unresponsive ? { health: LT(input.label, state.i, "h") } : {}) } } };
		case "checked": {
			const o = obs as { facts: RuntimeFacts; answered: boolean };
			if (o.facts.relayConnected && o.answered) return { state: { at: "ended", ticks: state.ticks, i: state.i, facts: o.facts }, action: { do: "end", label: L(input.label, "w1") } };
			return sleepFor(input, state.ticks, state.i + 1, o.facts);
		}
		case "ended": {
			const waitedMs = (state.i + 1) * RUNNER_PROBE_INTERVAL_MS_M;
			return { state: { at: "resumed", waitedMs }, action: { do: "say", label: L(input.label, "back"), say: { kind: "resume", node: state.facts.node, waitedMs } } };
		}
		case "resumed":
			return { state: { at: "finished" }, action: { do: "done", result: { returned: true, waitedMs: state.waitedMs } } };
		case "finished":
			throw new Error("the runner wait machine was driven past its end");
	}
}

// ── The park ────────────────────────────────────────────────────────────────

export interface ParkInput {
	/** The label of the wait that ran out: every park label hangs off it. */
	base: string;
	unresponsive: boolean;
	/** The run's park budget and what it has already spent (`parkTotal`, `parked`). */
	parkTotal: number;
	parked: number;
	/** The wake poll's budget (RUNNER_WAKE_POLL_MS) and the longest single park check (RUNNER_PARK_CHECK_MS). */
	wakePollMs: number;
	checkMs: number;
}

export type ParkAction =
	| { do: "now"; label: string }
	| { do: "check"; target: CheckTarget }
	| { do: "begin"; label: string; until: number }
	| { do: "end"; label: string }
	| { do: "say"; say: Say; label: string }
	| { do: "waitBack"; label: string; timeoutMs: number }
	| { do: "tick"; waitedMs: number; label: string }
	| { do: "wait"; label: string; waitMs: number }
	| { do: "done"; result: ParkDone };

/**
 * `back`: the machine answered again; `parkedMs` is what to add to the run's park spend.
 * `expired`: the park budget is spent; `parkedMs` is what the run has now spent (and what the message names), `facts` the last read.
 */
export type ParkDone = { kind: "back"; parkedMs: number } | { kind: "expired"; parkedMs: number; facts: RuntimeFacts };

interface ParkCtx {
	start: number;
	until: number;
	i: number;
	facts: RuntimeFacts;
}

export type ParkState =
	| { at: "start" }
	| { at: "clocked" }
	| { at: "probed"; start: number }
	| { at: "begun"; c: ParkCtx }
	| { at: "announced"; c: ParkCtx }
	| { at: "dated"; c: ParkCtx }
	| { at: "ending"; c: ParkCtx }
	| { at: "waited"; c: ParkCtx }
	| { at: "timed"; c: ParkCtx; woken: boolean }
	| { at: "ticked"; c: ParkCtx; woken: boolean; now: number }
	| { at: "polled"; c: ParkCtx; now: number; backReturned: boolean }
	| { at: "settled"; c: ParkCtx; now: number }
	| { at: "resumed"; c: ParkCtx; now: number }
	| { at: "finished" };

export const parkStart: ParkState = { at: "start" };

const P = (base: string, part: ParkPart): string => labelFor({ of: "park", base, part });
const PT = (base: string, i: number, part: ParkTickPart): string => labelFor({ of: "parkTick", base, i, part });

/** The park of a run on its machine until it is back or the run's park budget is spent: `next(state, observation) → { state, action }`. Pure. */
export function nextPark(input: ParkInput, state: ParkState, obs: Observation): { state: ParkState; action: ParkAction } {
	const b = input.base;
	const done = (result: ParkDone): { state: ParkState; action: ParkAction } => ({ state: { at: "finished" }, action: { do: "done", result } });
	switch (state.at) {
		case "start":
			return { state: { at: "clocked" }, action: { do: "now", label: P(b, "pk") } };
		case "clocked":
			return { state: { at: "probed", start: (obs as { time: number }).time }, action: { do: "check", target: { probe: P(b, "pk-q") } } };
		case "probed": {
			const facts = (obs as { facts: RuntimeFacts }).facts;
			const left = input.parkTotal - input.parked;
			if (left <= 0) return done({ kind: "expired", parkedMs: input.parked, facts });
			const until = state.start + left;
			return { state: { at: "begun", c: { start: state.start, until, i: 0, facts } }, action: { do: "begin", label: P(b, "pk-begin"), until } };
		}
		case "begun":
			// The wake poll below neither announces nor touches the wait state: the park owns both until it ends.
			return { state: { at: "announced", c: state.c }, action: { do: "say", label: P(b, "pk-n"), say: { kind: "park", facts: state.c.facts, until: state.c.until, left: state.c.until - state.c.start } } };
		case "announced":
			return { state: { at: "dated", c: state.c }, action: { do: "now", label: PT(b, state.c.i, "at") } };
		case "dated": {
			const at = (obs as { time: number }).time;
			if (at >= state.c.until) return { state: { at: "ending", c: state.c }, action: { do: "end", label: P(b, "pk-end") } };
			return { state: { at: "waited", c: state.c }, action: { do: "waitBack", label: PT(b, state.c.i, ""), timeoutMs: Math.min(input.checkMs, state.c.until - at) } };
		}
		case "ending":
			return done({ kind: "expired", parkedMs: input.parkTotal, facts: state.c.facts });
		case "waited":
			return { state: { at: "timed", c: state.c, woken: (obs as { woken: boolean }).woken }, action: { do: "now", label: PT(b, state.c.i, "t") } };
		case "timed": {
			const now = (obs as { time: number }).time;
			return { state: { at: "ticked", c: state.c, woken: state.woken, now }, action: { do: "tick", waitedMs: now - state.c.start, label: PT(b, state.c.i, "k") } };
		}
		case "ticked":
			// A woken machine gets a short, quiet poll before the park looks for itself.
			if (state.woken) return { state: { at: "polled", c: state.c, now: state.now, backReturned: false }, action: { do: "wait", label: PT(b, state.c.i, "w"), waitMs: input.wakePollMs } };
			return { state: { at: "polled", c: state.c, now: state.now, backReturned: false }, action: { do: "check", target: checkTarget(b, state.c.i, input.unresponsive) } };
		case "polled": {
			if ("wait" in obs) {
				// The poll answered. Probe either way, but when it already returned the health check is not asked again.
				const backReturned = obs.wait.returned;
				return { state: { at: "polled", c: state.c, now: state.now, backReturned }, action: { do: "check", target: backReturned ? { probe: PT(b, state.c.i, "q") } : checkTarget(b, state.c.i, input.unresponsive) } };
			}
			const o = obs as { facts: RuntimeFacts; answered: boolean };
			const c = { ...state.c, facts: o.facts };
			if (state.backReturned || (o.facts.relayConnected && o.answered)) return { state: { at: "settled", c, now: state.now }, action: { do: "end", label: P(b, "pk-end") } };
			return { state: { at: "dated", c: { ...c, i: c.i + 1 } }, action: { do: "now", label: PT(b, c.i + 1, "at") } };
		}
		case "settled":
			return { state: { at: "resumed", c: state.c, now: state.now }, action: { do: "say", label: P(b, "pk-back"), say: { kind: "resume", node: state.c.facts.node, waitedMs: state.now - state.c.start } } };
		case "resumed":
			return done({ kind: "back", parkedMs: state.now - state.c.start });
		case "finished":
			throw new Error("the runner park machine was driven past its end");
	}
}

const checkTarget = (base: string, i: number, unresponsive: boolean): CheckTarget => ({ probe: PT(base, i, "q"), ...(unresponsive ? { health: PT(base, i, "h") } : {}) });

// ── One health check ────────────────────────────────────────────────────────

/**
 * The single way the wait and the park ask "is the runner there?" (#1341). `depth: "relay"` reads connectivity only;
 * `"health"` also asks the runner to ANSWER, but only when its socket is listed — a connected socket alone is not "back" after
 * an unanswered command. Every call is journalled under its labels. A probe that throws propagates (the caller decides what an
 * unreadable probe means); a health check that throws is "did not answer".
 */
export async function checkRunner(
	deps: { probe: (label?: string) => Promise<RuntimeFacts>; healthy?: (label: string) => Promise<boolean> },
	target: CheckTarget,
	opts: { depth: "relay" | "health" },
): Promise<{ facts: RuntimeFacts; answered: boolean }> {
	const facts = await deps.probe(target.probe);
	if (!facts.relayConnected) return { facts, answered: false };
	if (opts.depth === "relay" || !target.health || !deps.healthy) return { facts, answered: true };
	return { facts, answered: await deps.healthy(target.health).catch(() => false) };
}
