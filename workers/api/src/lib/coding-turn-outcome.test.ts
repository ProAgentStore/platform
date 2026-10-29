import { describe, expect, it } from "vitest";
import {
	classifyTurn,
	EMPTY_STREAK,
	engineFailureDetail,
	engineFailureNote,
	foldTurn,
	MAX_ENGINE_FAILURES,
	type TurnCarry,
	observeTurn,
	TURN_REPORT_MIN_CLI,
} from "./coding-turn-outcome.js";

const failedAt = (at: number, detail?: string) => ({ verdict: "failed", exitCode: 1, signal: null, at, ...(detail ? { detail } : {}) });
const okAt = (at: number) => ({ verdict: "ok", exitCode: 0, signal: null, at });
/** The effects the Pilot and the owner read — the structured `provider_*` events (#1391) are set aside; their own tests pin them. */
const legacy = <T extends { event?: { name: string } }>(effects: T[]): T[] => effects.filter((e) => !e.event?.name.startsWith("provider_"));

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

describe("the engine's own output reaches the failure summary (#889)", () => {
	const failedWith = (at: number, tail: string[] | undefined, detail?: string) => ({ ...failedAt(at, detail), ...(tail ? { tail } : {}) });
	const threeOf = (tail: string[] | undefined, detail?: string) => {
		let s = EMPTY_STREAK;
		for (let i = 1; i <= MAX_ENGINE_FAILURES; i++) s = observeTurn(s, failedWith(i, tail, detail)).streak;
		return s;
	};
	const TAIL_401 = [
		"Reading additional input from stdin...",
		"2026-09-30T23:02:02.526180Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses",
		"error: Reconnecting... 2/5 (unexpected status 401 Unauthorized)",
		"[error] unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
	];

	it("an engine that died WITH output: the human's detail quotes it verbatim, newest line included", () => {
		const detail = engineFailureDetail(threeOf(TAIL_401, "[error] unexpected status 401 Unauthorized"), "HeartFull-online/platform");
		expect(detail).toContain("The engine's own output on its last turn (4 lines, verbatim):");
		for (const line of TAIL_401) expect(detail).toContain(`  ${line}`);
		// …and the brain's note carries it too, so the Pilot is not left to guess either.
		expect(engineFailureNote(threeOf(TAIL_401))).toContain("ERROR codex_api");
	});

	it("an engine that died with NO output says so in as many words — never a silent blank", () => {
		const detail = engineFailureDetail(threeOf([]));
		expect(detail).toMatch(/printed nothing at all on stdout or stderr/);
		expect(engineFailureNote(threeOf([]))).toMatch(/printed nothing at all/);
	});

	it("a runner that predates the tail is not reported as silent — absence is not a measurement", () => {
		expect(engineFailureDetail(threeOf(undefined))).not.toMatch(/printed nothing/);
	});

	it("fits the stored detail's 2,000 characters, keeping the NEWEST lines", () => {
		const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(300)}`);
		const detail = engineFailureDetail(threeOf(long), "aipa");
		expect(detail.length).toBeLessThanOrEqual(2000);
		expect(detail).toContain("line 59 ");
		expect(detail).not.toContain("line 0 ");
		expect(detail).toMatch(/last \d+ of 60 lines/);
	});

	it("masks a secret the engine printed, and ignores what is not a line of text", () => {
		const s = threeOf(["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", 42 as unknown as string, ""]);
		expect(s.lastTail).toHaveLength(1);
		expect(engineFailureDetail(s)).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
	});

	it("a later SUCCESS clears it — a recovered engine carries no stale output", () => {
		const s = observeTurn(threeOf(TAIL_401), okAt(99)).streak;
		expect(s.lastTail).toBeUndefined();
	});
});

describe("foldTurn — the loop's failed-turn handling as a pure reducer (#1359)", () => {
	const fresh = (): TurnCarry => ({ turns: EMPTY_STREAK, transientStreak: 0 });
	const ctx = (block: ReturnType<typeof Object> | null = null) => ({ repo: "acme/app", signInBlock: () => (block as never) ?? null });

	it("a healthy or unreported turn changes nothing and says nothing", () => {
		expect(foldTurn(fresh(), {}, ctx())).toEqual({ carry: fresh(), effects: [], ending: null });
		const ok = foldTurn(fresh(), { lastTurn: okAt(5) }, ctx());
		expect(ok.effects).toEqual([]);
		expect(ok.ending).toBeNull();
		expect(ok.carry).toMatchObject({ transientStreak: 0, okTurnSeen: true });
	});

	it("does not mutate the carry it is given", () => {
		const before = fresh();
		foldTurn(before, { lastTurn: failedAt(1, "boom") }, ctx());
		expect(before).toEqual(fresh());
	});

	it("reports a NEW failure once, and a re-read of the same turn not at all", () => {
		const first = foldTurn(fresh(), { lastTurn: failedAt(10, "invalid model") }, ctx());
		expect(first.ending).toBeNull();
		expect(legacy(first.effects)).toHaveLength(1);
		expect(legacy(first.effects)[0]).toMatchObject({ event: { name: "engine_failed" } });
		expect(legacy(first.effects)[0].log).toBe(legacy(first.effects)[0].transcript);
		expect(first.carry.turns.consecutive).toBe(1);
		const again = foldTurn(first.carry, { lastTurn: failedAt(10, "invalid model") }, ctx());
		expect(again.effects).toEqual([]);
		expect(again.carry.turns.consecutive).toBe(1);
	});

	it("ends in engine_error on the third consecutive failure, after its note, with the transcript line", () => {
		let carry = fresh();
		let last = foldTurn(carry, { lastTurn: failedAt(1, "exit 1") }, ctx());
		for (let i = 2; i <= MAX_ENGINE_FAILURES; i++) {
			expect(last.ending).toBeNull();
			carry = last.carry;
			last = foldTurn(carry, { lastTurn: failedAt(i, "exit 1") }, ctx());
		}
		expect(last.ending).toMatchObject({ kind: "result", outcome: "engine_error" });
		expect(last.effects.at(-1)?.transcript).toMatch(/^finish: engine_error — /);
		expect(legacy(last.effects)[0]?.event?.name).toBe("engine_failed");
	});

	it("a worked turn resets the streak between failures", () => {
		const a = foldTurn(fresh(), { lastTurn: failedAt(1, "x") }, ctx());
		const b = foldTurn(a.carry, { lastTurn: okAt(2) }, ctx());
		expect(b.carry.turns.consecutive).toBe(0);
		expect(foldTurn(b.carry, { lastTurn: failedAt(3, "x") }, ctx()).carry.turns.consecutive).toBe(1);
	});

	it("a dead login is a reauth ending, not a strike, and says nothing itself", () => {
		const block = { engine: "claude", evidence: "Please run /login" };
		const v = foldTurn(fresh(), { lastTurn: failedAt(1, "not logged in") }, ctx(block));
		expect(v.ending).toEqual({ kind: "reauth", block });
		expect(v.effects).toEqual([]);
	});

	it("the provider's own words: a usage limit parks without spending a strike, a first transient failure retries, a second parks, billing ends", () => {
		const limit = foldTurn(fresh(), { lastTurn: failedAt(1, "You've hit your weekly limit · resets Mon 9am") }, ctx());
		expect(limit.ending).toMatchObject({ kind: "result", outcome: "waiting", waitKind: "limit" });
		expect(legacy(limit.effects)[0]).toMatchObject({ event: { name: "waiting" } });
		expect(limit.carry.turns.consecutive).toBe(0);

		const retry = foldTurn(fresh(), { lastTurn: failedAt(1, "API Error: 529 overloaded_error") }, ctx());
		expect(retry.ending).toBeNull();
		expect(retry.carry.transientStreak).toBe(1);
		expect(retry.carry.turns.consecutive).toBe(0);
		expect(legacy(retry.effects)[0]).toMatchObject({ event: { name: "engine_failed" } });
		const park = foldTurn(retry.carry, { lastTurn: failedAt(2, "API Error: 529 overloaded_error") }, ctx());
		expect(park.ending).toMatchObject({ kind: "result", outcome: "waiting", waitKind: "transient" });

		const billing = foldTurn(fresh(), { lastTurn: failedAt(1, "You're out of usage credits") }, ctx());
		expect(billing.ending).toMatchObject({ kind: "result", outcome: "engine_error" });
		expect(legacy(billing.effects)).toEqual([{ transcript: expect.stringMatching(/^finish: engine_error — /) }]);
	});

	it("a worked turn after a transient failure resets the ladder and marks it", () => {
		const retry = foldTurn(fresh(), { lastTurn: failedAt(1, "API Error: 529 overloaded_error") }, ctx());
		const ok = foldTurn(retry.carry, { lastTurn: okAt(2) }, ctx());
		expect(ok.carry).toMatchObject({ transientStreak: 0, okTurnSeen: true });
	});
});
