import { describe, expect, it, vi } from "vitest";
import { upsertConnectorGrant } from "./connector-grants.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { classifyStatus, type GithubPage, type PageFetcher } from "./github-evidence.js";
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

// ── #1349: the tick reads the runner-recorded range and every workflow run, page by page ──

const BASE_SHA = "0".repeat(40);
const sha40 = (n: number) => `${(n + 0x1000000).toString(16)}${"c".repeat(33)}`;
type Msg = (i: number, n: number) => string;
/** `n` linear commits on BASE_SHA, oldest first; the newest is exactly SHA (the pushed head). */
function history(n: number, message: Msg = (i) => `feat: change ${i}`) {
	return Array.from({ length: n }, (_x, i) => ({ sha: i === n - 1 ? SHA : sha40(i + 1), commit: { message: message(i, n) }, parents: [{ sha: i === 0 ? BASE_SHA : i === n - 1 ? sha40(n - 1) : sha40(i) }] }));
}
const ok = (body: unknown): GithubPage => ({ ok: true, body, next: null });
const refused = (status: number): GithubPage => ({ ok: false, kind: classifyStatus(status, { get: () => null }), status, message: `GitHub answered ${status}` });

/** GitHub for repo acme/app: its default branch, the paged compare, issue titles, and the paged workflow runs of SHA. */
function github(state: { commits: ReturnType<typeof history>; runs?: Array<Record<string, unknown>>; branch?: string; fail?: (path: string) => GithubPage | null; total?: number }) {
	const calls: string[] = [];
	const fetchPage: PageFetcher = async (path) => {
		calls.push(path);
		const forced = state.fail?.(path);
		if (forced) return forced;
		const pageNo = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
		if (path === "/repos/acme/app") return ok({ default_branch: state.branch ?? "main" });
		if (path.includes("/compare/")) {
			const all = state.commits;
			return ok({ status: "ahead", base_commit: { sha: BASE_SHA }, total_commits: state.total ?? all.length, commits: all.slice((pageNo - 1) * 50, pageNo * 50) });
		}
		const issue = /\/issues\/(\d+)$/.exec(path);
		if (issue) return ok({ title: `Issue ${issue[1]}` });
		if (path.includes("/actions/runs")) {
			const all = state.runs ?? required.map((x) => run(x.path));
			return ok({ total_count: all.length, workflow_runs: all.slice((pageNo - 1) * 100, pageNo * 100) });
		}
		return { ok: false, kind: "permanent", status: 404, message: "GitHub answered 404" };
	};
	return { fetchPage, calls, compareCalls: () => calls.filter((c) => c.includes("/compare/")), runCalls: () => calls.filter((c) => c.includes("/actions/runs")) };
}

/** A gated row exactly as the run end leaves it: keyed by the pushed prefix, range recorded, nothing read from GitHub. */
async function seedAwaiting(over: { workflows?: unknown[]; status?: string; ageMs?: number; merges?: unknown[] } = {}) {
	const q = await seedQueue(over.workflows ?? required, over.workflows ?? required, over.status ?? "pending");
	const ctx = { instanceId: "inst-1", runId: "run-1", repo: "acme/app", defaultBranch: "main", commitRange: null, changes: [], changesCapped: false, closedIssues: [], ciStatus: "pending", headSha: null, pushedAt: new Date().toISOString(), pendingRange: { base: BASE_SHA.slice(0, 7), head: SHA.slice(0, 7), branch: "main", ...(over.merges ? { merges: over.merges } : {}) } };
	const created = Date.now() - (over.ageMs ?? 0);
	await q.d1.DB.prepare("UPDATE release_note_queue SET sha=?1, context_json=?2, created_at=?3, updated_at=?3 WHERE id='q1'").bind(SHA.slice(0, 7), JSON.stringify(ctx), created).run();
	const full = () => q.d1.DB.prepare("SELECT sha, status, reason, hold_code, context_json FROM release_note_queue WHERE id='q1'").first<{ sha: string; status: string; reason: string | null; hold_code: string | null; context_json: string }>();
	return { ...q, full };
}
const deployPath = required[2].path;
const filler = (from: number, to: number) => Array.from({ length: to - from }, (_x, i) => ({ id: 1000 + from + i, path: `.github/workflows/noise-${from + i}.yml`, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1 }));
/** 250 runs where each required workflow sits on a different page: ci on page 1, e2e-full on page 2, deploy on page 3. */
const spread = (extra: Array<Record<string, unknown>> = []) => {
	const all = [...filler(0, 250), ...extra];
	all[5] = run(required[0].path);
	all[150] = run(required[1].path);
	all[220] = run(deployPath);
	return all;
};

describe("the queue tick reads the whole range and every workflow run (#1349)", () => {
	it("verifies a 51-commit range to the true pushed head, keeps every closing reference, labels the subjects it omits, finds workflows on pages 2 and 3, and posts once", async () => {
		const q = await seedAwaiting();
		try {
			const commits = history(51, (i, n) => (i === 2 ? "fix: early one\n\ncloses #12" : i === n - 1 ? "feat: newest\n\nfixes #34" : `feat: change ${i}`));
			const gh = github({ commits, runs: spread() });
			const deps = { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) };
			await runReleaseNoteQueue(q.env, deps);
			await runReleaseNoteQueue(q.env, deps);
			expect(q.deliver).toHaveBeenCalledTimes(1);
			const text = q.deliver.mock.calls[0]?.[1] ?? "";
			expect(text).toContain(`Commit: ${SHA}`);
			expect(text).toContain("…and 43 more changes"); // 51 verified subjects, 8 shown
			const row = await q.full();
			expect(row).toMatchObject({ sha: SHA, status: "sent", hold_code: null, reason: null });
			const ctx = JSON.parse(row?.context_json ?? "{}");
			expect(ctx.pendingRange).toBeUndefined();
			expect(ctx).toMatchObject({ headSha: SHA, commitRange: `${sha40(1).slice(0, 7)}…${SHA.slice(0, 7)} (51 commits)`, changesOmitted: 1 });
			expect(ctx.changes).toHaveLength(50);
			expect(ctx.changes[0]).toBe("feat: newest");
			expect(ctx.closedIssues).toEqual([{ number: 12, title: "Issue 12" }, { number: 34, title: "Issue 34" }]); // #12 is in the OLDEST, omitted-from-summary commits
			expect(gh.compareCalls()).toHaveLength(2);
			expect(gh.runCalls()).toHaveLength(3); // pages 1, 2 and 3 of the 250 runs
		} finally { q.d1.close(); }
	});

	it("a failed rerun on page 3 blocks a note that page 1 alone would have allowed, and a later green run releases it once", async () => {
		const q = await seedAwaiting();
		try {
			const failedRerun = { id: 900, path: deployPath, head_sha: SHA, head_branch: "main", status: "completed", conclusion: "failure", run_attempt: 2, updated_at: "2026-10-24T12:00:00Z" };
			const state = { commits: history(3), runs: spread([failedRerun]) as Array<Record<string, unknown>> };
			const gh = github(state);
			const deps = { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job({ run_attempt: 2 })) };
			await runReleaseNoteQueue(q.env, deps);
			expect(q.deliver).not.toHaveBeenCalled();
			expect(gh.runCalls().some((c) => /[?&]page=3\b/.test(c))).toBe(true);
			expect((await q.full())?.status).toBe("pending");
			// The deploy workflow is rerun and succeeds (later than the failure).
			state.runs = spread([{ ...failedRerun, id: 901, conclusion: "success", run_attempt: 3, updated_at: "2026-10-24T13:00:00Z" }]);
			const deps2 = { ...deps, readJobsPage: pages(job({ id: 778, run_id: 901, run_attempt: 3 })) };
			await runReleaseNoteQueue(q.env, deps2);
			await runReleaseNoteQueue(q.env, deps2);
			expect(q.deliver).toHaveBeenCalledTimes(1);
		} finally { q.d1.close(); }
	});

	it.each([["a rate limit (429)", 429], ["a server error (503)", 503]])("%s while reading the range leaves the row pending with the reason, posts nothing, and succeeds on a later tick", async (_name, status) => {
		const q = await seedAwaiting();
		try {
			let down = true;
			const gh = github({ commits: history(60), runs: spread(), fail: (path) => (down && path.includes("/compare/") && /[?&]page=2\b/.test(path) ? refused(status) : null) });
			const deps = { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) };
			await runReleaseNoteQueue(q.env, deps);
			const waiting = await q.full();
			expect(waiting).toMatchObject({ sha: SHA.slice(0, 7), status: "pending", hold_code: null });
			expect(waiting?.reason).toMatch(new RegExp(`${status}.*retry`));
			expect(q.deliver).not.toHaveBeenCalled();
			down = false;
			await runReleaseNoteQueue(q.env, deps);
			expect(q.deliver).toHaveBeenCalledTimes(1);
			expect(await q.full()).toMatchObject({ sha: SHA, status: "sent", reason: null });
		} finally { q.d1.close(); }
	});

	it("a rate limit while reading the workflow runs also waits, then succeeds", async () => {
		const q = await seedAwaiting();
		try {
			let down = true;
			const gh = github({ commits: history(3), runs: spread(), fail: (path) => (down && path.includes("/actions/runs") && /[?&]page=2\b/.test(path) ? refused(429) : null) });
			const deps = { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) };
			await runReleaseNoteQueue(q.env, deps);
			expect((await q.full())?.reason).toMatch(/429.*retry/);
			expect(q.deliver).not.toHaveBeenCalled();
			down = false;
			await runReleaseNoteQueue(q.env, deps);
			expect(q.deliver).toHaveBeenCalledTimes(1);
		} finally { q.d1.close(); }
	});

	it("a range over 250 commits is held with a typed reason after one read, never posts, and is not read again", async () => {
		const q = await seedAwaiting();
		try {
			const gh = github({ commits: history(251), runs: spread() });
			const deps = { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) };
			await runReleaseNoteQueue(q.env, deps);
			const held = await q.full();
			expect(held).toMatchObject({ status: "held", hold_code: "commit_range_over_limit" });
			expect(held?.reason).toMatch(/251 commits, more than the 250/);
			expect(gh.compareCalls()).toHaveLength(1);
			const before = gh.calls.length;
			await runReleaseNoteQueue(q.env, deps);
			expect(gh.calls.length).toBe(before);
			expect(q.deliver).not.toHaveBeenCalled();
			const event = await q.d1.DB.prepare("SELECT context FROM agent_events WHERE event='release_note_evidence_held'").first<{ context: string }>();
			expect(JSON.parse(event?.context ?? "{}")).toMatchObject({ queueId: "q1", holdCode: "commit_range_over_limit" });
		} finally { q.d1.close(); }
	});

	it.each([
		["a range that ends at another commit", { commits: history(60).map((c, i, all) => (i === all.length - 1 ? { ...c, sha: sha40(7777) } : c)) }, "commit_range_wrong_head"],
		["a total that disagrees with the pages", { commits: history(120), total: 121 }, "commit_range_inconsistent"],
		["a repository whose default branch is not the pushed branch", { commits: history(3), branch: "develop" }, "default_branch_mismatch"],
		["a repository GitHub refuses to show", { commits: history(3), fail: (p: string) => (p === "/repos/acme/app" ? refused(404) : null) }, "github_refused"],
	])("%s is held with its own code and never posts", async (_name, state, code) => {
		const q = await seedAwaiting();
		try {
			const gh = github(state as Parameters<typeof github>[0]);
			await runReleaseNoteQueue(q.env, { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) });
			expect(await q.full()).toMatchObject({ status: "held", hold_code: code });
			expect(q.deliver).not.toHaveBeenCalled();
		} finally { q.d1.close(); }
	});

	it("more workflow runs than the documented bound holds the note, after reading exactly the bounded pages", async () => {
		const q = await seedAwaiting();
		try {
			const gh = github({ commits: history(3), runs: filler(0, 1500) });
			await runReleaseNoteQueue(q.env, { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) });
			const held = await q.full();
			expect(held).toMatchObject({ status: "held", hold_code: "workflow_runs_over_limit", sha: SHA });
			expect(held?.reason).toContain("1000 workflow runs");
			expect(gh.runCalls()).toHaveLength(10);
			expect(q.deliver).not.toHaveBeenCalled();
		} finally { q.d1.close(); }
	});

	it("a row whose verified commit already has a note for that channel is cancelled, not sent twice", async () => {
		const q = await seedAwaiting();
		try {
			await q.d1.DB.prepare("INSERT INTO release_note_queue (id,user_id,instance_id,repo_id,github_repo,default_branch,run_id,session_id,sha,grant_id,context_json,workflows_json,status,created_at,updated_at) SELECT 'other',user_id,instance_id,repo_id,github_repo,default_branch,run_id,session_id,?1,grant_id,context_json,workflows_json,'sent',created_at,updated_at FROM release_note_queue WHERE id='q1'").bind(SHA).run();
			const gh = github({ commits: history(3), runs: spread() });
			await runReleaseNoteQueue(q.env, { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) });
			expect(await q.full()).toMatchObject({ status: "cancelled", reason: expect.stringContaining("already exists") });
			expect(q.deliver).not.toHaveBeenCalled();
		} finally { q.d1.close(); }
	});

	it("the 48-hour expiry is unchanged: an old awaiting row expires without any GitHub read", async () => {
		const q = await seedAwaiting({ ageMs: 49 * 3_600_000 });
		try {
			const gh = github({ commits: history(3), runs: spread() });
			await runReleaseNoteQueue(q.env, { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) });
			expect((await q.full())?.status).toBe("expired");
			expect(gh.calls).toEqual([]);
		} finally { q.d1.close(); }
	});

	it("an old gate keeps an awaiting row held without reading GitHub; completing the gate resumes the range read", async () => {
		const q = await seedAwaiting({ workflows: legacy });
		try {
			const gh = github({ commits: history(3), runs: spread() });
			const deps = { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) };
			await runReleaseNoteQueue(q.env, deps);
			expect((await q.full())?.status).toBe("configuration_required");
			expect(gh.calls).toEqual([]);
			await q.configure(required);
			await runReleaseNoteQueue(q.env, deps);
			expect(q.deliver).toHaveBeenCalledTimes(1);
			expect(await q.full()).toMatchObject({ sha: SHA, status: "sent" });
		} finally { q.d1.close(); }
	});
});

// ── #1350: the tick re-proves each reported PR merge from GitHub before a note can post ──

const ev = (method: "merge" | "squash" | "rebase", over: Record<string, unknown> = {}) => ({ v: 1, repo: "acme/app", pr: 42, baseRef: "main", method, beforeSha: BASE_SHA, afterSha: SHA, mergedAt: "2026-10-25T10:00:05Z", mergedBy: "serge", actor: "serge", ...over });
const prBody = (over: Record<string, unknown> = {}) => ({ merged: true, merged_at: "2026-10-25T10:00:05Z", merge_commit_sha: SHA, merged_by: { login: "serge" }, base: { ref: "main", repo: { full_name: "acme/app" } }, head: { sha: sha40(2) }, commits: 1, ...over });
const c = (sha: string, parents: string[], message = "feat: change") => ({ sha, commit: { message }, parents: parents.map((p) => ({ sha: p })) });
/** The three shapes GitHub produces for one PR: one squashed commit, N rebased commits, or the PR's commits plus a merge commit. */
const SHAPES = {
	squash: { commits: [c(SHA, [BASE_SHA], "feat: squashed (#42)")], pr: prBody({ commits: 3 }), parents: [BASE_SHA] },
	rebase: { commits: [c(sha40(1), [BASE_SHA]), c(sha40(2), [sha40(1)]), c(SHA, [sha40(2)])], pr: prBody({ commits: 3 }), parents: [sha40(2)] },
	merge: { commits: [c(sha40(1), [BASE_SHA]), c(sha40(2), [sha40(1)]), c(SHA, [BASE_SHA, sha40(2)], "Merge pull request #42")], pr: prBody({ commits: 2 }), parents: [BASE_SHA, sha40(2)] },
};

/** GitHub with the PR and its merge commit served beside the compare, and any path overridable. */
function mergeGithub(shape: keyof typeof SHAPES, over: { pr?: Record<string, unknown> | null; parents?: string[]; commits?: ReturnType<typeof c>[]; fail?: (path: string) => GithubPage | null } = {}) {
	const base = SHAPES[shape];
	const gh = github({
		commits: (over.commits ?? base.commits) as ReturnType<typeof history>,
		runs: spread(),
		fail: (path) => {
			const forced = over.fail?.(path);
			if (forced) return forced;
			if (path === "/repos/acme/app/pulls/42") return over.pr === null ? ({ ok: false, kind: "permanent", status: 404, message: "GitHub answered 404" }) : ok(over.pr ?? base.pr);
			const asked = /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})$/.exec(path)?.[1];
			if (asked) return ok({ sha: asked, parents: (over.parents ?? base.parents).map((sha) => ({ sha })) });
			return null;
		},
	});
	return gh;
}
const merged = async (shape: keyof typeof SHAPES, over: Parameters<typeof mergeGithub>[1] = {}, evidenceOver: Record<string, unknown> = {}, method: "merge" | "squash" | "rebase" = shape) => {
	const q = await seedAwaiting({ merges: [ev(method, evidenceOver)] });
	const gh = mergeGithub(shape, over);
	await runReleaseNoteQueue(q.env, { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) });
	return { q, gh, row: await q.full() };
};

describe("a reported PR merge is re-proved from GitHub, then the note posts once (#1350)", () => {
	it.each(["merge", "squash", "rebase"] as const)("a %s merge: PR, merge commit and range all agree, so one note posts for the merge's own range", async (shape) => {
		const { q, gh, row } = await merged(shape);
		try {
			expect(q.deliver).toHaveBeenCalledTimes(1);
			expect(q.deliver.mock.calls[0]?.[1]).toContain(`Commit: ${SHA}`);
			expect(row).toMatchObject({ status: "sent", sha: SHA, hold_code: null });
			expect(gh.calls).toContain("/repos/acme/app/pulls/42");
			expect(gh.calls).toContain(`/repos/acme/app/commits/${SHA}`);
			expect(JSON.parse(row?.context_json ?? "{}").pendingRange).toBeUndefined();
		} finally { q.d1.close(); }
	});

	const held = async (shape: keyof typeof SHAPES, over: Parameters<typeof mergeGithub>[1], evidenceOver: Record<string, unknown>, reason: RegExp, method?: "merge" | "squash" | "rebase") => {
		const { q, row } = await merged(shape, over, evidenceOver, method);
		try {
			expect(row, JSON.stringify(row)).toMatchObject({ status: "held", hold_code: "pr_merge_unverified" });
			expect(row?.reason).toMatch(reason);
			expect(q.deliver).not.toHaveBeenCalled();
		} finally { q.d1.close(); }
	};
	it("a PR GitHub says is not merged", async () => { await held("squash", { pr: prBody({ merged: false, merged_at: null }) }, {}, /not merged according to GitHub/); });
	it("a PR that merged into another branch", async () => { await held("squash", { pr: prBody({ base: { ref: "release", repo: { full_name: "acme/app" } } }) }, {}, /did not merge into acme\/app:main/); });
	it("a PR in another repository than the note's", async () => { await held("squash", { pr: prBody({ base: { ref: "main", repo: { full_name: "acme/other" } } }) }, {}, /did not merge into/); });
	it("evidence reported for another branch or repository", async () => {
		await held("squash", {}, { baseRef: "release" }, /was reported for acme\/app:release, not acme\/app:main/);
		await held("squash", {}, { repo: "acme/other" }, /was reported for acme\/other/);
	});
	it("a merge commit that is not the one the runner named", async () => { await held("squash", { pr: prBody({ merge_commit_sha: sha40(9) }) }, {}, /merge commit on GitHub is not the one the runner reported/); });
	it("a PR someone else merged", async () => { await held("squash", { pr: prBody({ merged_by: { login: "mallory" } }) }, {}, /not merged by the account that ran the command/); });
	it("an actor that is not the merger", async () => { await held("squash", {}, { actor: "mallory" }, /not merged by the account that ran the command/); });
	it("an unrelated branch update between the prior tip and the merge", async () => {
		await held("squash", { parents: [sha40(9)] }, {}, /was made on .{7}, not the .{7} the runner reported/);
	});
	it("a merge commit outside the delivered range GitHub verified", async () => {
		const other = sha40(77);
		await held("squash", { pr: prBody({ merge_commit_sha: other }), parents: [BASE_SHA] }, { afterSha: other }, /not inside the verified delivered range/);
	});
	it("a 'merge' whose result is not a merge of the PR head", async () => {
		await held("merge", { pr: prBody({ head: { sha: sha40(5) }, commits: 2 }) }, {}, /not a merge commit of the pull request's head/);
		await held("merge", { parents: [BASE_SHA] }, {}, /not a merge commit of the pull request's head/);
	});
	it("a squash whose result has two parents", async () => { await held("merge", {}, {}, /squash result has 2 parents/, "squash"); });
	it("a rebase that cannot be mapped to the PR's commits, or is not one line on the prior tip", async () => {
		await held("rebase", { pr: prBody({ commits: 9 }) }, {}, /rebase cannot be mapped to its 9 commit/);
		await held("rebase", { pr: prBody({ commits: 2 }) }, {}, /rebase is ambiguous: its 2 commit/);
		const forked = [c(sha40(1), [BASE_SHA]), c(sha40(2), [BASE_SHA]), c(SHA, [sha40(2)])];
		await held("rebase", { commits: forked }, {}, /rebase is ambiguous: its 3 commit/);
	});
	it("a PR GitHub cannot show is held", async () => { await held("squash", { pr: null }, {}, /could not be read from GitHub/); });

	it("a rate limit reading the PR waits and tries again; it does not hold or post", async () => {
		const q = await seedAwaiting({ merges: [ev("squash")] });
		try {
			let down = true;
			const gh = mergeGithub("squash", { fail: (p) => (down && p === "/repos/acme/app/pulls/42" ? refused(429) : null) });
			const deps = { deliver: () => q.deliver, fetchPage: gh.fetchPage, readJobsPage: pages(job()) };
			await runReleaseNoteQueue(q.env, deps);
			expect(await q.full()).toMatchObject({ status: "pending", hold_code: null, sha: SHA.slice(0, 7) });
			expect((await q.full())?.reason).toMatch(/429.*retry/);
			expect(q.deliver).not.toHaveBeenCalled();
			down = false;
			await runReleaseNoteQueue(q.env, deps);
			expect(q.deliver).toHaveBeenCalledTimes(1);
		} finally { q.d1.close(); }
	});
});
