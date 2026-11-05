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
import { parseApplicationCard } from "./application-card-payload.js";
import type { LocalApplyExecutionEvidence } from "../local-apply/contract.js";
import { FILL_STAGES, type FillProgressInput, fillProgressOf, hasFilledWork } from "./fill-progress.js";

const checkpointPause = (phase: string, filled: number, uploaded: number) => ({
	reason: "supervisor_checkpoint",
	checkpoint: { checkpointId: `cp-${phase}`, facts: { phase, filled, uploaded } },
});

describe("the stage a fill is actually at (#986)", () => {
	it("does not infer absence of submission from full-access action counts", () => {
		expect(fillProgressOf({ applicationStatus: "submitted", toolAccess: "full", result: { filled: 0, uploaded: [] } }).label).toBe("Submission to the employer was confirmed. Native action counters do not measure all completed fields.");
		for (const runStatus of ["running", "paused", "awaiting_review", "failed", "blocked"]) {
			const progress = fillProgressOf({ applicationStatus: "awaiting_review", runStatus, toolAccess: "full", result: { filled: 0, uploaded: [], submitAttempted: false } });
			expect(progress.label).toContain("Submission status is unverified");
			expect(progress.label).not.toContain("nothing was sent");
		}
	});
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
		expect(p.label).toBe("Paused after 4 fill actions and 1 upload — supervisor decision pending.");
	});

	it("a before_submit checkpoint says the form is complete AND that nothing has been sent", () => {
		const p = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "paused", pause: checkpointPause("before_submit", 9, 2) });
		expect(p.stage).toBe("before_submit_review");
		expect(p.label).toBe("Model reported ready (9 fill actions and 2 uploads) — waiting for the supervisor's decision before anything is sent.");
	});

	it("while the run is live it distinguishes opening the page from filling it", () => {
		expect(fillProgressOf({ applicationStatus: "filling", runStatus: "running" })).toMatchObject({ stage: "navigating", label: "Opening the application in the browser — no field filled yet." });
		expect(fillProgressOf({ applicationStatus: "filling", runStatus: "running", result: { filled: 3 } })).toMatchObject({ stage: "filling", label: "Filling the application in the browser — 3 fill actions so far." });
		expect(fillProgressOf({ applicationStatus: "filling", runStatus: "queued" })).toMatchObject({ stage: "queued", label: "Waiting for the machine to fill it." });
	});

	it("splits the one status word `awaiting_review` by what the runner measured", () => {
		const ready = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "awaiting_review", result: { outcome: "awaiting_review", filled: 11, uploaded: ["resume.pdf"] } });
		expect(ready.stage).toBe("ready_for_review");
		expect(ready.label).toBe("Recorded 11 fill actions and 1 upload — waiting for your review before anything is sent.");
		expect(ready.evidence).toBe("runner_result");

		const stopped = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "awaiting_review", result: { outcome: "awaiting_review", filled: 0, uploaded: [] } });
		expect(stopped.stage).toBe("stopped_before_filling");
		expect(stopped.label).toBe("Stopped before any field was filled — there is nothing to review, and nothing was sent.");
		// Same status, same route, opposite claim — which is the whole point of the module.
		expect(stopped.label).not.toBe(ready.label);
	});

	it("names the blocker, and whether any work preceded it", () => {
		expect(fillProgressOf({ applicationStatus: "blocked", runStatus: "blocked", result: { outcome: "blocked", blockReason: "login_required", filled: 2 } }).label).toBe("Stopped — login required, after 2 fill actions.");
		expect(fillProgressOf({ applicationStatus: "blocked", runStatus: "blocked", blockReason: "captcha" }).label).toBe("Stopped — captcha, before any field was filled.");
		expect(fillProgressOf({ applicationStatus: "filling", runStatus: "paused", pause: { reason: "missing_answer" }, result: { filled: 5 } })).toMatchObject({ stage: "blocked", label: "Paused — missing answer, after 5 fill actions." });
	});

	it("an attempted submit outranks every other reading, including a status that looks earlier", () => {
		const p = fillProgressOf({ applicationStatus: "awaiting_review", runStatus: "paused", pause: checkpointPause("initial", 0, 0), submitAttempted: true });
		expect(p.stage).toBe("submitted");
		expect(p.label).toBe("A final submit was attempted — check the employer's site before anything else is done.");
		expect(fillProgressOf({ applicationStatus: "submitted", result: { filled: 8, uploaded: ["r.pdf", "c.pdf"] } }).label).toBe("Submission confirmed after 8 fill actions and 2 uploads.");
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


const nativeEvidence: LocalApplyExecutionEvidence = {
	schemaVersion: 1, fieldCounts: "unmeasured",
	nativeCalls: { attempted: 19, succeeded: 14, failed: 5, notDispatched: 0, truncated: false, dropped: 3, coverage: "retained" },
	screenshotsDelivered: 2, screenshotRequests: 2, independentScreenshotAvailable: true, blockingQuestions: 1, optionalQuestions: 2,
	browser: { state: "pending", timeouts: 5 },
	causes: ["browser_timeout", "unresolved_answers"],
};

describe("native execution progress (#1526, #1487)", () => {
	it("uses positive document-preflight evidence while preserving submission precedence", () => {
		const input: FillProgressInput = { toolAccess: "full", applicationStatus: "blocked", runStatus: "blocked", documentPreflightFailed: true, result: { filled: 0, uploaded: [], submitAttempted: false } };
		expect(fillProgressOf(input)).toMatchObject({ stage: "stopped_before_filling", filled: 0, uploaded: 0, label: "Stopped during document checks before any browser or model started; nothing was submitted." });
		expect(fillProgressOf({ ...input, documentPreflightFailed: false }).label).toContain("Submission status is unverified");
		expect(fillProgressOf({ ...input, submitAttempted: true }).label).toContain("A final submit was attempted");
		expect(fillProgressOf({ ...input, applicationStatus: "submitted" }).label).toContain("Submission confirmed");
	});
	it("keeps browser failures and answer blockers independent, with unmeasured completion", () => {
		const progress = fillProgressOf({ toolAccess: "full", applicationStatus: "blocked", result: { filled: 0, uploaded: [], outcome: "blocked", executionEvidence: nativeEvidence } });
		expect(progress).toMatchObject({ stage: "blocked", filled: null, uploaded: null, fieldCounts: "unmeasured", executionEvidence: nativeEvidence });
		expect(progress.label).toContain("19 recorded native calls (14 succeeded, 5 failed; 3 older records unavailable)");
		expect(progress.label).toContain("5 browser request timeouts");
		expect(progress.label).toContain("1 unresolved blocking question");
		expect(progress.label).toContain("a native action is still pending; replay is unsafe");
		expect(progress.label).not.toContain("0 fields");
		expect(hasFilledWork(progress)).toBe(false);
	});
	it("keeps full-mode counts unmeasured even for supervised submissions and older results", () => {
		for (const applicationStatus of ["submitted", "blocked", "awaiting_review"]) {
			const progress = fillProgressOf({ toolAccess: "full", applicationStatus, result: { filled: 0, uploaded: [] } });
			expect(progress.filled).toBeNull();
			expect(progress.uploaded).toBeNull();
			expect(progress.executionEvidence).toBeUndefined();
		}
	});
	it("does not label an ended blocked run ready for review when only its result remains", () => {
		const progress = fillProgressOf({ applicationStatus: "awaiting_review", result: { outcome: "blocked", submissionVerification: "unverified" } });
		expect(progress.stage).toBe("blocked");
	});
	it("preserves safe evidence and null counts through board card and execution parsing", () => {
		const progress = fillProgressOf({ toolAccess: "full", applicationStatus: "blocked", result: { executionEvidence: nativeEvidence } });
		const parsed = parseApplicationCard({ applicationId: "application", kind: "fill", progress, execution: {
			schemaVersion: 1, lifecycle: { status: "blocked", stateVersion: 2 }, currentRun: null, checkpoint: null,
			progress: { ...progress, executionEvidence: { ...nativeEvidence, secret: "must not persist", causes: [...nativeEvidence.causes, "arbitrary content"] } },
			permittedActions: [], directiveReconciliation: "terminal",
		} });
		expect(parsed?.progress).toEqual(progress);
		expect(parsed?.execution?.progress).toEqual(progress);
	});
	it("does not turn malformed diagnostics into apparent measured progress", () => {
		const progress = fillProgressOf({ toolAccess: "full", applicationStatus: "blocked", result: { executionEvidence: { ...nativeEvidence, screenshotsDelivered: -1 } } });
		expect(progress.executionEvidence).toBeUndefined();
		expect(progress.filled).toBeNull();
		expect(progress.label).toContain("Native call totals are unavailable");
	});
});
