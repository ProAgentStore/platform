import { describe, expect, it } from "vitest";
import { visibleSurfaces } from "./surfaces";
import { ACTION_LABEL, QUEUE_STATUS_LABEL, actionBody, actionLabel, canCheckSubmission, checkNeedsOwner, confirmText, reconciliationSentence } from "./applications";
import type { ApplicationQueueItem, ApplicationReconciliationResponse } from "./types";

const base = { key: "app:a", kind: "application", status: "materials_ready", applicationId: "a", stateVersion: 3, scoutInstanceId: "s", leadId: "l", leadVersion: 1, actions: [] } as unknown as ApplicationQueueItem;

describe("the Applications tab's request shape (#958)", () => {
	it("sends the status and version it read — compare-and-set from the console too", () => {
		expect(actionBody(base, "archive")).toEqual({ action: "archive", expected_status: "materials_ready", application_id: "a", expected_version: 3 });
		const lead = { ...base, applicationId: null, status: "new", leadVersion: 0 } as ApplicationQueueItem;
		expect(actionBody(lead, "apply")).toEqual({ action: "apply", expected_status: "new", scout_instance_id: "s", record_id: "l", expected_version: 0 });
	});
	it("the approval is named for what it does at THIS stage (#981)", () => {
		// Before the fill it proceeds; after it, the owner is looking at a populated form and it
		// continues. One action name, two labels — which is what keeps the board, this tab and MCP
		// offering exactly the same permitted action.
		expect(actionLabel("approve_and_proceed", "materials_ready")).toBe("Approve & proceed");
		expect(actionLabel("approve_and_proceed", "awaiting_review")).toBe("Approve & continue");
		expect(actionLabel("approve_and_proceed", "blocked")).toBe("Approve & continue");
		expect(actionLabel("retry_fill", "awaiting_review")).toBe(ACTION_LABEL.retry_fill);
		// Both stages confirm first, and the post-fill wording says what happens if the run has finished.
		expect(confirmText("approve_and_proceed", "materials_ready")).toMatch(/does not enable auto-submit/);
		expect(confirmText("approve_and_proceed", "awaiting_review")).toMatch(/Nothing is submitted twice/);
		expect(confirmText("defer", "awaiting_review")).toBeUndefined();
		// #991: `blocked` reaches the same wording, and it must not claim a form that does not exist —
		// the one-click refusal ends with `filled: 0`, so "this filled application" was untrue there.
		const blocked = confirmText("approve_and_proceed", "blocked") ?? "";
		expect(blocked).toMatch(/Approve THIS application/);
		expect(blocked).not.toMatch(/filled application/);
		expect(blocked).toMatch(/stopped at a control it may not press on its own/);
	});

	it("the approval's idempotency key follows the stage, so a retry reuses one authorization", () => {
		const filled = { ...base, status: "awaiting_review" } as ApplicationQueueItem;
		expect(actionBody(base, "approve_and_proceed").idempotency_key).toBe("approve:a:3");
		expect(actionBody(filled, "approve_and_proceed").idempotency_key).toBe("approve-continue:a:3");
	});

	it("labels every queue status and action, and names the submit control as one", () => {
		expect(Object.keys(QUEUE_STATUS_LABEL)).toHaveLength(12);
		expect(ACTION_LABEL.start_fill).toMatch(/submit/i);
		expect(ACTION_LABEL.request_review).not.toMatch(/submit/i);
	});
});

describe("the Applications tab is the Tailor's and the Runner's", () => {
	it("shows for local_artifact and local_apply agents, not for a Scout or a chat agent", () => {
		const ids = (caps: Parameters<typeof visibleSurfaces>[0]) => visibleSurfaces(caps).map((s) => s.id);
		expect(ids({ surfaces: [], runtime: "local_artifact" })).toContain("applications");
		expect(ids({ surfaces: [], runtime: "local_apply" })).toContain("applications");
		expect(ids({ surfaces: [], runtime: "local_browser" })).not.toContain("applications");
		expect(ids({ surfaces: [] })).not.toContain("applications");
	});
});

describe("the read-only 'was it sent?' check (#1068)", () => {
	const uncertain = { status: "blocked", blockReason: "submit_unconfirmed", submitAttempted: true, submittedAt: null, fillRunId: "run-1" } as const;
	const answer = (state: ApplicationReconciliationResponse["reconciliation"]["state"], runner?: ApplicationReconciliationResponse["runner"]): ApplicationReconciliationResponse => ({ reconciliation: { id: "r", runId: "run-1", applicationId: "a", state, proofKind: null }, ...(runner ? { runner } : {}) });

	it("is offered for exactly the attempt #1013 reconciles — an ended, unconfirmed submit", () => {
		expect(canCheckSubmission(uncertain)).toBe(true);
		expect(canCheckSubmission({ ...uncertain, blockReason: "incomplete" })).toBe(false);
		expect(canCheckSubmission({ ...uncertain, submitAttempted: false })).toBe(false);
		expect(canCheckSubmission({ ...uncertain, submittedAt: "2026-10-14T00:00:00Z" })).toBe(false);
		expect(canCheckSubmission({ ...uncertain, fillRunId: null })).toBe(false);
		expect(canCheckSubmission({ ...uncertain, status: "failed" } as never)).toBe(false);
	});

	it("needs the owner only when the Runner paused at a sign-in or CAPTCHA", () => {
		expect(checkNeedsOwner(answer("requested", { state: "paused", pauseReason: "login_required" }))).toBe(true);
		expect(checkNeedsOwner(answer("requested", { state: "paused", pauseReason: "captcha" }))).toBe(true);
		expect(checkNeedsOwner(answer("requested", { state: "running" }))).toBe(false);
		expect(checkNeedsOwner(answer("requested", { state: "waiting_for_runtime" }))).toBe(false);
	});

	it("never says more than the Runner proved", () => {
		expect(reconciliationSentence(answer("submission_confirmed"))).toMatch(/confirms this application was sent/);
		expect(reconciliationSentence(answer("no_submission_proven"))).toMatch(/shows no submission/);
		// Uncertain, unavailable or still running: nothing reads as "sent" or "not sent".
		for (const r of [answer("ambiguous"), answer("unavailable"), answer("rejected"), answer("requested", { state: "running" }), answer("requested", { state: "waiting_for_runtime" })]) {
			expect(reconciliationSentence(r)).not.toMatch(/was sent|not sent|no submission/i);
		}
		expect(reconciliationSentence(answer("requested", { state: "waiting_for_runtime" }))).toMatch(/not connected/);
	});
});
