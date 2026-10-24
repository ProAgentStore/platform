import { describe, expect, it, vi } from "vitest";
import { upsertConnectorGrant } from "./connector-grants.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { completedReleaseEvidence, runReleaseNoteQueue } from "./release-note-queue.js";
import type { Env } from "../types.js";

const SHA = "b".repeat(40);
const required = [
	{ path: ".github/workflows/ci.yml", role: "check" as const },
	{ path: ".github/workflows/e2e-full.yml", role: "check" as const },
	{ path: ".github/workflows/deploy.yml", role: "production_deploy" as const },
];
const run = (path: string, extra: Record<string, unknown> = {}) => ({ id: required.findIndex((x) => x.path === path) + 1, path, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "success", ...extra });

describe("exact-SHA production release gate", () => {
	it("requires each named workflow, including production deploy, on the same SHA", () => {
		const all = required.map((x) => run(x.path));
		expect(completedReleaseEvidence(all, SHA, "main", required)).toHaveLength(3);
		expect(completedReleaseEvidence(all.slice(0, 2), SHA, "main", required)).toBeNull();
		expect(completedReleaseEvidence([all[0], run(required[1].path, { head_sha: "c".repeat(40) }), all[2]], SHA, "main", required)).toBeNull();
		expect(completedReleaseEvidence([all[0], run(required[1].path, { status: "in_progress" }), all[2]], SHA, "main", required)).toBeNull();
		expect(completedReleaseEvidence([all[0], all[1], run(required[2].path, { conclusion: "failure" })], SHA, "main", required)).toBeNull();
	});
	it("a later failed rerun defeats an earlier green result", () => {
		const all = required.map((x) => run(x.path));
		expect(completedReleaseEvidence([...all, run(required[2].path, { run_attempt: 2, conclusion: "failure", updated_at: "2026-10-24T10:00:00Z" })], SHA, "main", required)).toBeNull();
		expect(completedReleaseEvidence([...all, run(required[2].path, { run_attempt: 2, conclusion: "failure", updated_at: "2026-10-24T10:00:00Z" }), run(required[2].path, { run_attempt: 1, id: 30, updated_at: "2026-10-24T11:00:00Z" })], SHA, "main", required)).toHaveLength(3);
	});
	it("waits for all checks, then posts once to the selected grant with evidence", async () => {
		const d1 = realSchemaD1();
		try {
			seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
			const env = { DB: d1.DB } as unknown as Env;
			const grant = await upsertConnectorGrant(env, "inst-1", "u1", { provider: "slack", resourceId: "C0123456789", resourceName: "#release-notes", resourceType: "slack_channel" });
			await d1.DB.prepare("UPDATE agent_instances SET config=?1 WHERE id='inst-1'").bind(JSON.stringify({ releaseNotes: { enabled: true, channels: [grant.id], requiredWorkflows: required } })).run();
			const ctx = { instanceId: "inst-1", runId: "run-1", repo: "acme/app", defaultBranch: "main", commitRange: "aaaaaaa…bbbbbbb", changes: ["fix: delivered"], changesCapped: false, closedIssues: [], ciStatus: "pending", headSha: SHA, pushedAt: new Date().toISOString() };
			await d1.DB.prepare(`INSERT INTO release_note_queue (id,user_id,instance_id,repo_id,github_repo,default_branch,run_id,session_id,sha,grant_id,context_json,workflows_json,status,created_at,updated_at) VALUES ('q1','u1','inst-1','repo-1','acme/app','main','run-1','sess-1',?1,?2,?3,?4,'pending',?5,?5)`).bind(SHA, grant.id, JSON.stringify(ctx), JSON.stringify(required), Date.now()).run();
			const deliver = vi.fn(async (_channel: unknown, _text: string) => ({ ok: true as const, permalink: "https://app.slack.com/archives/C0123456789/p12345" }));
			const deps = { deliver: () => deliver, readRuns: async () => required.slice(0, 2).map((x) => run(x.path)) };
			await runReleaseNoteQueue(env, deps);
			expect(deliver).not.toHaveBeenCalled();
			deps.readRuns = async () => required.map((x) => run(x.path));
			await runReleaseNoteQueue(env, deps);
			expect(deliver).toHaveBeenCalledTimes(1);
			expect(deliver.mock.calls[0]?.[1]).toContain(`Commit: ${SHA}`);
			expect(deliver.mock.calls[0]?.[1]).toContain("Production deploy");
			await runReleaseNoteQueue(env, deps);
			expect(deliver).toHaveBeenCalledTimes(1);
			const status = await d1.DB.prepare("SELECT status, permalink FROM release_note_queue WHERE id='q1'").first<{ status: string; permalink: string }>();
			expect(status?.status).toBe("sent");
			expect(status?.permalink).toContain("app.slack.com");
		} finally { d1.close(); }
	});
});
