/**
 * #986 — the Board said "Filled — waiting for your review before anything is sent" about an
 * application whose runner had reported `phase: initial, filled: 0, uploaded: 0`.
 *
 * These cases are the five shapes the issue names (zero-field, partial, ready-to-review, blocker,
 * before-submit) plus the two that outrank them all, asserted on the PURE function every surface
 * reads. The invariant at the end is the one that was violated: no sentence may describe filled
 * work unless the runner's own facts show some.
 */
import { describe, expect, it } from "vitest";
import { FILL_STAGES, type FillProgressInput, fillProgressOf, hasFilledWork } from "./fill-progress.js";

const checkpointPause = (phase: string, filled: number, uploaded: number) => ({
	reason: "supervisor_checkpoint",
	checkpoint: { checkpointId: `cp-${phase}`, facts: { phase, filled, uploaded } },
});

describe("the stage a fill is actually at (#986)", () => {
	it("THE LIVE CASE: an initial checkpoint with nothing entered is not a filled form", () => {
		const p = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "paused", pause: checkpointPause("initial", 0, 0) });
		expect(p.stage).toBe("supervisor_pending");
		expect(p.label).toBe("Paused before form filling — supervisor decision pending. Nothing has been entered yet.");
		expect(p.filled).toBe(0);
		expect(p.uploaded).toBe(0);
		expect(p.checkpointPhase).toBe("initial");
		expect(p.checkpointId).toBe("cp-initial");
		expect(p.evidence).toBe("runner_checkpoint");
		expect(hasFilledWork(p)).toBe(false);
	});

	it("reads the counts off a checkpoint the caller holds from the supervisor store, not only off the pause", () => {
		const p = fillProgressOf({ applicationStatus: "filling", runStatus: "paused", pause: { reason: "supervisor_checkpoint" }, checkpoint: { checkpointId: "cp-7", phase: "post_navigation", filled: 4, uploaded: 1 } });
		expect(p).toMatchObject({ stage: "partially_filled", filled: 4, uploaded: 1, checkpointPhase: "post_navigation", checkpointId: "cp-7" });
		expect(p.label).toBe("Paused after 4 fields and 1 attachment — supervisor decision pending.");
	});

	it("a before_submit checkpoint says the form is complete AND that nothing has been sent", () => {
		const p = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "paused", pause: checkpointPause("before_submit", 9, 2) });
		expect(p.stage).toBe("before_submit_review");
		expect(p.label).toBe("Form complete (9 fields and 2 attachments) — waiting for the supervisor's decision before anything is sent.");
	});

	it("while the run is live it distinguishes opening the page from filling it", () => {
		expect(fillProgressOf({ applicationStatus: "filling", runStatus: "running" })).toMatchObject({ stage: "navigating", label: "Opening the application in the browser — no field filled yet." });
		expect(fillProgressOf({ applicationStatus: "filling", runStatus: "running", result: { filled: 3 } })).toMatchObject({ stage: "filling", label: "Filling the application in the browser — 3 fields so far." });
		expect(fillProgressOf({ applicationStatus: "filling", runStatus: "queued" })).toMatchObject({ stage: "queued", label: "Waiting for the machine to fill it." });
	});

	it("splits the one status word `awaiting_review` by what the runner measured", () => {
		const ready = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "awaiting_review", result: { outcome: "awaiting_review", filled: 11, uploaded: ["resume.pdf"] } });
		expect(ready.stage).toBe("ready_for_review");
		expect(ready.label).toBe("Filled 11 fields and 1 attachment — waiting for your review before anything is sent.");
		expect(ready.evidence).toBe("runner_result");

		const stopped = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "awaiting_review", result: { outcome: "awaiting_review", filled: 0, uploaded: [] } });
		expect(stopped.stage).toBe("stopped_before_filling");
		expect(stopped.label).toBe("Stopped before any field was filled — there is nothing to review, and nothing was sent.");
		// Same status, same route, opposite claim — which is the whole point of the module.
		expect(stopped.label).not.toBe(ready.label);
	});

	it("names the blocker, and whether any work preceded it", () => {
		expect(fillProgressOf({ applicationStatus: "blocked", runStatus: "blocked", result: { outcome: "blocked", blockReason: "login_required", filled: 2 } }).label).toBe("Stopped — login required, after 2 fields.");
		expect(fillProgressOf({ applicationStatus: "blocked", runStatus: "blocked", blockReason: "captcha" }).label).toBe("Stopped — captcha, before any field was filled.");
		expect(fillProgressOf({ applicationStatus: "filling", runStatus: "paused", pause: { reason: "missing_answer" }, result: { filled: 5 } })).toMatchObject({ stage: "blocked", label: "Paused — missing answer, after 5 fields." });
	});

	it("an attempted submit outranks every other reading, including a status that looks earlier", () => {
		const p = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "paused", pause: checkpointPause("initial", 0, 0), submitAttempted: true });
		expect(p.stage).toBe("submitted");
		expect(p.label).toBe("A final submit was attempted — check the employer's site before anything else is done.");
		expect(fillProgressOf({ applicationStatus: "submitted", result: { filled: 8, uploaded: ["r.pdf", "c.pdf"] } }).label).toBe("Submitted to the employer after filling 8 fields and 2 attachments.");
	});

	it("an archived application says nothing was sent, and why it is unavailable when it is", () => {
		expect(fillProgressOf({ applicationStatus: "archived", blockReason: "job_unavailable" })).toMatchObject({ stage: "unavailable", label: "The listing is no longer available; nothing was sent." });
		expect(fillProgressOf({ applicationStatus: "archived" }).label).toBe("Archived; nothing was sent.");
	});

	it("labels a bare status word AS a status word rather than as progress", () => {
		const p = fillProgressOf({ applicationStatus: "materials_ready" });
		expect(p.evidence).toBe("run_status");
		expect(p.label).toBe("Fill materials_ready.");
		expect(p.label).not.toMatch(/[Ff]illed/);
	});

	it("takes the larger of the checkpoint's and the result's counts — a later fact cannot un-fill a field", () => {
		const p = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "awaiting_review", pause: checkpointPause("before_submit", 6, 1), result: { outcome: "awaiting_review", filled: 2, uploaded: [] } });
		expect(p).toMatchObject({ filled: 6, uploaded: 1 });
	});

	it("ignores junk counts instead of rendering them", () => {
		const p = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "awaiting_review", result: { outcome: "awaiting_review", filled: Number.NaN, uploaded: "three" } });
		expect(p).toMatchObject({ stage: "stopped_before_filling", filled: 0, uploaded: 0 });
	});

	// Every declared stage must be REACHABLE. A vocabulary with a word nothing produces reads as
	// coverage the surfaces do not have — and the states the issue enumerates are exactly the ones a
	// reader has to be able to tell apart.
	it("every stage in the vocabulary is produced by some shape of facts", () => {
		const produced = new Set(
			[
				{ applicationStatus: "filling", runStatus: "queued" },
				{ applicationStatus: "filling", runStatus: "running" },
				{ applicationStatus: "filling", runStatus: "paused", pause: checkpointPause("initial", 0, 0) },
				{ applicationStatus: "filling", runStatus: "running", result: { filled: 2 } },
				{ applicationStatus: "filling", runStatus: "paused", pause: checkpointPause("post_navigation", 2, 0) },
				{ applicationStatus: "awaiting_review", runStatus: "awaiting_review", result: { outcome: "awaiting_review", filled: 5 } },
				{ applicationStatus: "filling", runStatus: "paused", pause: checkpointPause("before_submit", 5, 1) },
				{ applicationStatus: "awaiting_review", runStatus: "awaiting_review", result: { outcome: "awaiting_review", filled: 0 } },
				{ applicationStatus: "blocked", runStatus: "blocked", blockReason: "captcha" },
				{ applicationStatus: "submitted" },
				{ applicationStatus: "archived" },
				{ applicationStatus: "failed", runStatus: "failed" },
				{ applicationStatus: "cancelled", runStatus: "cancelled" },
			].map((i) => fillProgressOf(i as FillProgressInput).stage),
		);
		expect([...produced].sort()).toEqual([...FILL_STAGES].sort());
	});

	// THE INVARIANT. Swept over every shape that reaches this function, because the defect was not
	// one wrong branch — it was a sentence written from a fact nobody had.
	it("never claims filled work without counts to show for it, in any state", () => {
		const shapes: FillProgressInput[] = [];
		for (const applicationStatus of ["tailoring", "materials_ready", "filling", "awaiting_review", "submitted", "blocked", "failed", "cancelled", "archived", "deferred"]) {
			for (const runStatus of [null, "queued", "running", "paused", "awaiting_review", "blocked", "failed", "cancelled", "submitted"]) {
				for (const pause of [null, { reason: "missing_answer" }, checkpointPause("initial", 0, 0), checkpointPause("before_submit", 0, 0)]) {
					for (const result of [null, {}, { outcome: "awaiting_review", filled: 0, uploaded: [] }, { outcome: "blocked", filled: 0 }]) {
						shapes.push({ applicationStatus, runStatus, pause, result });
					}
				}
			}
		}
		expect(shapes.length).toBeGreaterThan(1000);
		for (const s of shapes) {
			const p = fillProgressOf(s);
			expect(FILL_STAGES).toContain(p.stage);
			expect(hasFilledWork(p)).toBe(false);
			// "nothing", "no field filled", "before any field was filled" are all fine; a claim of
			// filled FIELDS is not, and neither is the sentence the Board actually showed.
			expect(p.label, JSON.stringify(s)).not.toMatch(/\bFilled \d|filling \d|Form complete \(\d+ field/);
			expect(p.label, JSON.stringify(s)).not.toMatch(/^Filled —/);
		}
	});
});
