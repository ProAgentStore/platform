import { describe, expect, it } from "vitest";
import {
	classifyTurn,
	EMPTY_STREAK,
	engineFailureDetail,
	engineFailureNote,
	MAX_ENGINE_FAILURES,
	observeTurn,
	TURN_REPORT_MIN_CLI,
} from "./coding-turn-outcome.js";

const failedAt = (at: number, detail?: string) => ({ verdict: "failed", exitCode: 1, signal: null, at, ...(detail ? { detail } : {}) });
const okAt = (at: number) => ({ verdict: "ok", exitCode: 0, signal: null, at });

describe("classifyTurn — absence is not a verdict (#545)", () => {
	it("reads a runner that does not report the field as UNKNOWN, never as failed", () => {
		// Every machine below CLI TURN_REPORT_MIN_CLI sends no `lastTurn` at all. A cloud that read
		// that as failure would end three runs on every un-updated laptop the day it deployed.
		expect(classifyTurn(undefined)).toBe("unknown");
		expect(classifyTurn(null)).toBe("unknown");
		expect(classifyTurn({})).toBe("unknown");
		expect(TURN_REPORT_MIN_CLI).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("reads an unrecognised verdict as unknown — the runner may be NEWER than this Worker", () => {
		expect(classifyTurn({ verdict: "something-new", at: 1 })).toBe("unknown");
	});

	it("passes the three verdicts through", () => {
		expect(classifyTurn(okAt(1))).toBe("ok");
		expect(classifyTurn(failedAt(1))).toBe("failed");
		expect(classifyTurn({ verdict: "killed", exitCode: null, signal: "SIGTERM", at: 1 })).toBe("killed");
	});
});

describe("observeTurn — a streak counts TURNS, not sightings (#545)", () => {
	it("counts one failure once, however many polls see it", () => {
		// The loop re-reads the same report on the top-of-step snapshot, the waitIdle result and
		// the next step's snapshot. Counting sightings would reach the bound of 3 on a single
		// failed turn — which is precisely the over-reaction this issue warns against.
		const report = failedAt(1000, "Not inside a trusted directory");
		let s = EMPTY_STREAK;
		const first = observeTurn(s, report);
		expect(first.newFailure).toBe(true);
		expect(first.streak.consecutive).toBe(1);
		s = first.streak;
		for (let i = 0; i < 5; i++) {
			const again = observeTurn(s, report);
			expect(again.newFailure).toBe(false);
			expect(again.streak.consecutive).toBe(1);
			s = again.streak;
		}
	});

	it("accumulates DISTINCT failed turns and carries the engine's own last words", () => {
		let s = EMPTY_STREAK;
		s = observeTurn(s, failedAt(1, "first")).streak;
		s = observeTurn(s, failedAt(2, "second")).streak;
		s = observeTurn(s, failedAt(3, "third")).streak;
		expect(s.consecutive).toBe(3);
		expect(s.lastDetail).toBe("third");
	});

	it("a successful turn RESETS the streak", () => {
		// The bound is consecutive on purpose: an engine that exits non-zero having run a failing
		// test suite, then works, is a working engine. A total counter would kill that run.
		let s = EMPTY_STREAK;
		s = observeTurn(s, failedAt(1)).streak;
		s = observeTurn(s, failedAt(2)).streak;
		expect(s.consecutive).toBe(2);
		s = observeTurn(s, okAt(3)).streak;
		expect(s.consecutive).toBe(0);
		s = observeTurn(s, failedAt(4)).streak;
		expect(s.consecutive).toBe(1);
	});

	it("a turn WE killed counts as neither — and does not reset a real streak", () => {
		// The wedge ceiling and an interrupt are this platform's doing. Counting them would let
		// three slow builds read as a broken CLI; RESETTING on them would let a wedge in the middle
		// of three refusals hide the refusals.
		let s = EMPTY_STREAK;
		s = observeTurn(s, failedAt(1)).streak;
		const killed = observeTurn(s, { verdict: "killed", exitCode: null, signal: "SIGTERM", at: 2 });
		expect(killed.newFailure).toBe(false);
		expect(killed.streak.consecutive).toBe(1);
		s = observeTurn(killed.streak, failedAt(3)).streak;
		expect(s.consecutive).toBe(2);
	});

	it("ignores an unknown report entirely — it neither counts nor resets", () => {
		let s = observeTurn(EMPTY_STREAK, failedAt(1)).streak;
		s = observeTurn(s, undefined).streak;
		expect(s.consecutive).toBe(1);
		expect(s.lastAt).toBe(1);
	});
});

describe("what the brain and the human are told", () => {
	it("the brain's note names the CLASS of problem, not just the exit code", () => {
		// The production failure was the brain reading "Not inside a trusted directory" as a PATH
		// problem and trying three path variants in eight seconds. No rephrasing addresses an engine
		// that refuses to start, so the note has to say so in as many words.
		const s = observeTurn(EMPTY_STREAK, failedAt(1, "Not inside a trusted directory and --skip-git-repo-check was not specified.")).streak;
		const note = engineFailureNote(s);
		expect(note).toContain("exited with code 1");
		expect(note).toContain("Not inside a trusted directory");
		expect(note).toMatch(/refusing to run/i);
		expect(note).toMatch(/not an answer to your instruction/i);
	});

	it("states how many in a row it measured, per ADR 0002", () => {
		let s = observeTurn(EMPTY_STREAK, failedAt(1)).streak;
		expect(engineFailureNote(s)).not.toContain("consecutive"); // one is one; no count to state
		s = observeTurn(s, failedAt(2)).streak;
		expect(engineFailureNote(s)).toContain("2 consecutive failed turns");
	});

	it("the human's detail quotes the engine, counts the turns, and names the repo", () => {
		let s = EMPTY_STREAK;
		for (let i = 1; i <= MAX_ENGINE_FAILURES; i++) s = observeTurn(s, failedAt(i, "--skip-git-repo-check was not specified")).streak;
		const detail = engineFailureDetail(s, "aipa");
		expect(detail).toContain("in aipa");
		expect(detail).toContain(`on ${MAX_ENGINE_FAILURES} consecutive turns`);
		expect(detail).toContain("--skip-git-repo-check was not specified");
	});

	it("does not invent an exit code the engine never reported", () => {
		// Claude's stream-json path has no exit code — the verdict comes from `is_error`. Saying
		// "exited with code null" would be worse than the sentence it replaces.
		const s = observeTurn(EMPTY_STREAK, { verdict: "failed", exitCode: null, signal: null, at: 1 }).streak;
		expect(engineFailureNote(s)).toContain("reported the turn as failed");
		expect(engineFailureNote(s)).not.toContain("code null");
	});
});
