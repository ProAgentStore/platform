import { describe, expect, it } from "vitest";
import { observedRunnerWork, readWorkLook, sessionStateCounts, sessionStateOf } from "./runner-work-observation.js";

/** #1020: the per-observation session counts use the guard's own rule, so counts and blocker cannot disagree. */
const IDLE_WORK = { codingTurns: 0, localRuns: 0, detail: [] };
const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: "fulfilled", value });
const failed: PromiseSettledResult<never> = { status: "rejected", reason: new Error("ECONNREFUSED") };

describe("sessionStateOf — one engine as the update guard reads it (#1020)", () => {
	it("idle retained, stopped, an active turn, and every unreadable shape as unknown", () => {
		expect(sessionStateOf({ alive: true, runState: "idle" })).toBe("idle_retained");
		expect(sessionStateOf({ alive: false, runState: "working" })).toBe("stopped");
		expect(sessionStateOf({ alive: true, runState: "working" })).toBe("active_turn");
		for (const s of [{ alive: true }, { runState: "idle" }, { alive: "yes", runState: "idle" }, { alive: true, runState: "" }, null, 7, "s"]) {
			expect(sessionStateOf(s), JSON.stringify(s)).toBe("unknown");
		}
	});
});

describe("session counts agree with the blocker, on every mix (#1020)", () => {
	const kinds = [
		{ alive: true, runState: "idle" },
		{ alive: false },
		{ alive: true, runState: "working" },
		{ alive: true },
		null,
	];
	// Every multiset of up to three engines drawn from the five kinds.
	const mixes: unknown[][] = [[]];
	for (let i = 0; i < 3; i++) for (const m of [...mixes]) for (const k of kinds) mixes.push([...m, k]);

	it("blocking sessions = active turns + unknown, idle retained and stopped never block", () => {
		for (const sessions of mixes) {
			const counts = sessionStateCounts(sessions);
			const busy = observedRunnerWork({ sessions, work: IDLE_WORK }).filter((b) => b.startsWith("coding session"));
			expect(busy.length, JSON.stringify(sessions)).toBe(counts.activeTurns + counts.unknown);
			expect(counts.activeTurns + counts.idleRetained + counts.stopped + counts.unknown).toBe(sessions.length);
		}
	});
});

describe("readWorkLook carries the counts on the sessions observation only (#1020)", () => {
	it("busy to idle: an active turn, then the same engine idle and retained", () => {
		const busy = readWorkLook(ok({ sessions: [{ sessionId: "s1", alive: true, runState: "working" }] }), ok({ work: { codingTurns: 1, localRuns: 0, detail: [] } }), 1);
		expect(busy.busy).toEqual(["coding session s1 (working)"]);
		expect(busy.observations[0].sessionStates).toEqual({ activeTurns: 1, idleRetained: 0, stopped: 0, unknown: 0 });
		const idle = readWorkLook(ok({ sessions: [{ sessionId: "s1", alive: true, runState: "idle" }] }), ok({ work: IDLE_WORK }), 2);
		expect(idle.busy).toEqual([]);
		expect(idle.observations[0].sessionStates).toEqual({ activeTurns: 0, idleRetained: 1, stopped: 0, unknown: 0 });
		expect(idle.observations[1]).toEqual({ source: "health", success: true, sampledAt: 2 });
	});

	it("a dead or malformed session is counted as such, and the malformed one still blocks", () => {
		const r = readWorkLook(ok({ sessions: [{ alive: false }, { alive: true }] }), ok({ work: IDLE_WORK }), 3);
		expect(r.observations[0].sessionStates).toEqual({ activeTurns: 0, idleRetained: 0, stopped: 1, unknown: 1 });
		expect(r.busy).toEqual(["coding session unidentified-session (unknown)"]);
	});

	it("no counts when the sessions look failed or was unreadable — and the guard stays closed", () => {
		const down = readWorkLook(failed, ok({ work: IDLE_WORK }), 4);
		expect(down.busy).toEqual(["runner-work-observation-unavailable"]);
		expect(down.observations[0]).toEqual({ source: "sessions", success: false, sampledAt: 4 });
		const unreadable = readWorkLook(ok({ sessions: "nope" as unknown as unknown[] }), ok({ work: IDLE_WORK }), 5);
		expect(unreadable.busy).toEqual(["runner-work-observation-unavailable"]);
		expect(unreadable.observations[0]).toEqual({ source: "sessions", success: false, sampledAt: 5, malformed: true });
	});

	it("carries no session id, state text or other content — counts only", () => {
		const r = readWorkLook(ok({ sessions: [{ sessionId: "csess_secret", alive: true, runState: "working", prompt: "p", cwd: "/x" }] }), ok({ work: { codingTurns: 1, localRuns: 0, detail: [] } }), 6);
		expect(JSON.stringify(r.observations)).not.toMatch(/csess_secret|working|prompt|cwd/);
	});
});
