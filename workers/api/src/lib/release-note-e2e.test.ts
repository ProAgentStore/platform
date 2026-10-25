/**
 * #1345 — the epic's acceptance, end to end over the real schema: a direct push recorded by `recordEngineActs`, the run end's
 * `postReleaseNotes`, and the queue tick, with only GitHub and the channel faked. A ChessClubs-shaped gate (CI, E2E (full) and
 * Deploy to R2 on ONE SHA) posts exactly one announcement to the selected Slack channel, and no missing, failed, skipped,
 * ambiguous or other-SHA evidence posts anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyUser } = vi.hoisted(() => ({ notifyUser: vi.fn() }));
vi.mock("../routes/push.js", async (orig) => ({ ...(await orig<typeof import("../routes/push.js")>()), notifyUser }));

import { upsertConnectorGrant } from "./connector-grants.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { recordEngineActs, type EngineActReport } from "./engine-acts.js";
import { classifyStatus, type GithubPage, type PageFetcher } from "./github-evidence.js";
import { runReleaseNoteQueue } from "./release-note-queue.js";
import { postReleaseNotes, type ReleaseChannel } from "./release-notes.js";
import type { Env } from "../types.js";

const HEAD = "e".repeat(40);
const BASE = "a".repeat(40);
const OTHER = "f".repeat(40);
const GATE = [
	{ path: ".github/workflows/ci.yml", role: "check" as const },
	{ path: ".github/workflows/e2e-full.yml", role: "check" as const },
	{ path: ".github/workflows/deploy-r2.yml", role: "production_deploy" as const, jobName: "deploy", stepName: "Deploy to R2" },
];
const wf = (i: number, over: Record<string, unknown> = {}) => ({ id: i + 1, path: GATE[i].path, head_sha: HEAD, head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1, ...over });
const ok = (body: unknown): GithubPage => ({ ok: true, body, next: null });

let d1: RealSchemaD1;
let env: Env;
let slackGrantId: string;
let delivered: Array<{ channel: ReleaseChannel; text: string }>;
let runs: Array<Record<string, unknown>>;
let job: Record<string, unknown>;

const github: PageFetcher = async (path) => {
	if (path === "/repos/acme/chessclubs") return ok({ default_branch: "main" });
	if (path.includes("/compare/")) {
		return ok({ status: "ahead", base_commit: { sha: BASE }, total_commits: 1, commits: [{ sha: HEAD, commit: { message: "feat: club ladders\n\ncloses #7" }, parents: [{ sha: BASE }] }] });
	}
	if (/\/issues\/7$/.test(path)) return ok({ title: "Club ladders" });
	if (path.includes("/actions/runs")) return ok({ total_count: runs.length, workflow_runs: runs });
	return { ok: false, kind: classifyStatus(404, { get: () => null }), status: 404, message: "GitHub answered 404" };
};
let jobs: Array<Record<string, unknown>>;
const deps = () => ({
	fetchPage: github,
	readJobsPage: async () => ({ total_count: jobs.length, jobs: jobs as never[] }),
	deliver: () => async (channel: ReleaseChannel, text: string) => {
		delivered.push({ channel, text });
		return { ok: true as const, permalink: "https://app.slack.com/archives/C0RELEASE/p1" };
	},
});
const queueRow = () => d1.DB.prepare("SELECT status, reason, sha, hold_code FROM release_note_queue").first<{ status: string; reason: string | null; sha: string; hold_code: string | null }>();

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, branch) VALUES ('repo-1', 'inst-1', 'u1', 'chessclubs', 'acme/chessclubs', 'main')");
	env = { DB: d1.DB } as unknown as Env;
	notifyUser.mockReset().mockResolvedValue(undefined);
	delivered = [];
	runs = GATE.map((_g, i) => wf(i));
	job = { id: 900, name: "deploy", status: "completed", conclusion: "success", run_id: 3, run_attempt: 1, head_sha: HEAD, steps: [{ name: "Deploy to R2", number: 3, status: "completed", conclusion: "success" }] };
	jobs = [job];
	// Slack #release-notes is the selected channel; a Discord grant on the same instance is NOT selected.
	slackGrantId = (await upsertConnectorGrant(env, "inst-1", "u1", { provider: "slack", resourceId: "C0RELEASE", resourceName: "#release-notes", resourceType: "slack_channel" })).id;
	await upsertConnectorGrant(env, "inst-1", "u1", { provider: "discord", resourceId: "222222222222222222", resourceName: "#general", resourceType: "discord_channel" });
	d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ releaseNotes: { enabled: true, channels: [slackGrantId], requiredWorkflows: GATE } })}' WHERE id = 'inst-1'`);
	const act = (id: string): EngineActReport => ({ id, kind: "push.trunk", command: "git push origin main", target: "origin main", irreversible: true, ok: true, at: "2026-10-19T10:05:00Z", atReliable: true, pushedFromSha: BASE.slice(0, 7), pushedSha: HEAD.slice(0, 7) });
	await recordEngineActs(env, { userId: "u1", instanceId: "inst-1", sessionId: "sess-1", traceId: "run-1" }, [act("p1")]);
	const queued = await postReleaseNotes({ env, userId: "u1", instanceId: "inst-1", runId: "run-1", sessionId: "sess-1", repoId: "repo-1", repoLabel: "chessclubs", runStartedAt: Date.parse("2026-10-19T10:00:00Z") }, { now: () => Date.parse("2026-10-19T11:00:00Z"), githubGet: async () => null, deliver: async (channel, text) => { delivered.push({ channel, text }); return { ok: true }; } });
	expect(queued.status).toBe("queued");
	expect(delivered).toEqual([]); // the run end posts nothing: the queue tick proves the release first
});
afterEach(() => d1.close());

describe("a gated production release, push to channel (#1345)", () => {
	it("CI, E2E (full) and Deploy to R2 on one SHA post ONE verified note to the selected Slack channel only, and a replay posts nothing more", async () => {
		await runReleaseNoteQueue(env, deps());
		await runReleaseNoteQueue(env, deps());
		await runReleaseNoteQueue(env, deps());
		expect(delivered).toHaveLength(1);
		expect(delivered[0].channel).toMatchObject({ provider: "slack" });
		expect(delivered[0].text).toContain(`Commit: ${HEAD}`);
		expect(delivered[0].text).toContain("Club ladders");
		expect(delivered[0].text).toContain("/actions/runs/3/job/900");
		expect(await queueRow()).toMatchObject({ status: "sent", sha: HEAD });
	});

	it.each([
		["E2E (full) has not run", () => { runs = [wf(0), wf(2)]; }],
		["E2E (full) is still running", () => { runs = [wf(0), wf(1, { status: "in_progress", conclusion: null }), wf(2)]; }],
		["E2E (full) failed", () => { runs = [wf(0), wf(1, { conclusion: "failure" }), wf(2)]; }],
		["Deploy to R2 was skipped", () => { runs = [wf(0), wf(1), wf(2, { conclusion: "skipped" })]; }],
		["every workflow is green but on another SHA", () => { runs = GATE.map((_g, i) => wf(i, { head_sha: OTHER })); }],
		["the deploy workflow is green but its job is not the deploy", () => { jobs = [{ ...job, name: "build" }]; }],
		["the deploy step was skipped", () => { jobs = [{ ...job, steps: [{ name: "Deploy to R2", number: 3, status: "completed", conclusion: "skipped" }] }]; }],
		["the deploy job is listed twice", () => { jobs = [job, { ...job, id: 901 }]; }],
	])("posts nothing when %s", async (_name, arrange) => {
		arrange();
		await runReleaseNoteQueue(env, deps());
		expect(delivered).toEqual([]);
		expect(await queueRow()).toMatchObject({ status: "pending" });
	});

	it("evidence that arrives later releases the held note once, and only then", async () => {
		runs = [wf(0), wf(2)];
		await runReleaseNoteQueue(env, deps());
		expect(delivered).toEqual([]);
		runs = [wf(0), wf(1), wf(2)];
		await runReleaseNoteQueue(env, deps());
		await runReleaseNoteQueue(env, deps());
		expect(delivered).toHaveLength(1);
	});

	it("a gate without the deploy job and step is held as configuration_required and never posts, even with every workflow green", async () => {
		d1.exec("DELETE FROM release_note_queue");
		d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ releaseNotes: { enabled: true, channels: [slackGrantId], requiredWorkflows: GATE.map(({ path, role }) => ({ path, role })) } })}' WHERE id = 'inst-1'`);
		await postReleaseNotes({ env, userId: "u1", instanceId: "inst-1", runId: "run-1", sessionId: "sess-1", repoId: "repo-1", repoLabel: "chessclubs", runStartedAt: Date.parse("2026-10-19T10:00:00Z") }, { now: () => Date.parse("2026-10-19T11:00:00Z"), githubGet: async () => null, deliver: async () => ({ ok: true }) });
		await runReleaseNoteQueue(env, deps());
		expect(delivered).toEqual([]);
		expect(await queueRow()).toMatchObject({ status: "configuration_required" });
	});
});
