/**
 * The per-application submission authorization's rules (#973).
 *
 * These are the security boundary — what an approval does and does not permit — so they are tested
 * without a database. The gate integration is asserted here too, because "an approval satisfies the
 * intent checks and NOT the safety checks" is the whole design and is easy to break by widening the
 * list in `APPROVAL_SATISFIES`.
 */
import { describe, expect, it } from "vitest";
import { APPROVAL_SATISFIES, type ApprovableApplication, type SubmitAuthorization, approvalEligibility, approvalStageOf, approvalState, fingerprintOf, sameFingerprint } from "./approval.js";
import { RUNNER_DEFAULTS, evaluateSubmitGate, mergeRunnerSettings } from "./policy.js";
import { type ApplyRunStatus, isTerminalApplyRun } from "./store.js";

const APP: ApprovableApplication = {
	id: "app-1",
	status: "materials_ready",
	// The fill that produced the form, or null before one ran. Load-bearing for the stage: a block
	// with a fill behind it is a decision about a form, a block without one is about tailoring.
	fillRunId: null,
	stateVersion: 4,
	lifecycleVersion: 2,
	profileVersion: "profile-v7",
	resumeArtifact: { sha256: "r-sha" },
	coverLetterArtifact: { sha256: "c-sha" },
	submitAttemptedAt: null,
};

const AUTH: SubmitAuthorization = {
	id: "auth-1",
	applicationId: "app-1",
	instanceId: "tailor-1",
	approvedBy: "owner",
	approvedAt: 1_000,
	approvedStateVersion: 4,
	approvedStatus: "materials_ready",
	idempotencyKey: "approve:app-1:4",
	fingerprint: fingerprintOf(APP),
	consumedAt: null,
	consumedRunId: null,
	revokedAt: null,
	revokedReason: null,
};

describe("an approval is usable only for the work it was given for (#973)", () => {
	it("is usable for the application as approved", () => {
		expect(approvalState(AUTH, APP)).toMatchObject({ usable: true, reason: null });
	});

	it("no approval at all is the default, and it is not usable", () => {
		expect(approvalState(null, APP)).toMatchObject({ usable: false, reason: null, label: "Not approved for submission." });
	});

	it("is single-use: once a run has spent it, it is not usable again", () => {
		const spent = { ...AUTH, consumedAt: 2_000, consumedRunId: "run-1" };
		expect(approvalState(spent, APP)).toMatchObject({ usable: false, reason: "consumed" });
		expect(approvalState(spent, APP).label).toMatch(/single-use/);
	});

	it("a withdrawn approval is not usable", () => {
		expect(approvalState({ ...AUTH, revokedAt: 3_000, revokedReason: "changed my mind" }, APP)).toMatchObject({ usable: false, reason: "revoked" });
	});

	it.each([
		["the résumé was re-tailored", { resumeArtifact: { sha256: "r-sha-2" } }],
		["the cover letter was re-tailored", { coverLetterArtifact: { sha256: "c-sha-2" } }],
		["the profile moved on", { profileVersion: "profile-v8" }],
		["the lead itself was revised", { lifecycleVersion: 3 }],
	])("cannot be replayed after a material change: %s", (_why, change) => {
		expect(approvalState(AUTH, { ...APP, ...change })).toMatchObject({ usable: false, reason: "materials_changed" });
	});

	it("survives the ordinary state advance it causes — `state_version` is audit, not the validity test", () => {
		// materials_ready → filling bumps stateVersion. An authorization bound to that counter would
		// invalidate itself one step after being granted, which is the bug this design avoids.
		expect(approvalState(AUTH, { ...APP, status: "filling", stateVersion: 5 })).toMatchObject({ usable: true });
	});

	it("ends once any submit has been attempted, whoever attempted it", () => {
		expect(approvalState(AUTH, { ...APP, submitAttemptedAt: 9_000 })).toMatchObject({ usable: false, reason: "submit_attempted" });
	});

	it("is bound to ONE application — a fingerprint from another does not match", () => {
		const other = { ...APP, id: "app-2", resumeArtifact: { sha256: "other" } };
		expect(sameFingerprint(AUTH.fingerprint, fingerprintOf(other))).toBe(false);
	});
});

describe("who may be approved, and when", () => {
	it("a materials_ready application with no approval yet", () => {
		expect(approvalEligibility(APP, null)).toEqual({ eligible: true });
	});

	it.each(["tailoring", "filling", "blocked", "submitted", "archived"])("not an application in %s", (status) => {
		expect(approvalEligibility({ ...APP, status }, null).eligible).toBe(false);
	});

	it("not twice: a live approval is not re-granted", () => {
		expect(approvalEligibility(APP, AUTH)).toMatchObject({ eligible: false, why: expect.stringMatching(/already approved/) });
	});

	it("not after a run spent one — that run is the record of what was authorized", () => {
		expect(approvalEligibility(APP, { ...AUTH, consumedAt: 2_000, consumedRunId: "run-1" })).toMatchObject({ eligible: false, why: expect.stringMatching(/already used by a run/) });
	});

	it("re-approvable after a material change, because that is new work", () => {
		const changed = { ...APP, resumeArtifact: { sha256: "r-sha-2" } };
		expect(approvalEligibility(changed, AUTH)).toEqual({ eligible: true });
	});

	it("never after a submit was attempted", () => {
		expect(approvalEligibility({ ...APP, submitAttemptedAt: 1 }, null).eligible).toBe(false);
	});
});

describe("the gate: an approval answers intent, never safety (#973)", () => {
	const settings = (over: Record<string, unknown> = {}) => {
		const merged = mergeRunnerSettings(RUNNER_DEFAULTS, { allowDomains: ["jobs.example.com"], ...over });
		if ("error" in merged) throw new Error(merged.error);
		return merged.settings;
	};
	const gateInput = (over: Partial<Parameters<typeof evaluateSubmitGate>[0]> = {}) => ({
		settings: settings(),
		application: {
			profileVersion: "profile-v7",
			resumeSha: "r-sha",
			coverLetterSha: "c-sha",
			blockReason: null,
			submitAttemptedAt: null,
			leadUrl: "https://jobs.example.com/roles/1",
			lead: { title: "Head of Engineering", company: "Acme", location: "Melbourne" },
		},
		autoSubmitsToday: 0,
		activeRuns: 0,
		...over,
	});
	const failing = (r: { checks: Array<{ check: string; ok: boolean }> }) => r.checks.filter((c) => !c.ok).map((c) => c.check);

	it("without an approval the default policy refuses — auto-submit off, no cap, no approved role", () => {
		const r = evaluateSubmitGate(gateInput());
		expect(r.allowed).toBe(false);
		expect(failing(r)).toEqual(expect.arrayContaining(["auto_submit_enabled", "daily_cap", "role_matches"]));
		// Nothing about an approval appears when none was offered.
		expect(r.checks.some((c) => c.check === "submission_approved")).toBe(false);
	});

	it("a usable approval allows the submit with NO auto-submit toggle and NO daily cap", () => {
		const r = evaluateSubmitGate(gateInput({ approval: { id: "auth-1", usable: true } }));
		expect(r.allowed).toBe(true);
		expect(r.checks.find((c) => c.check === "submission_approved")).toMatchObject({ ok: true, why: "authorization auth-1" });
		// The cap is untouched and unconsulted: the settings still have dailyCap 0 and auto-submit off.
		expect(r.checks.find((c) => c.check === "daily_cap")).toMatchObject({ ok: true, why: "approved for this application by the owner" });
		expect(r.checks.find((c) => c.check === "auto_submit_enabled")).toMatchObject({ ok: true });
	});

	it("every check it satisfies is an INTENT check, and each one is still listed with its reason", () => {
		const r = evaluateSubmitGate(gateInput({ approval: { id: "auth-1", usable: true } }));
		for (const name of APPROVAL_SATISFIES) {
			expect(r.checks.find((c) => c.check === name), name).toMatchObject({ ok: true, why: "approved for this application by the owner" });
		}
		// The audit survives: an allowed gate still records all ten checks plus the approval.
		expect(r.checks).toHaveLength(11);
	});

	it.each([
		["incomplete materials", { application: { ...gateInput().application, resumeSha: null } }, "materials_complete"],
		["a site that is not allow-listed", { application: { ...gateInput().application, leadUrl: "https://elsewhere.example/apply" } }, "domain_allowlisted"],
		["a blocker on the application", { application: { ...gateInput().application, blockReason: "missing_answer" } }, "no_blocker"],
		["another run already open", { activeRuns: 1 }, "concurrency"],
	])("does NOT override a safety check: %s", (_why, over, check) => {
		const r = evaluateSubmitGate(gateInput({ approval: { id: "auth-1", usable: true }, ...over }));
		expect(r.allowed).toBe(false);
		expect(failing(r)).toContain(check);
	});

	it("an unusable approval refuses explicitly rather than falling back to policy silence", () => {
		const r = evaluateSubmitGate(gateInput({ approval: { id: "auth-1", usable: false } }));
		expect(r.allowed).toBe(false);
		expect(r.checks.find((c) => c.check === "submission_approved")).toMatchObject({ ok: false, why: expect.stringMatching(/no longer usable/) });
	});
});

/**
 * WHEN an approval is a decision (#981). The rule is here, in the pure half, because it is what
 * decides whether a card offers the button at all — and the live gap was an `awaiting_review`
 * application that offered defer, archive and nothing else.
 */
describe("the two stages at which the owner can approve (#981)", () => {
	const at = (status: string) => ({ status }) as Parameters<typeof approvalStageOf>[0];

	it("materials_ready is the pre-fill decision — it dispatches the fill that spends it", () => {
		expect(approvalStageOf(at("materials_ready"), null)).toBe("pre_fill");
	});

	it("awaiting_review is the post-fill decision: the form is filled and nothing was sent", () => {
		expect(approvalStageOf(at("awaiting_review"), null)).toBe("post_fill");
	});

	it("a run parked at a SUPERVISOR CHECKPOINT is the same situation one step earlier", () => {
		expect(approvalStageOf(at("blocked"), { status: "paused", pauseReason: "supervisor_checkpoint" })).toBe("post_fill");
	});

	it("a run parked on a QUESTION is not — a submission authorizes none of those", () => {
		expect(approvalStageOf(at("blocked"), { status: "paused", pauseReason: "missing_answer" })).toBeNull();
		expect(approvalStageOf(at("blocked"), { status: "paused", pauseReason: "challenge" })).toBeNull();
		expect(approvalStageOf(at("blocked"), { status: "running", pauseReason: null })).toBeNull();
		expect(approvalStageOf(at("blocked"), null)).toBeNull();
	});

	it("a blocked application whose FILL ENDED is the post-fill decision, for every ended status (#991)", () => {
		// The live one-click case, and the pairing the comment on `approvalStageOf` claims: "live" in
		// this module is exactly the complement of `isTerminalApplyRun` in the store. A new run status
		// added to one list and not the other would silently make an open run approvable (or hide a
		// stopped one), so the two are asserted against each other rather than described.
		const statuses: readonly ApplyRunStatus[] = ["queued", "running", "paused", "awaiting_review", "submitted", "blocked", "failed", "cancelled"];
		const filled = { status: "blocked", fillRunId: "run-1" } as Parameters<typeof approvalStageOf>[0];
		for (const status of statuses) {
			const stage = approvalStageOf(filled, { status, pauseReason: null });
			expect(stage, `${status} (terminal: ${isTerminalApplyRun(status)})`).toBe(isTerminalApplyRun(status) ? "post_fill" : null);
		}
		// No run row at all reads as ended too — the run is gone, the application is not.
		expect(approvalStageOf(filled, null)).toBe("post_fill");
		// And blocked at TAILORING stays out of it: no fill, no form, no final control.
		expect(approvalStageOf({ status: "blocked", fillRunId: null }, null)).toBeNull();
	});

	it("nothing else is a stage — mid-fill is a run already holding the decision", () => {
		for (const status of ["tailoring", "filling", "submitted", "failed", "cancelled", "deferred", "archived"]) {
			expect(approvalStageOf(at(status), null), status).toBeNull();
		}
	});

	it("eligibility follows the stage it is GIVEN, not the status it can guess", () => {
		// The caller sees the run; this function must not re-derive a stage from half the facts.
		const filled = { ...APP, status: "awaiting_review" };
		expect(approvalEligibility(filled, null, "post_fill")).toEqual({ eligible: true });
		expect(approvalEligibility(filled, null, null).eligible).toBe(false);
		expect(approvalEligibility({ ...APP, status: "blocked" }, null, "post_fill")).toEqual({ eligible: true });
		// And the refusals that are about the application, not the stage, still hold at both stages.
		expect(approvalEligibility({ ...filled, submitAttemptedAt: 1 }, null, "post_fill").why).toMatch(/already attempted/);
	});
});
