import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import type { JobApplication } from "../local-artifact/store.js";
import {
	auditReconciledNoSubmission,
	createLocalApplyHandoff,
	getHandoffById,
	markLocalApplyHandoff,
	reconciliationProvesNoSubmission,
	recordLocalApplyReconciliationProof,
	requestLocalApplyReconciliation,
	type ApplyRun,
} from "./store.js";

let d1: RealSchemaD1;
const now = 1_700_000_000_000;

const policy: ApplyRun["policy"] = {
	engine: "claude",
	authMode: "machine",
	browserProfile: "isolated",
	mode: "fill_and_review",
	allowDomains: ["jobs.example.test"],
	limits: { maxMinutes: 10, maxPages: 10, maxActions: 100 },
	gate: { allowed: false, gateId: null, checks: [] },
};

function run(id: string, status: ApplyRun["status"], applicationId = "app-1"): ApplyRun {
	return { id, instanceId: "runner", applicationId, requestId: id, status, policy, pause: null, result: null, engineAuth: null, errorCode: null, error: null, runnerNode: "mac", runnerVersion: "0.6.0", trace: [], runnerSeq: 0, lastSyncedAt: null, createdAt: now, startedAt: now, endedAt: status === "running" ? null : now };
}

function app(overrides: Partial<JobApplication> = {}): JobApplication {
	return {
		id: "app-1", instanceId: "tailor", sourceInstanceId: "scout", leadId: "lead", lifecycleVersion: 3, idempotencyKey: "key", workKey: "stable-job", status: "blocked", lead: {}, tailoringRunId: null,
		resumeArtifact: { kind: "resume", path: "applications/resume.pdf", sha256: "a".repeat(64), bytes: 1 },
		coverLetterArtifact: { kind: "cover_letter", path: "applications/letter.pdf", sha256: "b".repeat(64), bytes: 1 },
		profileVersion: "profile-1", generatedAt: null, blockReason: "submit_unconfirmed", blockQuestions: [], readyEvent: null, readyEmittedAt: null,
		createdAt: now, updatedAt: now, stateVersion: 4, fillRunId: "run-1", submitAttemptedAt: now - 1, submittedAt: null, submittedUrl: null,
		archiveReason: null, archiveEvidence: null, leadDispositionSyncedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1');
		INSERT INTO agents (id, owner_id, slug, name) VALUES ('agent', 'u1', 'agent', 'Agent');
		INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('runner', 'agent', 'u1', 'active', '{}'), ('tailor', 'agent', 'u1', 'active', '{}');
		INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, work_key, status, lead, resume_artifact, cover_letter_artifact, profile_version, block_reason, created_at, updated_at, state_version, fill_run_id, submit_attempted_at)
		VALUES ('app-1', 'tailor', 'u1', 'scout', 'lead', 3, 'key', 'stable-job', 'blocked', '{}', '{"sha256":"${"a".repeat(64)}"}', '{"sha256":"${"b".repeat(64)}"}', 'profile-1', 'submit_unconfirmed', ${now}, ${now}, 4, 'run-1', ${now - 1});
		INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, created_at, updated_at, ended_at)
		VALUES ('run-1', 'runner', 'u1', 'app-1', 'run-1', 'blocked', '${JSON.stringify(policy)}', '[]', ${now}, ${now}, ${now});`);
});
afterEach(() => d1.close());

describe("#1013 local-apply durable reconciliation", () => {
	it("keeps a handoff exact-owner/run/profile, short-lived, and terminal once lost", async () => {
		const liveRun = run("run-live", "running", "app-live");
		d1.exec(`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, created_at, updated_at, state_version, fill_run_id)
			VALUES ('app-live', 'tailor', 'u1', 'scout', 'live', 1, 'live', 'filling', '{}', ${now}, ${now}, 1, 'run-live');
			INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, created_at, updated_at)
			VALUES ('run-live', 'runner', 'u1', 'app-live', 'run-live', 'running', '${JSON.stringify(policy)}', '[]', ${now}, ${now});`);
		const handoff = await createLocalApplyHandoff({ DB: d1.DB }, { run: liveRun, app: { id: "app-live", fillRunId: "run-live" }, userId: "u1", browserProfile: "isolated", expiresAt: now + 60_000 }, now);
		expect(handoff).toMatchObject({ state: "requested", applicationId: "app-live", browserProfile: "isolated" });
		expect((await createLocalApplyHandoff({ DB: d1.DB }, { run: liveRun, app: { id: "app-live", fillRunId: "run-live" }, userId: "u1", browserProfile: "isolated", expiresAt: now + 60_000 }, now))?.continuityId).toBe(handoff?.continuityId);
		expect(await createLocalApplyHandoff({ DB: d1.DB }, { run: liveRun, app: { id: "app-live", fillRunId: "run-live" }, userId: "u1", browserProfile: "default", expiresAt: now + 60_000 }, now)).toBeNull();
		expect(await getHandoffById({ DB: d1.DB }, "runner", "u2", handoff!.continuityId)).toBeNull();
		expect(await markLocalApplyHandoff({ DB: d1.DB }, { continuityId: handoff!.continuityId, instanceId: "runner", userId: "u1", state: "closed", terminalReason: "page_lost" }, now + 1)).toMatchObject({ state: "closed", terminalReason: "page_lost" });
		expect(await markLocalApplyHandoff({ DB: d1.DB }, { continuityId: handoff!.continuityId, instanceId: "runner", userId: "u1", state: "ready" }, now + 2)).toBeNull();
	});

	it("accepts only structured proof for the same uncertain attempt and keeps the attempt marker immutable", async () => {
		const uncertain = run("run-1", "blocked");
		const original = app();
		const reconciliation = await requestLocalApplyReconciliation({ DB: d1.DB }, { app: original, run: uncertain, userId: "u1" }, now);
		expect(reconciliation).toMatchObject({ state: "requested", proofKind: null });
		expect(await recordLocalApplyReconciliationProof({ DB: d1.DB }, { reconciliation: reconciliation!, app: original, run: uncertain, userId: "u1", state: "no_submission_proven", proofKind: "authorized_site_history_no_submission" }, now + 1)).toMatchObject({ state: "no_submission_proven", proofKind: "authorized_site_history_no_submission" });
		const resolved = await recordLocalApplyReconciliationProof({ DB: d1.DB }, { reconciliation: reconciliation!, app: original, run: uncertain, userId: "u1", state: "no_submission_proven", proofKind: "authorized_site_history_no_submission" }, now + 2);
		expect(resolved).toBeNull();
		const current = (await import("../local-artifact/store.js")).getOwnedApplication;
		const stored = await current({ DB: d1.DB }, "u1", "app-1");
		expect(stored?.submitAttemptedAt).toBe(now - 1);
		expect(reconciliationProvesNoSubmission(await (await import("./store.js")).getLocalApplyReconciliation({ DB: d1.DB }, "run-1", "runner", "u1"), stored!, uncertain)).toBe(true);
		const durable = await (await import("./store.js")).getLocalApplyReconciliation({ DB: d1.DB }, "run-1", "runner", "u1");
		expect(durable).not.toBeNull();
		if (!durable) throw new Error("the reconciliation proof was not stored");
		expect(await auditReconciledNoSubmission({ DB: d1.DB }, { reconciliation: durable, app: stored!, run: uncertain, userId: "u1" }, now + 3)).toBe(true);
		expect((await current({ DB: d1.DB }, "u1", "app-1"))?.submitAttemptedAt).toBe(now - 1);
	});

	it("rejects changed reviewed material and never records raw reconciliation evidence", async () => {
		const uncertain = run("run-1", "blocked");
		const reconciliation = await requestLocalApplyReconciliation({ DB: d1.DB }, { app: app(), run: uncertain, userId: "u1" }, now);
		expect(await recordLocalApplyReconciliationProof({ DB: d1.DB }, { reconciliation: reconciliation!, app: app({ profileVersion: "changed" }), run: uncertain, userId: "u1", state: "no_submission_proven", proofKind: "authorized_site_history_no_submission" }, now + 1)).toBeNull();
		const columns = d1.sqlite.prepare("PRAGMA table_info(local_apply_reconciliations)").all() as Array<{ name: string }>;
		expect(columns.map((c) => c.name)).not.toEqual(expect.arrayContaining(["url", "receipt", "history", "cookies", "tokens", "browser_state"]));
	});
});
