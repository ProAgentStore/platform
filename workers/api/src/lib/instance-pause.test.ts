/**
 * The pause/resume transitions and the run-admission gate (#825).
 *
 * The decisions worth pinning are the ones a proxy over a status column gets wrong:
 *
 *   · an idempotent call is a SUCCESS that wrote nothing, not a conflict. The caller most likely
 *     to make it is a model retrying after a dropped response, and telling it "no" makes it
 *     re-ask a question that has already been answered.
 *   · a CANCELLED instance is neither pausable nor resumable, and 409 is the status that says so
 *     — the row exists and the request is well-formed, which is exactly what 404 would deny.
 *   · the two gates fail in OPPOSITE directions, deliberately. Background dispatch
 *     (`trigger-eligibility`) fails closed on any status it has not been taught, because it spends
 *     with nobody watching. This one fails open, because it sits in front of an owner pressing a
 *     button and a future status nobody has thought about yet must not silently make an agent
 *     unusable.
 */
import { describe, expect, it } from "vitest";
import {
	PAUSED_INSTANCE_STATUS,
	PAUSED_RUN_REFUSAL,
	isPausedInstanceStatus,
	pauseVerdict,
	pausedStartRefusal,
	resumeVerdict,
} from "./instance-pause.js";
import { ACTIVE_INSTANCE_STATUS } from "./trigger-eligibility.js";

describe("pauseVerdict", () => {
	it("pauses an active instance, and says it changed something", () => {
		expect(pauseVerdict(ACTIVE_INSTANCE_STATUS)).toEqual({ ok: true, changed: true, status: PAUSED_INSTANCE_STATUS });
	});

	it("succeeds with changed:false when it is already paused", () => {
		// A double-click, or a retry after a dropped response. The state asked for is the state
		// that holds, so it succeeded — a 409 here punishes the caller for the network.
		expect(pauseVerdict(PAUSED_INSTANCE_STATUS)).toEqual({ ok: true, changed: false, status: PAUSED_INSTANCE_STATUS });
	});

	it("refuses a cancelled instance with 409 and names the remedy", () => {
		const v = pauseVerdict("canceled");
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.httpStatus).toBe(409);
		// Says what re-subscribing actually does, because "just subscribe again" quietly implies
		// this instance comes back, and it does not.
		expect(v.error).toMatch(/new instance/);
	});

	it("refuses an unknown status rather than writing over it", () => {
		// The WRITE side fails closed: a status this build has not been taught may mean something
		// that pause would trample, and there is no rush to find out.
		for (const status of ["suspended", "", null, undefined]) {
			expect(pauseVerdict(status).ok, String(status)).toBe(false);
		}
	});
});

describe("resumeVerdict", () => {
	it("resumes a paused instance", () => {
		expect(resumeVerdict(PAUSED_INSTANCE_STATUS)).toEqual({ ok: true, changed: true, status: ACTIVE_INSTANCE_STATUS });
	});

	it("succeeds with changed:false when it is already active", () => {
		expect(resumeVerdict(ACTIVE_INSTANCE_STATUS)).toEqual({ ok: true, changed: false, status: ACTIVE_INSTANCE_STATUS });
	});

	it("will not un-cancel a cancelled instance", () => {
		// The one transition that must never exist: resume is the inverse of pause, not of cancel.
		// Cancel retires a shared subscription row; reversing it from here would restore an
		// instance while leaving that decision unmade.
		const v = resumeVerdict("canceled");
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.httpStatus).toBe(409);
	});
});

describe("pausedStartRefusal — the run-admission gate", () => {
	it("refuses a run on a paused instance, naming the way back", () => {
		const refusal = pausedStartRefusal(PAUSED_INSTANCE_STATUS);
		expect(refusal).toBe(PAUSED_RUN_REFUSAL);
		// Both remedies by their real names, so the sentence is actionable from the console or
		// from MCP without the reader having to find out which surface they are on.
		expect(refusal).toMatch(/resume_instance/);
		expect(refusal).toMatch(/Settings/);
		// And says what pause did NOT do, because "paused" reads like "broken" to someone who
		// arrived at it from a failed run.
		expect(refusal).toMatch(/does not touch its subscription/);
	});

	it("admits an active instance", () => {
		expect(pausedStartRefusal(ACTIVE_INSTANCE_STATUS)).toBeNull();
	});

	it("fails OPEN on a status it has not been taught — the opposite of the background gate", () => {
		// Deliberate asymmetry, and the reason it is worth a test: copying
		// `isActiveInstanceStatus` here would turn any future status into an agent that silently
		// cannot run, in front of an owner pressing a button. Cancelled instances are refused
		// upstream by the ownership load, so `paused` is the only state this must answer for.
		for (const status of ["suspended", "", null, undefined]) {
			expect(pausedStartRefusal(status), String(status)).toBeNull();
		}
	});
});

describe("the two statuses are one spelling", () => {
	it("isPausedInstanceStatus matches the constant and nothing near it", () => {
		expect(isPausedInstanceStatus(PAUSED_INSTANCE_STATUS)).toBe(true);
		for (const near of ["Paused", "PAUSED", "pause", "paused ", ACTIVE_INSTANCE_STATUS]) {
			expect(isPausedInstanceStatus(near), near).toBe(false);
		}
	});

	it("pause and active are different words — a transition that no-ops both ways would be silent", () => {
		expect(PAUSED_INSTANCE_STATUS).not.toBe(ACTIVE_INSTANCE_STATUS);
	});
});
