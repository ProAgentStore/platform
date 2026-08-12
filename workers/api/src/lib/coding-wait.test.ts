import { describe, expect, it } from "vitest";
import {
	clockLine,
	ENGINE_WAIT_BACKOFF_MS,
	ENGINE_WAIT_TOTAL_MS,
	engineResumeNote,
	engineWaitExhausted,
	enginePauseMessage,
	formatLocal,
	MAX_ENGINE_WAIT_MS,
	MAX_ENGINE_WAITS,
	MIN_ENGINE_WAIT_MS,
	parseResetInstant,
	planEngineWait,
	type EngineWaitPlan,
} from "./coding-wait.js";

/** The moment run 6550f673 started, to the second: 2026-08-12T11:34:00Z = 21:34 in Sydney. */
const RUN_START = Date.parse("2026-08-12T11:34:00Z");
/** What the CLI told it: "resets at 10:30pm Australia/Sydney time" — 56 minutes later. */
const RESET_SYDNEY = "2026-08-12T22:30:00+10:00";

const fresh = () => ({ waits: 0, spentMs: 0 });

describe("parseResetInstant — a local time with no zone is REFUSED, not guessed (#541)", () => {
	it("accepts an offset and resolves it to the right instant", () => {
		expect(parseResetInstant(RESET_SYDNEY)).toBe(Date.parse("2026-08-12T12:30:00Z"));
	});

	it("accepts Z and the compact ±HHMM form", () => {
		expect(parseResetInstant("2026-08-12T12:30:00Z")).toBe(Date.parse("2026-08-12T12:30:00Z"));
		expect(parseResetInstant("2026-08-12T22:30:00+1000")).toBe(Date.parse("2026-08-12T12:30:00Z"));
	});

	it("REFUSES a naked local timestamp", () => {
		// This is the whole point. `Date.parse("2026-08-12T22:30:00")` resolves against the runtime
		// zone — UTC in a Worker — so accepting it turns "10:30pm Sydney" into a ten-hour error that
		// looks exactly like a working parse.
		expect(parseResetInstant("2026-08-12T22:30:00")).toBeNull();
		expect(parseResetInstant("2026-08-12 22:30")).toBeNull();
		expect(parseResetInstant("10:30pm")).toBeNull();
	});

	it("refuses prose, junk and non-strings", () => {
		expect(parseResetInstant("resets at 10:30pm Australia/Sydney time")).toBeNull();
		expect(parseResetInstant("not-a-date+10:00")).toBeNull();
		expect(parseResetInstant(undefined)).toBeNull();
		expect(parseResetInstant(1_760_000_000_000)).toBeNull();
		expect(parseResetInstant("")).toBeNull();
	});
});

describe("planEngineWait — the deadline is a bound, never an authority", () => {
	it("sleeps to the reset the CLI named — the 56 minutes run 6550f673 did not wait", () => {
		const plan = planEngineWait({ resetsAt: RESET_SYDNEY, now: RUN_START, state: fresh() });
		expect(plan.wait).toBe(true);
		const p = plan as EngineWaitPlan;
		expect(p.source).toBe("deadline");
		expect(p.ms).toBe(56 * 60_000);
		expect(p.until).toBe(Date.parse("2026-08-12T12:30:00Z"));
		expect(p.capped).toBe(false);
		// The run it replaces died at +15m15s, 41 minutes before this instant.
		expect(p.ms).toBeGreaterThan(15 * 60_000 + 15_000);
	});

	it("falls back to a bounded backoff when no reset time was reported", () => {
		const p = planEngineWait({ resetsAt: undefined, now: RUN_START, state: fresh() }) as EngineWaitPlan;
		expect(p.source).toBe("backoff");
		expect(p.ms).toBe(ENGINE_WAIT_BACKOFF_MS[0]);
	});

	it("uses the SAME backoff for an unparseable reset time — a bad parse is not a deadline", () => {
		const p = planEngineWait({ resetsAt: "2026-08-12T22:30:00", now: RUN_START, state: fresh() }) as EngineWaitPlan;
		expect(p.source).toBe("backoff");
	});

	it("climbs the backoff with each park", () => {
		const at = (waits: number) => (planEngineWait({ now: RUN_START, state: { waits, spentMs: 0 } }) as EngineWaitPlan).ms;
		expect(at(0)).toBe(ENGINE_WAIT_BACKOFF_MS[0]);
		expect(at(1)).toBe(ENGINE_WAIT_BACKOFF_MS[1]);
		expect(at(2)).toBe(ENGINE_WAIT_BACKOFF_MS[2]);
	});

	it("takes only a short beat when the reported reset has already passed", () => {
		// The model's own reading says the window reopened. A full backoff would punish a conversion
		// that is probably nearly right; a minute settles it.
		const p = planEngineWait({ resetsAt: "2026-08-12T21:30:00+10:00", now: RUN_START, state: fresh() }) as EngineWaitPlan;
		expect(p.source).toBe("stale-deadline");
		expect(p.ms).toBe(MIN_ENGINE_WAIT_MS);
	});

	it("caps a deadline further out than one park may last, and SAYS it capped", () => {
		const p = planEngineWait({ resetsAt: "2026-08-20T00:00:00Z", now: RUN_START, state: fresh() }) as EngineWaitPlan;
		expect(p.ms).toBe(MAX_ENGINE_WAIT_MS);
		expect(p.capped).toBe(true);
	});

	it("clamps to what the run has left of its total budget", () => {
		const spentMs = ENGINE_WAIT_TOTAL_MS - 10 * 60_000;
		const p = planEngineWait({ resetsAt: RESET_SYDNEY, now: RUN_START, state: { waits: 1, spentMs } }) as EngineWaitPlan;
		expect(p.ms).toBe(10 * 60_000);
		expect(p.capped).toBe(true);
	});

	it("refuses once the run has parked MAX_ENGINE_WAITS times", () => {
		const plan = planEngineWait({ resetsAt: RESET_SYDNEY, now: RUN_START, state: { waits: MAX_ENGINE_WAITS, spentMs: 0 } });
		expect(plan.wait).toBe(false);
		expect(plan.wait === false && plan.why).toMatch(/already waited/);
	});

	it("refuses once the total budget is spent, even on the first park", () => {
		const plan = planEngineWait({ resetsAt: RESET_SYDNEY, now: RUN_START, state: { waits: 0, spentMs: ENGINE_WAIT_TOTAL_MS } });
		expect(plan.wait).toBe(false);
		expect(plan.wait === false && plan.why).toMatch(/of waiting/);
	});

	it("never parks for less than the minimum, however close the deadline", () => {
		const p = planEngineWait({ resetsAt: new Date(RUN_START + 1_000).toISOString(), now: RUN_START, state: fresh() }) as EngineWaitPlan;
		expect(p.ms).toBe(MIN_ENGINE_WAIT_MS);
	});
});

describe("the clock the Pilot converts against", () => {
	it("renders the owner's zone with its offset, so 10:30pm is unambiguous", () => {
		expect(formatLocal(RUN_START, "Australia/Sydney")).toBe("2026-08-12 21:34 +10:00 (Australia/Sydney)");
	});

	it("renders a half-hour zone correctly", () => {
		expect(formatLocal(RUN_START, "Australia/Adelaide")).toBe("2026-08-12 21:04 +09:30 (Australia/Adelaide)");
	});

	it("says UTC OUT LOUD when the owner set no zone, rather than assuming one", () => {
		expect(formatLocal(RUN_START)).toBe("2026-08-12 11:34 +00:00 (UTC)");
		expect(clockLine(RUN_START)).toContain("+00:00 (UTC)");
	});

	it("falls back to UTC on an invalid zone instead of throwing mid-decision", () => {
		expect(formatLocal(RUN_START, "Not/AZone")).toBe("2026-08-12 11:34 +00:00 (UTC)");
	});

	it("states the absolute instant too, so the model has both forms", () => {
		const line = clockLine(RUN_START, "Australia/Sydney");
		expect(line).toContain("2026-08-12T11:34:00.000Z");
		expect(line).toContain("2026-08-12 21:34 +10:00");
	});
});

describe("what the owner and the resumed Pilot are told", () => {
	const plan = planEngineWait({ resetsAt: RESET_SYDNEY, now: RUN_START, state: fresh() }) as EngineWaitPlan;

	it("says it is pausing, not stopping, and that nothing is needed", () => {
		const m = enginePauseMessage(plan, "The Claude CLI session has hit its usage limit.", "Australia/Sydney");
		expect(m).toContain("pausing, not stopping");
		expect(m).toContain("56 minutes");
		expect(m).toContain("2026-08-12 22:30 +10:00");
		expect(m).toMatch(/Nothing is needed from you/);
	});

	it("tells the resumed Pilot the visible limit message is HISTORY", () => {
		// Without this the resumed brain reads the pane the CLI printed once, believes it is the
		// current state, and parks again — park, wake, park, until the budget is gone.
		const note = engineResumeNote(plan, "Australia/Sydney");
		expect(note).toContain("HISTORY");
		expect(note).toContain("2026-08-12 22:30 +10:00");
		expect(note).toMatch(/Send your next instruction/);
		// Attributed to the platform, never to the human (#505).
		expect(note).toMatch(/not from the human/);
	});

	it("names the refusal when the run may not park again", () => {
		expect(engineWaitExhausted("hit its usage limit", "the run has already waited 3 times")).toContain("already waited 3 times");
	});
});
