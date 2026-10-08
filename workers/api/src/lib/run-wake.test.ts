/**
 * What a woken agent is told, and when there is nothing to wake it for (#968).
 *
 * Pure half of the feature: the dispatch is `triggers.ts` (`start_loop`), driven end-to-end in
 * `triggers-start-loop.test.ts` against the real outbox.
 */
import { describe, expect, it } from "vitest";
import { WAKE_CONTEXT_CHARS, isWakeableEvent, wakeFactsOf, wakeObjective } from "./run-wake.js";

const FINISHED = {
	event: "run.finished",
	runId: "run-abc",
	instanceId: "inst-worker",
	status: "completed",
	stopReason: "done",
	detail: "objective completed",
	iterations: 3,
	maxIterations: 12,
	sessionId: null,
	delegatedBy: null,
	startedAt: 1_700_000_000_000,
	finishedAt: 1_700_000_051_000,
	traceId: "run-abc",
};

describe("reading the facts out of a delivered payload", () => {
	it("takes the run's own record", () => {
		expect(wakeFactsOf(FINISHED)).toMatchObject({ event: "run.finished", runId: "run-abc", status: "completed", stopReason: "done", finishedAt: 1_700_000_051_000 });
	});

	it("takes only what it recognises — an unknown event type is not adopted", () => {
		expect(wakeFactsOf({ ...FINISHED, event: "lead.created" }).event).toBeUndefined();
		// …and the rest still reads, so a foreign payload degrades rather than throwing.
		expect(wakeFactsOf({ ...FINISHED, event: "lead.created" }).runId).toBe("run-abc");
	});

	it.each([[null], [undefined], ["a string"], [[1, 2]], [42]])("survives a payload that is not an object: %s", (payload) => {
		expect(wakeFactsOf(payload)).toEqual({});
	});

	it("ignores a non-finite timestamp rather than rendering Invalid Date", () => {
		expect(wakeFactsOf({ ...FINISHED, finishedAt: Number.NaN }).finishedAt).toBeUndefined();
		expect(wakeFactsOf({ ...FINISHED, finishedAt: "soon" }).finishedAt).toBeUndefined();
	});
});

describe("only a terminal outcome is worth a turn", () => {
	it.each([["run.finished"], ["run.stalled"]])("%s wakes it", (event) => {
		expect(isWakeableEvent(wakeFactsOf({ ...FINISHED, event }))).toBe(true);
	});

	it.each([["lead.created"], ["site.live"], ["job.application.materials_ready"], [""]])("%s does not", (event) => {
		expect(isWakeableEvent(wakeFactsOf({ ...FINISHED, event }))).toBe(false);
	});
});

describe("the objective a woken agent receives", () => {
	const STANDING = "Review what finished and decide the next step.";

	it("leads with the owner's standing instruction, then the run's facts", () => {
		const o = wakeObjective(STANDING, wakeFactsOf(FINISHED));
		expect(o.startsWith(STANDING)).toBe(true);
		expect(o).toContain("run run-abc");
		expect(o).toContain("status completed");
		expect(o).toContain("agent inst-worker");
		expect(o).toContain("2023-11-14T22:14:11.000Z");
	});

	it("says a STALL is a stall — the case a polling loop never learns, because the row says running for ever", () => {
		const o = wakeObjective(STANDING, wakeFactsOf({ ...FINISHED, event: "run.stalled", status: "running" }));
		expect(o).toMatch(/STALLED/);
		expect(o).toMatch(/went quiet/);
	});

	it("a failed run reads as failed, with the reason it stopped on", () => {
		const o = wakeObjective(STANDING, wakeFactsOf({ ...FINISHED, status: "failed", stopReason: "max_iterations" }));
		expect(o).toContain("status failed");
		expect(o).toContain("stopped on max_iterations");
	});

	it("bounds the run's own `detail` and MARKS the cut — the one field a foreign producer controls", () => {
		const o = wakeObjective(STANDING, wakeFactsOf({ ...FINISHED, detail: "x".repeat(WAKE_CONTEXT_CHARS + 500) }));
		expect(o.length).toBeLessThan(STANDING.length + WAKE_CONTEXT_CHARS + 400);
		// `clipMarked`, not slice: a cut that does not say so reads as the whole instruction.
		expect(o).toMatch(/…|\[cut|truncated/i);
		// The ids survive the cut, because the detail is bounded on its own.
		expect(o).toContain("run run-abc");
	});

	it("is just the instruction when there are no facts — a cron wake-up carries no event", () => {
		expect(wakeObjective(STANDING, {})).toBe(STANDING);
	});

	it("carries no payload field it was not asked for", () => {
		const o = wakeObjective(STANDING, wakeFactsOf({ ...FINISHED, secret: "sk-ant-0000000000000000", cookie: "session=abc" } as never));
		expect(o).not.toContain("sk-ant");
		expect(o).not.toContain("session=abc");
	});
});
