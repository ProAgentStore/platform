import { describe, expect, it } from "vitest";
import { parseLocalApplyResult, type LocalApplyResultEnvelope } from "./contract.js";
import { trustedDocumentPreflightFailure } from "./preflight-failure.js";
import { fullUnverifiedAttempt } from "./reconciliation-store.js";
import type { ApplyRun } from "./store.js";

function result(): LocalApplyResultEnvelope {
	return {
		runId: "run-1", traceId: "run-1", outcome: "blocked", mode: "auto_submit", engineAuth: "unknown", filled: 0, uploaded: [], submitAttempted: false, summary: "", blockReason: "artifact_changed",
		preflightFailure: { schemaVersion: 1, runId: "run-1", phase: "documents", reason: "artifact_changed" },
		executionEvidence: { schemaVersion: 1, fieldCounts: "unmeasured", nativeCalls: { attempted: 0, succeeded: 0, failed: 0, notDispatched: 0, dropped: 0, truncated: false, coverage: "unavailable" }, screenshotsDelivered: 0, screenshotRequests: 0, independentScreenshotAvailable: false, blockingQuestions: 0, optionalQuestions: 0, browser: { state: "unavailable", timeouts: 0 }, causes: [] },
	};
}
function run(): ApplyRun {
	return { id: "run-1", status: "blocked", runnerVersion: "0.4.225", policy: { toolAccess: "full" }, result: result(), trace: [{ type: "run.requested", at: new Date().toISOString() }, { type: "source.read", at: new Date().toISOString(), detail: { role: "profile" } }] } as ApplyRun;
}

describe("positive document-preflight receipt", () => {
	it("exempts only the exact supported document-only failure from Full uncertainty", () => {
		const r = run(); expect(trustedDocumentPreflightFailure(r)).toBe(true); expect(fullUnverifiedAttempt(r)).toBe(false);
		expect(fullUnverifiedAttempt(r, { submitAttemptedAt: 1 })).toBe(true);
		expect(fullUnverifiedAttempt(r, { submitAttemptedAt: null })).toBe(false);
		expect(trustedDocumentPreflightFailure({ ...r, engineAuth: "machine-login" })).toBe(false);
		for (const runnerVersion of [null, "", "unknown", "0.4.223", "0.4.224"]) expect(trustedDocumentPreflightFailure({ ...r, runnerVersion })).toBe(false);
		expect(trustedDocumentPreflightFailure({ ...r, id: "another-run" })).toBe(false);
		const historical = result(); delete historical.preflightFailure;
		expect(fullUnverifiedAttempt({ ...r, result: historical })).toBe(true);
	});
	it("permits a platform approval decision but rejects a submit classification after browser dispatch", () => {
		const r = run();
		r.trace.push({ type: "policy.decision", at: new Date().toISOString(), detail: { class: "submit", decision: "allowed", basis: "application_approval" } });
		expect(trustedDocumentPreflightFailure(r)).toBe(true);
		r.trace.push({ type: "policy.decision", at: new Date().toISOString(), detail: { tool: "browser_click", class: "submit", decision: "refused", reason: "fill_and_review" } });
		expect(trustedDocumentPreflightFailure(r)).toBe(false);
	});
	it.each(["engine.auth_checked", "engine.started", "browser.navigated", "field.filled", "artifact.uploaded", "screenshot.captured", "submit.attempted", "supervisor.checkpoint"])("rejects a receipt contradicted by retained %s activity", (type) => {
		const r = run(); r.trace.push({ type, at: new Date().toISOString() } as ApplyRun["trace"][number]);
		expect(trustedDocumentPreflightFailure(r)).toBe(false); expect(fullUnverifiedAttempt(r)).toBe(true);
	});
	it.each([
		{ filled: 1 }, { filled: "1" }, { submitAttempted: "false" }, { uploaded: ["resume"] }, { submitAttempted: true }, { submissionVerification: "unverified" }, { engineAuth: "machine-login" }, { outcome: "awaiting_review" }, { blockReason: "incomplete" }, { traceId: "another-run" },
		{ preflightFailure: { schemaVersion: 1, runId: "another-run", phase: "documents", reason: "artifact_changed" } },
		{ preflightFailure: { schemaVersion: 1, runId: "run-1", phase: "browser", reason: "artifact_changed" } },
		{ executionEvidence: { ...result().executionEvidence, nativeCalls: { ...result().executionEvidence!.nativeCalls, attempted: 1 } } },
		{ executionEvidence: { ...result().executionEvidence, causes: ["engine_failure"] } },
		{ executionEvidence: { ...result().executionEvidence, causes: ["unrecognized_activity"] } },
		{ submitted: { url: "https://example.test/confirmation" } },
		{ diagnostic: { cause: "engine_exited_nonzero", bridgeCalls: 1 } },
	])("refuses malformed or contradictory claims: %j", (change) => {
		expect(parseLocalApplyResult({ ...result(), ...change })).toHaveProperty("error");
	});
});
