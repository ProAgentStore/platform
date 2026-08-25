import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { needsHuman, statusFor, type LoopStopReason } from "./agent-loop.js";
import { codingCrashReport, INTERRUPTED_CLASSES, interruptedBy, outcomeWord, resumeNotice, runOutcomeNote, withoutVendorAdvice } from "./coding-run-report.js";
import { AI_STALL_TIMEOUT_MS, deadlineMessage } from "./ai-deadlines.js";
import { CARD_DETAIL_MAX, cardDetail } from "./card-detail.js";
import { classifyCodingFailure } from "./coding-failure.js";
import { stopReasonFor } from "./coding-pause.js";
import { RunnerGoneError } from "./runner-unreachable.js";

describe("an interruption is not the objective failing (#546, #758)", () => {
	// Verbatim from the eight production occurrences the ticket was measured on.
	const INTERNAL = "WorkflowInternalError: Attempt failed due to internal workflows error";
	const CEILING =
		"Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";
	const RESET = "Durable Object reset because its code was updated";
	/** The stall, composed by the function that raises it — a reword fails here rather than degrading. */
	const STALL = deadlineMessage("stall", AI_STALL_TIMEOUT_MS);

	it("covers exactly the four classes where something other than the work cut the run off", () => {
		// G1: the set is asserted, not assumed. Adding a class here without a reason — or losing
		// one — changes what the owner is told about a whole population of dead runs. `provider_stall`
		// joined in #758, once the resumes are spent: a dropped socket is not the objective failing.
		expect([...INTERRUPTED_CLASSES].sort()).toEqual(["infra_transient", "platform_ceiling", "provider_stall", "workflow_internal"]);
		for (const message of [INTERNAL, CEILING, RESET, STALL]) {
			expect(INTERRUPTED_CLASSES.has(classifyCodingFailure(new Error(message)).class), message).toBe(true);
		}
	});

	it("names the RIGHT culprit — our platform, or the owner's own AI provider (#758)", () => {
		// The half a shared sentence gets wrong. "Interrupted by the platform" pointed an owner at us
		// for a failure in their own BYOK provider's transport; #546 and #523 are both tickets about a
		// death reported as something it was not, and reusing their sentence here would repeat that.
		expect(interruptedBy(classifyCodingFailure(new Error(STALL)).class)).toBe("cut off by the AI provider");
		expect(interruptedBy(classifyCodingFailure(new Error(RESET)).class)).toBe("interrupted by the platform");
		// A death that IS the objective failing has no subject at all — that is what `null` means, and
		// it is what keeps `codingCrashReport` from rewording an ordinary crash.
		expect(interruptedBy(classifyCodingFailure(new Error("Cannot read properties of undefined")).class)).toBeNull();
		const stall = codingCrashReport(new Error(STALL));
		expect(stall.detail.startsWith("Cut off by the AI provider, not by the objective")).toBe(true);
		expect(stall.detail, "our own deploys must not be blamed for the provider's socket").not.toContain("platform");
		expect(stall.stopReason, "the objective never reported either way — it is not `failed`").toBe("interrupted");
	});

	it("says the same thing on the chat bubble the driver posts while it replays (#758)", () => {
		// One table, three surfaces. The bubble used to be a template literal inside the workflow that
		// hardcoded "Interrupted by a platform update", which the resume policy made false the moment
		// it widened — the exact shape of #546's "two durable accounts of one event, disagreeing".
		const notice = resumeNotice(classifyCodingFailure(new Error(STALL)).class, "the journal replays every completed step", 2, 3);
		expect(notice).toContain("**Cut off by the AI provider**");
		expect(notice).toContain("interruption 2 of 3");
		expect(notice).toContain("nothing is needed from you");
		expect(resumeNotice(classifyCodingFailure(new Error(RESET)).class, "why", 1, 3)).toContain("**Interrupted by the platform**");
	});

	it("drops the `run error:` prefix, which reads as a crash, and says the work is intact", () => {
		for (const message of [INTERNAL, CEILING, RESET, STALL]) {
			const r = codingCrashReport(new Error(message));
			expect(r.detail, message).not.toContain("run error:");
			// What the platform said still reaches the owner — minus only the advice addressed to
			// whoever operates the Worker, which #523 measured at 81 of the card's 300 characters.
			// `withoutVendorAdvice` is the identity on the other two messages, so this is the same
			// assertion #546 shipped for them.
			expect(r.detail, message).toContain(withoutVendorAdvice(message));
			// The half that changes what the owner DOES. Two of the five occurrences carried
			// `Acts: pushed directly to the trunk origin main` and were reported as failures, so he
			// re-ran work that was already on the trunk.
			expect(r.detail, message).toContain("already committed or pushed is unaffected");
			expect(r.stopReason, message).toBe("interrupted");
		}
	});

	it("leaves the two endings that already had a sentence exactly as they were", () => {
		// #341 wrote the runner sentence deliberately: "the runner did not come back" is a finding,
		// not a crash, and it must not be replaced by the generic interruption wording.
		const gone = codingCrashReport(new RunnerGoneError("waited 10 minutes; the machine did not come back"));
		expect(gone.detail).toBe("waited 10 minutes; the machine did not come back");
		expect(gone.stopReason).toBeNull();
		// A genuine crash keeps the prefix, because for it the prefix is true.
		const crash = codingCrashReport(new Error("Cannot read properties of undefined (reading 'pane')"));
		expect(crash.detail).toBe("run error: Cannot read properties of undefined (reading 'pane')");
		expect(crash.stopReason).toBeNull();
	});

	it("is total — a thrown string, null or object does not break the report", () => {
		for (const junk of [null, undefined, "boom", 7, {}]) {
			expect(() => codingCrashReport(junk)).not.toThrow();
			expect(codingCrashReport(junk).stopReason).toBeNull();
		}
	});
});

describe("`interrupted` is distinguishable from a run whose objective failed (#546 AC 2)", () => {
	it("does not collide with any reason an outcome can produce", () => {
		// The AC in one assertion: whatever the loop reports about the OBJECTIVE, it can never
		// produce `interrupted`, so a reader seeing that reason knows the invocation was cut off.
		const outcomes = ["done", "failed", "stuck", "needs_input", "max_steps", "cancelled", "waiting"] as const;
		expect(outcomes.length, "every CodingOutcome must be covered here").toBe(7);
		for (const o of outcomes) expect(stopReasonFor(o), o).not.toBe("interrupted");
	});

	it("lands in Needs you, not Failed — the owner has to look before re-running", () => {
		expect(statusFor("interrupted")).toBe("needs_human");
		expect(needsHuman("interrupted")).toBe(true);
		// And it is genuinely a different column from a failure, which is the point.
		expect(statusFor("failed")).toBe("failed");
	});

	it("maps every stop reason to a status, so no reason can land nowhere", () => {
		// G1/G3: the reason list is read off the type's own source rather than retyped, so a
		// reason added without a status mapping fails here instead of silently defaulting.
		const source = readFileSync(join(__dirname, "agent-loop.ts"), "utf8");
		const decl = /export type LoopStopReason =([\s\S]*?);\n/.exec(source);
		expect(decl, "LoopStopReason's declaration shape changed — re-read this guard").not.toBeNull();
		const reasons = [...decl![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) as LoopStopReason[];
		expect(reasons.length, "found no reasons — the regex stopped measuring").toBeGreaterThanOrEqual(8);
		expect(reasons).toContain("interrupted");
		for (const r of reasons) {
			expect(["completed", "failed", "needs_human", "cancelled"], r).toContain(statusFor(r));
		}
	});
});

describe("runOutcomeNote — the line both the run row and the card carry", () => {
	it("names a breach ahead of the act summary, and keeps the authority line", () => {
		expect(
			runOutcomeNote({
				outcome: "done",
				detail: "opened PR #12",
				breach: "merged to main without authority",
				authorityNote: "Authority: may not merge",
				actLine: "Acts: pushed a branch",
			}),
		).toBe("outcome: done — opened PR #12 | POLICY VIOLATION: merged to main without authority | Authority: may not merge | Acts: pushed a branch");
	});

	it("drops every empty part rather than emitting bare separators", () => {
		expect(runOutcomeNote({ outcome: "failed", detail: "", breach: "", authorityNote: null, actLine: null })).toBe("outcome: failed");
	});
});

describe("the note does not lead with `outcome: failed` for a run the platform cut off (#523)", () => {
	const CEILING =
		"Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";

	/** The run in the ticket: 2h 02m, 26 Pilot steps, 15 pushes to `main`, killed by the ceiling. */
	const ceilingNote = () => {
		const crash = codingCrashReport(new Error(CEILING));
		return runOutcomeNote({
			outcome: outcomeWord("failed", crash.stopReason),
			detail: crash.detail,
			breach: "",
			authorityNote: null,
			actLine: "Acts: pushed directly to the trunk origin main; and 14 more.",
		});
	};

	it("says interrupted, not failed — the one string the board card and check_delegation both show", () => {
		const note = ceilingNote();
		expect(note.startsWith("outcome: interrupted — ")).toBe(true);
		// The defect in one assertion: the head contradicted the sentence three words later.
		expect(note).not.toContain("outcome: failed");
		expect(note).toContain("not by the objective");
		// …and what the run had already done survives beside it, which is the half that decides
		// whether the owner re-runs two hours of work that is already on the trunk.
		expect(note).toContain("pushed directly to the trunk origin main");
	});

	it("is the SAME reading the row records — the word and the reason cannot disagree", () => {
		const crash = codingCrashReport(new Error(CEILING));
		expect(crash.stopReason).toBe("interrupted");
		expect(outcomeWord("failed", crash.stopReason)).toBe("interrupted");
		// The column follows the same reason, so all three surfaces say one thing (#546).
		expect(statusFor(crash.stopReason as LoopStopReason)).toBe("needs_human");
	});

	it("rewords NOTHING else — every ordinary ending keeps its own word", () => {
		// G1: the outcome list is the same seven `CodingOutcome`s asserted above, so an added
		// outcome fails here rather than being silently reworded.
		const outcomes = ["done", "failed", "stuck", "needs_input", "max_steps", "cancelled", "waiting"] as const;
		expect(outcomes.length, "every CodingOutcome must be covered here").toBe(7);
		let checked = 0;
		for (const o of outcomes) {
			// A crash that is NOT an interruption records `stopReasonFor(o)`, which the test above
			// proves can never be `interrupted` — so the word is the outcome's own, untouched.
			expect(outcomeWord(o, stopReasonFor(o)), o).toBe(o);
			expect(outcomeWord(o, null), o).toBe(o);
			expect(outcomeWord(o, undefined), o).toBe(o);
			checked++;
		}
		expect(checked, "outcomes checked against every reason they can produce").toBe(7);
	});

	it("spends the card's 300 characters on the run, not on a Wrangler docs page", () => {
		// Composed the way production composes it, then cut the way the board cuts it. Measured on
		// the ticket's own run BEFORE this change, the 300 characters ran out here:
		//
		//   outcome: interrupted — Interrupted by the platform, not by the objective — Too many API
		//   requests by single Worker invocation. To configure this limit, refer to
		//   https://developers.cloudflare.com/workers/wrangler/configuration/#limits. Whatever this
		//   run had already committed or pushed is unaffected; …
		//
		// — 81 characters of URL for a Worker the reader does not own, a cut mid-sentence, and the
		// fifteen pushes gone entirely. That is the ticket's title, still true after #546.
		const card = cardDetail(ceilingNote());
		expect(card.length).toBeLessThanOrEqual(CARD_DETAIL_MAX);
		expect(card).toContain("not by the objective");
		expect(card).toContain("already committed or pushed is unaffected");
		// The half a supervisor decides on: this run put work on the trunk before it was cut off.
		expect(card).toContain("pushed directly to the trunk origin main");
		// …and the vendor's page for a Worker the reader cannot configure is not what survived.
		expect(card).not.toContain("developers.cloudflare.com");
		// The platform still says WHAT stopped it — the message is evidence, and it goes last
		// because it is the part that may safely be cut.
		expect(card).toContain("Too many API requests by single Worker invocation");
	});

	it("strips only the vendor's own advice — a message it cannot parse reaches the owner intact", () => {
		expect(withoutVendorAdvice("Worker exceeded CPU time limit")).toBe("Worker exceeded CPU time limit");
		expect(withoutVendorAdvice("Too many subrequests. See https://developers.cloudflare.com/workers/platform/limits/")).toBe(
			"Too many subrequests.",
		);
		// A URL that is NOT Cloudflare's docs is content, not boilerplate, and stays.
		expect(withoutVendorAdvice("clone failed: https://github.com/owner/repo.git not found")).toContain("github.com/owner/repo.git");
	});

	it("is what the workflow actually composes — the placeholder cannot come back", () => {
		// The rule lives in this module, but the ONE caller is a Workflow, and a Workflow's report
		// can only be tested by running one. So the call shape is asserted from source, the way
		// `coding-resume.test.ts` asserts the teardown it cannot execute.
		const source = readFileSync(join(__dirname, "..", "workflows", "coding-session.ts"), "utf8");
		expect(source.length, "read no workflow source — this guard is measuring nothing").toBeGreaterThan(10_000);
		expect(source).toContain("outcome: outcomeWord(outcome.outcome, reason),");
		// `outcome: outcome.outcome` is the raw placeholder every death carries. Its return is the
		// only way `outcome: failed` gets back onto an interrupted run's card.
		expect(source).not.toContain("outcome: outcome.outcome,");
		// …and the word is derived from the SAME `reason` the row is finished with.
		expect(source).toContain("const reason = crashReason ?? stopReasonFor(outcome.outcome);");
		expect(source).toContain("finishLoopRun(env, event.payload.loopRunId as string, reason, note, Date.now())");
	});
});
