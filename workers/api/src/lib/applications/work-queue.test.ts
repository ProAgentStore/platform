/**
 * Which refusals are worth waiting for (#974), and what the owner is told while they wait.
 *
 * The distinction this file protects: these endpoints answer 409 for a BUSY machine and for a
 * genuine conflict, and only the first may be retried. Deferring the second would mean asking a
 * machine forever for a run it has already bound to another request.
 */
import { describe, expect, it } from "vitest";
import { QUEUE_MAX_ATTEMPTS, backoffDelayMs, queueView, queuedLabel, refusalVerdict } from "./work-queue.js";

describe("a busy machine is a wait; everything else is a failure (#974)", () => {
	it.each([
		["the Tailor's own words", "This machine is already tailoring 2 application(s) for this agent (limit 1)."],
		["the Runner's own words", "This machine is already filling an application for this agent; one at a time."],
		["a runner still coming up", "The runner is still starting; try again in a moment."],
	])("defers on %s", (_why, error) => {
		expect(refusalVerdict({ status: 409, error })).toMatchObject({ defer: true });
	});

	it("does NOT defer a genuine conflict — the run is bound to another request", () => {
		// The trap: same endpoint, same 409. Retrying this forever is what status-only matching does.
		expect(refusalVerdict({ status: 409, error: "Run abc already exists with another requestId" })).toEqual({ defer: false });
	});

	it.each([400, 404, 422, 500, 503])("does not defer HTTP %i, whatever it says", (status) => {
		expect(refusalVerdict({ status, error: "This machine is already filling an application" })).toEqual({ defer: false });
	});

	it("honours a machine-readable code from a newer runner, without needing its prose", () => {
		expect(refusalVerdict({ status: 409, code: "busy" })).toMatchObject({ defer: true, reason: "busy" });
		expect(refusalVerdict({ status: 500, code: "starting" })).toMatchObject({ defer: true, reason: "starting" });
		expect(refusalVerdict({ status: 409, code: "something_else", error: "nope" })).toEqual({ defer: false });
	});

	it("carries a reason even when the runner sent no message at all", () => {
		expect(refusalVerdict({ status: 409, code: "busy" })).toMatchObject({ message: expect.stringMatching(/busy/) });
	});
});

describe("the wait is bounded and does not hammer the machine", () => {
	it("climbs then flattens, so a queue of five does not re-ask every minute", () => {
		expect([0, 1, 2, 3, 4, 5].map(backoffDelayMs)).toEqual([60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000]);
	});

	it("never grows without bound — past the ladder it repeats", () => {
		expect(backoffDelayMs(99)).toBe(backoffDelayMs(5));
	});

	it("the whole wait is finite", () => {
		const total = Array.from({ length: QUEUE_MAX_ATTEMPTS }, (_, i) => backoffDelayMs(i)).reduce((a, b) => a + b, 0);
		expect(total).toBeLessThan(3 * 60 * 60_000);
	});
});

describe("what the owner reads while it waits", () => {
	const view = (over: Partial<Parameters<typeof queueView>[0]> = {}, now = 1_000) =>
		queueView({ position: 1, attempts: 0, nextAttemptAt: null, reason: null, ...over }, now);

	it("next in line, due now", () => {
		expect(queuedLabel(view())).toMatch(/Next in line, due now/);
	});

	it("counts the ones ahead of it, which is the question actually being asked", () => {
		expect(queuedLabel(view({ position: 3 }))).toMatch(/2 ahead of it in line/);
	});

	it("a past due time reads as due now rather than as a stale timestamp", () => {
		expect(view({ nextAttemptAt: 500 }, 1_000).nextAttemptAt).toBeNull();
		expect(view({ nextAttemptAt: 60_000 }, 1_000).nextAttemptAt).not.toBeNull();
	});

	it("says when the machine is simply absent, which is a different problem from a moving queue", () => {
		expect(queuedLabel(view({ reason: "No runner is connected — run `pags up` on the machine that holds your job materials." }))).toMatch(/pags up/);
	});

	it("stops promising a retry once the attempts are spent", () => {
		const v = view({ attempts: QUEUE_MAX_ATTEMPTS });
		expect(v.exhausted).toBe(true);
		expect(queuedLabel(v)).toMatch(/Gave up waiting/);
	});
});
