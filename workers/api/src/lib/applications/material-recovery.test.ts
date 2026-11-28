import { describe, expect, it } from "vitest";
import type { JobApplication } from "../local-artifact/store.js";
import type { ApplyRun } from "../local-apply/store.js";
import { canRegenerateMissingMaterials } from "./material-recovery.js";

const app = { id: "app", status: "blocked", fillRunId: "run", submitAttemptedAt: null, blockReason: "artifact_changed" } as JobApplication;
function run(): ApplyRun {
	return { id: "run", applicationId: "app", status: "blocked", endedAt: 10, trace: [{ type: "source.read", at: "2026-11-04T00:00:00Z" }], result: { runId: "run", outcome: "blocked", blockReason: "artifact_changed", engineAuth: "unknown", filled: 0, uploaded: [], submitAttempted: false } } as ApplyRun;
}

describe("material recovery cannot erase a browser or submission attempt", () => {
	it("allows only the matching terminal pre-engine material failure", () => {
		expect(canRegenerateMissingMaterials(app, run())).toBe(true);
		expect(canRegenerateMissingMaterials(app, null)).toBe(false);
		for (const patch of [{ status: "paused" }, { endedAt: null }, { id: "other" }, { applicationId: "other" }]) expect(canRegenerateMissingMaterials(app, { ...run(), ...patch } as ApplyRun)).toBe(false);
		expect(canRegenerateMissingMaterials({ ...app, submitAttemptedAt: 1 }, run())).toBe(false);
	});
	it.each([{ engineAuth: "machine-login" }, { filled: 1 }, { uploaded: ["resume"] }, { submitAttempted: true }, { submitAttempted: undefined }, { runId: "other" }, { blockReason: "incomplete" }, { submitted: { at: "now" } }])("refuses conflicting result evidence %j", (patch) => {
		const r = run();
		r.result = { ...(r.result as object), ...patch };
		expect(canRegenerateMissingMaterials(app, r)).toBe(false);
	});
	it.each(["engine.started", "browser.navigated", "policy.decision", "field.filled", "artifact.uploaded", "submit.attempted", "note"])("refuses a %s event even if counters are zero", (type) => {
		const r = run();
		r.trace.push({ type, at: "2026-11-04T00:00:00Z" } as ApplyRun["trace"][number]);
		expect(canRegenerateMissingMaterials(app, r)).toBe(false);
	});
});

// ── #1553: an APPROVED run that stopped at document preflight is recoverable, on the positive receipt ───────────────────────────
function receiptRun(over: Record<string, unknown> = {}): ApplyRun {
	const at = "2026-11-04T00:00:00Z";
	const result = {
		runId: "run", traceId: "run", outcome: "blocked", mode: "auto_submit", engineAuth: "unknown", filled: 0, uploaded: [], submitAttempted: false, summary: "", blockReason: "artifact_changed",
		preflightFailure: { schemaVersion: 1, runId: "run", phase: "documents", reason: "artifact_changed" },
		executionEvidence: { schemaVersion: 1, fieldCounts: "unmeasured", nativeCalls: { attempted: 0, succeeded: 0, failed: 0, notDispatched: 0, dropped: 0, truncated: false, coverage: "unavailable" }, screenshotsDelivered: 0, screenshotRequests: 0, independentScreenshotAvailable: false, blockingQuestions: 0, optionalQuestions: 0, browser: { state: "unavailable", timeouts: 0 }, causes: [] },
	};
	return {
		id: "run", applicationId: "app", status: "blocked", endedAt: 10, runnerVersion: "0.4.225", engineAuth: "unknown", policy: { toolAccess: "full" }, result,
		// What an approved run really carries: the dispatch's own toolless submit decision, and the staged artifacts.
		trace: [
			{ type: "run.requested", at }, { type: "source.read", at, detail: { role: "profile" } }, { type: "artifact.staged", at },
			{ type: "policy.decision", at, detail: { class: "submit", decision: "allowed", basis: "application_approval", authorizationId: "auth-1" } },
			{ type: "runner.dispatched", at }, { type: "run.ended", at },
		],
		...over,
	} as unknown as ApplyRun;
}
const approval = (over: Record<string, unknown> = {}) => ({ consumedAt: null, recoveryId: null, revokedAt: null, ...over });

describe("an approved run that stopped at document preflight (#1553)", () => {
	it("the OLD allowlist alone cannot see it — the approval's own policy.decision is why", () => {
		// The same run without a receipt is refused: absence of activity is not proof, and the approval event is not on the allowlist.
		const noReceipt = receiptRun();
		delete (noReceipt.result as Record<string, unknown>).preflightFailure;
		expect(canRegenerateMissingMaterials(app, noReceipt)).toBe(false);
	});

	it("is recoverable on the receipt, with an unspent, unclaimed approval — live or withdrawn — or none", () => {
		expect(canRegenerateMissingMaterials(app, receiptRun(), null)).toBe(true);
		expect(canRegenerateMissingMaterials(app, receiptRun(), approval())).toBe(true);
		expect(canRegenerateMissingMaterials(app, receiptRun(), approval({ revokedAt: 5 }))).toBe(true); // withdrawn is the safest case, never a refusal
	});

	it("refuses a SPENT approval: a run may have used it, and spent is not evidence that nothing was sent", () => {
		expect(canRegenerateMissingMaterials(app, receiptRun(), approval({ consumedAt: 7, consumedRunId: "run" }))).toBe(false);
		expect(canRegenerateMissingMaterials(app, receiptRun(), approval({ consumedAt: "2026-11-04T00:00:00Z" }))).toBe(false); // the card's view carries it as a string
	});

	it("refuses a CLAIMED approval: a one-click recovery is in flight", () => {
		expect(canRegenerateMissingMaterials(app, receiptRun(), approval({ recoveryId: "claim-1" }))).toBe(false);
		expect(canRegenerateMissingMaterials(app, receiptRun(), { consumedAt: null, recoveryPending: true })).toBe(false); // the card's flag for the same fact
	});

	it("the card's view of an approval (no revokedAt) is satisfied by the same guard", () => {
		expect(canRegenerateMissingMaterials(app, receiptRun(), { consumedAt: null })).toBe(true);
	});

	it("keeps every guard the old path had: submit attempt, wrong run, not terminal, wrong block reason", () => {
		expect(canRegenerateMissingMaterials({ ...app, submitAttemptedAt: 1 }, receiptRun(), approval())).toBe(false);
		for (const patch of [{ id: "other" }, { applicationId: "other" }, { status: "paused" }, { endedAt: null }]) expect(canRegenerateMissingMaterials(app, receiptRun(patch), approval())).toBe(false);
		expect(canRegenerateMissingMaterials({ ...app, status: "failed" } as JobApplication, receiptRun(), approval())).toBe(false);
		expect(canRegenerateMissingMaterials({ ...app, blockReason: "incomplete" } as JobApplication, receiptRun(), approval())).toBe(false);
		expect(canRegenerateMissingMaterials(app, null, approval())).toBe(false);
	});

	it("the receipt must be for THIS application's block reason", () => {
		expect(canRegenerateMissingMaterials({ ...app, blockReason: "source_unavailable" } as JobApplication, receiptRun(), approval())).toBe(false);
	});

	it.each(["0.4.224", "0.4.223", "", null])("a runner older than the receipt (%j) gives none: an approved run is then refused", (runnerVersion) => {
		expect(canRegenerateMissingMaterials(app, receiptRun({ runnerVersion }), approval())).toBe(false);
	});

	it.each(["engine.auth_checked", "engine.started", "browser.navigated", "field.filled", "artifact.uploaded", "screenshot.captured", "submit.attempted", "supervisor.checkpoint"])("a %s event contradicts the receipt: refused, approval or not", (type) => {
		const r = receiptRun();
		r.trace.push({ type, at: "2026-11-04T00:00:00Z" } as ApplyRun["trace"][number]);
		expect(canRegenerateMissingMaterials(app, r, null)).toBe(false);
		expect(canRegenerateMissingMaterials(app, r, approval())).toBe(false);
	});

	it("a tool-level policy.decision (a browser tool was asked) contradicts the receipt", () => {
		const r = receiptRun();
		r.trace.push({ type: "policy.decision", at: "2026-11-04T00:00:00Z", detail: { tool: "browser_click", class: "submit", decision: "refused", reason: "fill_and_review" } } as ApplyRun["trace"][number]);
		expect(canRegenerateMissingMaterials(app, r, approval())).toBe(false);
	});

	it.each([{ filled: 1 }, { submitAttempted: true }, { uploaded: ["resume"] }, { engineAuth: "machine-login" }, { outcome: "awaiting_review" }, { runId: "other" }])("a result that contradicts the receipt (%j) is refused", (patch) => {
		const r = receiptRun();
		r.result = { ...(r.result as object), ...patch };
		expect(canRegenerateMissingMaterials(app, r, approval())).toBe(false);
	});

	it("the LEGACY path is unchanged: with no receipt, any live approval still refuses and a withdrawn one does not", () => {
		expect(canRegenerateMissingMaterials(app, run(), approval())).toBe(false);
		expect(canRegenerateMissingMaterials(app, run(), approval({ revokedAt: 5 }))).toBe(true);
		expect(canRegenerateMissingMaterials(app, run(), { consumedAt: null })).toBe(false); // the card's view never reads as withdrawn
		expect(canRegenerateMissingMaterials(app, run(), null)).toBe(true);
	});
});
