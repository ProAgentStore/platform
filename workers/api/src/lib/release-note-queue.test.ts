import { describe, expect, it, vi } from "vitest";
import { upsertConnectorGrant } from "./connector-grants.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { completedReleaseEvidence, JOBS_PAGES_MAX, runReleaseNoteQueue, verifyDeployProof } from "./release-note-queue.js";
import type { Env } from "../types.js";

const SHA = "b".repeat(40);
const required = [
	{ path: ".github/workflows/ci.yml", role: "check" as const },
	{ path: ".github/workflows/e2e-full.yml", role: "check" as const },
	{ path: ".github/workflows/deploy.yml", role: "production_deploy" as const, jobName: "deploy", stepName: "Upload to R2" },
];
const legacy = required.map(({ path, role }) => ({ path, role }));
const run = (path: string, extra: Record<string, unknown> = {}) => ({ id: required.findIndex((x) => x.path === path) + 1, path, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1, ...extra });

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
			const deps = { deliver: () => deliver, readRuns: async () => required.slice(0, 2).map((x) => run(x.path)), readJobsPage: pages(job()) };
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

// Fake GitHub run-attempt job pages (#1346). The deploy run is `required[2]`: id 3, attempt 1.
const job = (extra: Record<string, unknown> = {}) => ({ id: 777, name: "deploy", status: "completed", conclusion: "success", run_id: 3, run_attempt: 1, head_sha: SHA, steps: [{ name: "Checkout", number: 1, status: "completed", conclusion: "success" }, { name: "Upload to R2", number: 4, status: "completed", conclusion: "success" }], ...extra });
const step = (extra: Record<string, unknown>) => job({ steps: [{ name: "Upload to R2", number: 4, status: "completed", conclusion: "success", ...extra }] });
function pages(...jobs: unknown[]) { return async (_row?: unknown, _run?: unknown, _page?: number) => ({ total_count: jobs.length, jobs: jobs as never[] }); }
const row = { github_repo: "acme/app", sha: SHA } as never;
const deployItem = required[2];
const deployRun = () => run(deployItem.path, { run_attempt: 1 });

describe("the production deploy job and step prove the deploy (#1346)", () => {
	it("accepts exactly one successful named job and step on the selected run attempt, and carries their ids", async () => {
		const result = await verifyDeployProof(row, deployRun(), deployItem, pages(job()));
		expect(result).toEqual({ ok: true, proof: { runId: 3, runAttempt: 1, jobId: 777, jobName: "deploy", stepNumber: 4, stepName: "Upload to R2", runUrl: "https://github.com/acme/app/actions/runs/3", jobUrl: "https://github.com/acme/app/actions/runs/3/job/777" } });
	});
	it.each([
		["a skipped job", job({ conclusion: "skipped" }), /Job "deploy" is skipped/],
		["a neutral job", job({ conclusion: "neutral" }), /Job "deploy" is neutral/],
		["a failed job", job({ conclusion: "failure" }), /Job "deploy" is failure/],
		["a cancelled job", job({ conclusion: "cancelled" }), /Job "deploy" is cancelled/],
		["a pending job", job({ status: "in_progress", conclusion: null }), /Job "deploy" is in_progress/],
		["a skipped step", step({ conclusion: "skipped" }), /Step "Upload to R2".* is skipped/],
		["a neutral step", step({ conclusion: "neutral" }), /Step "Upload to R2".* is neutral/],
		["a failed step", step({ conclusion: "failure" }), /Step "Upload to R2".* is failure/],
		["a pending step", step({ status: "in_progress", conclusion: null }), /Step "Upload to R2".* is in_progress/],
		["no step of that name", job({ steps: [{ name: "Checkout", number: 1, status: "completed", conclusion: "success" }] }), /No step named "Upload to R2"/],
		["a job with no steps listed", job({ steps: undefined }), /No step named/],
		["a duplicated step", job({ steps: [{ name: "Upload to R2", number: 4, status: "completed", conclusion: "success" }, { name: "Upload to R2", number: 5, status: "completed", conclusion: "success" }] }), /2 steps are named/],
		["a job of another name", job({ name: "build" }), /No job named "deploy"/],
		["a job from another commit", job({ head_sha: "c".repeat(40) }), /does not belong to the selected run attempt and commit/],
		["a job from another attempt", job({ run_attempt: 2 }), /does not belong to the selected run attempt and commit/],
		["a job from another run", job({ run_id: 99 }), /does not belong to the selected run attempt and commit/],
	])("holds on %s", async (_name, evidenceJob, reason) => {
		const result = await verifyDeployProof(row, deployRun(), deployItem, pages(evidenceJob));
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toMatch(reason);
	});
	it("holds on duplicate matching jobs, an unreadable page, a missing attempt and a gate without selectors", async () => {
		expect(await verifyDeployProof(row, deployRun(), deployItem, pages(job(), job({ id: 778 })))).toMatchObject({ ok: false, reason: expect.stringMatching(/2 jobs are named "deploy".*ambiguous/) });
		expect(await verifyDeployProof(row, deployRun(), deployItem, async () => { throw new Error("GitHub job read returned 502"); })).toMatchObject({ ok: false, reason: expect.stringContaining("returned 502") });
		expect(await verifyDeployProof(row, deployRun(), deployItem, async () => ({ total_count: 1 }))).toMatchObject({ ok: false, reason: expect.stringContaining("no jobs list") });
		expect(await verifyDeployProof(row, run(deployItem.path, { run_attempt: undefined }), deployItem, pages(job()))).toMatchObject({ ok: false, reason: expect.stringContaining("no readable attempt") });
		expect(await verifyDeployProof(row, deployRun(), legacy[2], pages(job()))).toMatchObject({ ok: false, reason: expect.stringContaining("no deploy jobName and stepName") });
	});
	it("follows job pages to the bound, finds the job on a later page, and holds past the bound", async () => {
		const filler = (n: number) => Array.from({ length: 100 }, (_x, i) => job({ id: 1000 + n * 100 + i, name: `matrix-${n}-${i}` }));
		const seen: number[] = [];
		const paged = async (page: number) => { seen.push(page); return { total_count: 150, jobs: (page === 1 ? filler(0) : [job(), ...filler(1).slice(0, 49)]) as never[] }; };
		expect((await verifyDeployProof(row, deployRun(), deployItem, paged)).ok).toBe(true);
		expect(seen).toEqual([1, 2]);
		const endless = async (page: number) => ({ total_count: 9999, jobs: filler(page) as never[] });
		expect(await verifyDeployProof(row, deployRun(), deployItem, endless)).toMatchObject({ ok: false, reason: expect.stringContaining(`more than ${JOBS_PAGES_MAX * 100} jobs`) });
	});
});

async function seedQueue(workflows: unknown[], configWorkflows: unknown[] = workflows, status = "pending") {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	const env = { DB: d1.DB } as unknown as Env;
	const grant = await upsertConnectorGrant(env, "inst-1", "u1", { provider: "slack", resourceId: "C0123456789", resourceName: "#release-notes", resourceType: "slack_channel" });
	const configure = (gate: unknown[]) => d1.DB.prepare("UPDATE agent_instances SET config=?1 WHERE id='inst-1'").bind(JSON.stringify({ releaseNotes: { enabled: true, channels: [grant.id], requiredWorkflows: gate } })).run();
	await configure(configWorkflows);
	const ctx = { instanceId: "inst-1", runId: "run-1", repo: "acme/app", defaultBranch: "main", commitRange: "aaaaaaa…bbbbbbb", changes: ["fix: delivered"], changesCapped: false, closedIssues: [], ciStatus: "pending", headSha: SHA, pushedAt: new Date().toISOString() };
	await d1.DB.prepare(`INSERT INTO release_note_queue (id,user_id,instance_id,repo_id,github_repo,default_branch,run_id,session_id,sha,grant_id,context_json,workflows_json,status,created_at,updated_at) VALUES ('q1','u1','inst-1','repo-1','acme/app','main','run-1','sess-1',?1,?2,?3,?4,?6,?5,?5)`).bind(SHA, grant.id, JSON.stringify(ctx), JSON.stringify(workflows), Date.now(), status).run();
	const deliver = vi.fn(async (_channel: unknown, _text: string) => ({ ok: true as const, permalink: "https://app.slack.com/archives/C0123456789/p12345" }));
	const state = () => d1.DB.prepare("SELECT status, reason, workflows_json, evidence_json FROM release_note_queue WHERE id='q1'").first<{ status: string; reason: string | null; workflows_json: string; evidence_json: string | null }>();
	return { d1, env, deliver, configure, state };
}
const allGreen = async () => required.map((x) => run(x.path));

describe("the queue holds the production note until the deploy job and step succeeded (#1346)", () => {
	it("posts exactly once when workflow, job and step all succeed, with the job link and stored evidence", async () => {
		const { d1, env, deliver, state } = await seedQueue(required);
		try {
			const jobPages = vi.fn(pages(job()));
			const deps = { deliver: () => deliver, readRuns: allGreen, readJobsPage: jobPages };
			await runReleaseNoteQueue(env, deps);
			await runReleaseNoteQueue(env, deps);
			expect(deliver).toHaveBeenCalledTimes(1);
			const text = deliver.mock.calls[0]?.[1] ?? "";
			expect(text).toContain("https://github.com/acme/app/actions/runs/3");
			expect(text).toContain("https://github.com/acme/app/actions/runs/3/job/777");
			expect(jobPages.mock.calls[0]?.[1]).toMatchObject({ id: 3, run_attempt: 1 });
			const done = await state();
			expect(done?.status).toBe("sent");
			expect(JSON.parse(done?.evidence_json ?? "{}")).toMatchObject({ jobId: 777, stepNumber: 4, stepName: "Upload to R2", jobUrl: "https://github.com/acme/app/actions/runs/3/job/777" });
		} finally { d1.close(); }
	});
	it.each([
		["a skipped deploy step", pages(step({ conclusion: "skipped" })), /Step "Upload to R2"/],
		["a skipped deploy job", pages(job({ conclusion: "skipped" })), /Job "deploy" is skipped/],
		["a missing deploy job", pages(job({ name: "build" })), /No job named "deploy"/],
		["a failed deploy step", pages(step({ conclusion: "failure" })), /is failure/],
		["a neutral deploy step", pages(step({ conclusion: "neutral" })), /is neutral/],
		["a job from the wrong attempt", pages(job({ run_attempt: 2 })), /selected run attempt and commit/],
		["a job from the wrong commit", pages(job({ head_sha: "c".repeat(40) })), /selected run attempt and commit/],
		["duplicate matching jobs", pages(job(), job({ id: 778 })), /ambiguous/],
		["a GitHub API error", async () => { throw new Error("GitHub job read returned 500"); }, /returned 500/],
	])("a green workflow with %s posts nothing and names the missing proof", async (_name, readJobsPage, reason) => {
		const { d1, env, deliver, state } = await seedQueue(required);
		try {
			await runReleaseNoteQueue(env, { deliver: () => deliver, readRuns: allGreen, readJobsPage });
			expect(deliver).not.toHaveBeenCalled();
			const held = await state();
			expect(held?.status).toBe("pending");
			expect(held?.reason).toMatch(/^Production deploy not proven: /);
			expect(held?.reason).toMatch(reason);
		} finally { d1.close(); }
	});
	it("a later successful rerun on the same SHA releases the held row once; a failed later attempt supersedes", async () => {
		const { d1, env, deliver, state } = await seedQueue(required);
		try {
			const deps = { deliver: () => deliver, readRuns: allGreen as () => Promise<ReturnType<typeof run>[]>, readJobsPage: pages(step({ conclusion: "skipped" })) as (...a: unknown[]) => Promise<{ total_count?: number; jobs?: never[] }> };
			await runReleaseNoteQueue(env, deps);
			expect(deliver).not.toHaveBeenCalled();
			// Attempt 2 of the same deploy run succeeds, with its own jobs.
			deps.readRuns = async () => [run(required[0].path), run(required[1].path), run(deployItem.path, { run_attempt: 2, updated_at: "2026-10-24T12:00:00Z" })];
			deps.readJobsPage = pages(job({ run_attempt: 2 })) as never;
			await runReleaseNoteQueue(env, deps);
			await runReleaseNoteQueue(env, deps);
			expect(deliver).toHaveBeenCalledTimes(1);
			expect((await state())?.status).toBe("sent");
		} finally { d1.close(); }
		const second = await seedQueue(required);
		try {
			const failedLater = async () => [...required.map((x) => run(x.path)), run(deployItem.path, { run_attempt: 2, conclusion: "failure", updated_at: "2026-10-24T12:00:00Z" })];
			await runReleaseNoteQueue(second.env, { deliver: () => second.deliver, readRuns: failedLater, readJobsPage: pages(job()) });
			expect(second.deliver).not.toHaveBeenCalled();
		} finally { second.d1.close(); }
	});
});

describe("an old gate without deploy job and step is held, never posted (#1346)", () => {
	it("the tick holds a preexisting pending row on an old gate: no GitHub read, no post, channels and row kept", async () => {
		const { d1, env, deliver, state } = await seedQueue(legacy);
		try {
			const readRuns = vi.fn(allGreen);
			await runReleaseNoteQueue(env, { deliver: () => deliver, readRuns, readJobsPage: pages(job()) });
			await runReleaseNoteQueue(env, { deliver: () => deliver, readRuns, readJobsPage: pages(job()) });
			expect(deliver).not.toHaveBeenCalled();
			expect(readRuns).not.toHaveBeenCalled();
			const held = await state();
			expect(held?.status).toBe("configuration_required");
			expect(held?.reason).toContain("jobName and stepName");
			expect(JSON.parse(held?.workflows_json ?? "[]")).toEqual(legacy);
			const config = await d1.DB.prepare("SELECT config FROM agent_instances WHERE id='inst-1'").first<{ config: string }>();
			expect(JSON.parse(config?.config ?? "{}").releaseNotes.channels).toHaveLength(1);
			const events = await d1.DB.prepare("SELECT event FROM agent_events WHERE event='release_note_configuration_required'").all();
			expect(events.results).toHaveLength(1);
		} finally { d1.close(); }
	});
	it("a row enqueued as configuration_required stays held until the owner completes the gate, then releases once", async () => {
		const { d1, env, deliver, configure, state } = await seedQueue(legacy, legacy, "configuration_required");
		try {
			const deps = { deliver: () => deliver, readRuns: allGreen, readJobsPage: pages(job()) };
			await runReleaseNoteQueue(env, deps);
			expect(deliver).not.toHaveBeenCalled();
			expect((await state())?.status).toBe("configuration_required");
			await configure(required);
			await runReleaseNoteQueue(env, deps);
			await runReleaseNoteQueue(env, deps);
			expect(deliver).toHaveBeenCalledTimes(1);
			const done = await state();
			expect(done?.status).toBe("sent");
			expect(JSON.parse(done?.workflows_json ?? "[]")).toEqual(required);
		} finally { d1.close(); }
	});
	it("completing a DIFFERENT gate, or clearing it, cancels the held row instead of resuming it", async () => {
		const { d1, env, deliver, configure, state } = await seedQueue(legacy, legacy, "configuration_required");
		try {
			await configure([required[0], { ...required[2], path: ".github/workflows/other.yml" }]);
			await runReleaseNoteQueue(env, { deliver: () => deliver, readRuns: allGreen, readJobsPage: pages(job()) });
			expect(deliver).not.toHaveBeenCalled();
			expect((await state())?.status).toBe("cancelled");
		} finally { d1.close(); }
	});
});
