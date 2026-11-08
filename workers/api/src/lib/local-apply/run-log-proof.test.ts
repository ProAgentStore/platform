import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import type { JobApplication } from "../local-artifact/store.js";
import type { ApplyRun } from "./store.js";
import { fullSubmissionNeedsReconciliation, getLocalApplyReconciliation } from "./reconciliation-store.js";

let d1: RealSchemaD1;
const now = 1_700_000_000_000;
const policy: ApplyRun["policy"] = { engine: "claude", authMode: "machine", browserProfile: "isolated", mode: "fill_and_review", toolAccess: "full", allowDomains: ["jobs.example.test"], limits: { maxMinutes: 10, maxPages: 10, maxActions: 100 }, gate: { allowed: false, gateId: null, checks: [] } };
const CLEAN = { status: "available", epoch: "e", lastSeq: 3, dropped: 0, priorEpochDropped: 0, invalidRecords: 0, restartObserved: false, legacyEpochUnknown: false, pageLimitReached: false };

const resultFor = (attempted: number, over: Record<string, unknown> = {}, native: Record<string, unknown> = {}) => ({
	runId: "run-1", traceId: "run-1", outcome: "blocked", mode: "fill_and_review", engineAuth: "unknown", filled: 0, uploaded: [], submitAttempted: false, summary: "",
	executionEvidence: { schemaVersion: 1, fieldCounts: "unmeasured", nativeCalls: { attempted, succeeded: attempted, failed: 0, notDispatched: 0, dropped: 0, truncated: false, coverage: "retained", ...native }, screenshotsDelivered: 0, screenshotRequests: 0, independentScreenshotAvailable: false, blockingQuestions: 0, optionalQuestions: 0, browser: { state: "healthy", timeouts: 0 }, causes: [] },
	...over,
});
const call = (seq: number, tool: string, args: Record<string, unknown> = {}) => ({ seq, callId: `c${seq}`, subject: { kind: "local_apply_run", id: "run-1" }, tool, args, startedAt: new Date(now).toISOString(), durationMs: 5, outcome: "ok", internal: false });

const app = (over: Partial<JobApplication> = {}): JobApplication => ({
	id: "app-1", instanceId: "tailor", sourceInstanceId: "scout", leadId: "lead", lifecycleVersion: 3, idempotencyKey: "key", workKey: "stable-job", status: "blocked", lead: {}, tailoringRunId: null,
	resumeArtifact: { kind: "resume", path: "r.pdf", sha256: "a".repeat(64), bytes: 1 }, coverLetterArtifact: { kind: "cover_letter", path: "c.pdf", sha256: "b".repeat(64), bytes: 1 },
	profileVersion: "profile-1", generatedAt: null, blockReason: "login_required", blockQuestions: [], readyEvent: null, readyEmittedAt: null, createdAt: now, updatedAt: now, stateVersion: 4,
	fillRunId: "run-1", submitAttemptedAt: null, submittedAt: null, submittedUrl: null, archiveReason: null, archiveEvidence: null, leadDispositionSyncedAt: null, ...over,
});
const run = (result: unknown): ApplyRun => ({ id: "run-1", instanceId: "runner", applicationId: "app-1", requestId: "run-1", status: "blocked", policy, pause: null, result, engineAuth: null, errorCode: null, error: null, runnerNode: "mac", runnerVersion: "0.4.240", trace: [], runnerSeq: 0, lastSyncedAt: null, createdAt: now, startedAt: now, endedAt: now });

/** Seeds the cloud-retained log the way refreshBrowserEvidence stores it. */
function seed(calls: unknown[], coverage: Record<string, unknown> = CLEAN) {
	d1.sqlite.prepare("INSERT INTO browser_run_evidence(user_id,instance_id,subject_kind,subject_id,coverage,state_status,refreshed_at,expires_at) VALUES('u1','runner','local_apply_run','run-1',?,'unavailable',?,?)").run(JSON.stringify(coverage), now, now + 1e9);
	for (const c of calls as Array<{ seq: number; callId: string }>) d1.sqlite.prepare("INSERT INTO browser_run_calls(user_id,instance_id,subject_kind,subject_id,call_id,epoch,seq,record,stored_at,expires_at) VALUES('u1','runner','local_apply_run','run-1',?,'e',?,?,?,?)").run(c.callId, c.seq, JSON.stringify(c), now, now + 1e9);
}
const needs = (a: JobApplication, r: ApplyRun) => fullSubmissionNeedsReconciliation({ DB: d1.DB }, "u1", a, r);

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1');
		INSERT INTO agents (id, owner_id, slug, name) VALUES ('agent', 'u1', 'agent', 'Agent');
		INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('runner', 'agent', 'u1', 'active', '{}'), ('tailor', 'agent', 'u1', 'active', '{}');
		INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, work_key, status, lead, resume_artifact, cover_letter_artifact, profile_version, block_reason, created_at, updated_at, state_version, fill_run_id)
		VALUES ('app-1', 'tailor', 'u1', 'scout', 'lead', 3, 'key', 'stable-job', 'blocked', '{}', '{"sha256":"${"a".repeat(64)}"}', '{"sha256":"${"b".repeat(64)}"}', 'profile-1', 'login_required', ${now}, ${now}, 4, 'run-1');
		INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, created_at, updated_at, ended_at)
		VALUES ('run-1', 'runner', 'u1', 'app-1', 'run-1', 'blocked', '${JSON.stringify(policy)}', '[]', ${now}, ${now}, ${now});`);
});
afterEach(() => d1.close());

const safe = [call(1, "browser_navigate", { url: "https://jobs.example.test/x" }), call(2, "browser_snapshot"), call(3, "browser_click", { element: "Apply" })];

describe("#1579 a complete retained call log proves no submission", () => {
	it("proves a complete safe log, persists an exact-run record and is material bound", async () => {
		seed(safe);
		const r = run(resultFor(3));
		expect(await needs(app(), r)).toBe(false);
		expect(await getLocalApplyReconciliation({ DB: d1.DB }, "run-1", "runner", "u1")).toMatchObject({ state: "no_submission_proven", proofKind: "run_native_call_log_no_submission", runId: "run-1" });
		expect(await needs(app({ profileVersion: "changed" }), r)).toBe(true);
	});
	it("replaces an ambiguous site-history record", async () => {
		seed(safe);
		d1.exec(`INSERT INTO local_apply_reconciliations (id, run_id, application_id, instance_id, user_id, reconciliation_state, proof_kind, job_identity, material_lead_version, material_profile_version, material_resume_sha, material_cover_letter_sha, requested_at, resolved_at, created_at, updated_at)
			VALUES ('rec', 'run-1', 'app-1', 'runner', 'u1', 'ambiguous', 'ambiguous_site_history', '{"sourceInstanceId":"scout","leadId":"lead","workKey":"stable-job","lifecycleVersion":3}', 3, 'profile-1', '${"a".repeat(64)}', '${"b".repeat(64)}', ${now}, ${now}, ${now}, ${now})`);
		expect(await needs(app(), run(resultFor(3)))).toBe(false);
	});
	it("gives no proof when a call was dropped", async () => {
		seed(safe, { ...CLEAN, dropped: 1 });
		expect(await needs(app(), run(resultFor(3, {}, { dropped: 1 })))).toBe(true);
		expect(await needs(app(), run(resultFor(3)))).toBe(true);
	});
	it("gives no proof when the retained log is shorter than the measured count or truncated", async () => {
		seed(safe);
		expect(await needs(app(), run(resultFor(4)))).toBe(true);
		expect(await needs(app(), run(resultFor(3, {}, { truncated: true })))).toBe(true);
		expect(await needs(app(), run(resultFor(3, {}, { coverage: "unavailable" })))).toBe(true);
	});
	it.each(["browser_evaluate", "browser_run_code", "browser_run_code_unsafe", "browser_file_upload", "browser_fill_form", "browser_type", "browser_select_option", "mystery_tool"])("gives no proof when the log contains %s", async (tool) => {
		seed([...safe, call(4, tool)]);
		expect(await needs(app(), run(resultFor(4)))).toBe(true);
	});
	it("gives no proof for a final-action click or an Enter key", async () => {
		seed([...safe, call(4, "browser_click", { element: "Submit application" })]);
		expect(await needs(app(), run(resultFor(4)))).toBe(true);
		d1.exec("DELETE FROM browser_run_calls");
		d1.sqlite.prepare("INSERT INTO browser_run_calls(user_id,instance_id,subject_kind,subject_id,call_id,epoch,seq,record,stored_at,expires_at) VALUES('u1','runner','local_apply_run','run-1','k','e',9,?,?,?)").run(JSON.stringify(call(9, "browser_press_key", { key: "Enter" })), now, now + 1e9);
		expect(await needs(app(), run(resultFor(1)))).toBe(true);
	});
	it("gives no proof when a submit was attempted or a field was filled or uploaded", async () => {
		seed(safe);
		expect(await needs(app({ submitAttemptedAt: now - 1, blockReason: "submit_unconfirmed" }), run(resultFor(3)))).toBe(true);
		expect(await needs(app(), run(resultFor(3, { submitAttempted: true })))).toBe(true);
		expect(await needs(app(), run(resultFor(3, { filled: 2 })))).toBe(true);
		expect(await needs(app(), run(resultFor(3, { uploaded: ["resume"] })))).toBe(true);
	});
	it("gives no proof without a retained log", async () => {
		expect(await needs(app(), run(resultFor(3)))).toBe(true);
	});
});
