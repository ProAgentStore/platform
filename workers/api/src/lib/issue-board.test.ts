/**
 * #895 over the real schema: issues become cards, runs link to them, the sync keeps them current, and
 * the board says where each one stands. Only GitHub is faked (`listIssuesForSync`, `readIssue`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueSyncRecord } from "./github-issues.js";

const gh = vi.hoisted(() => ({
	pages: new Map<string, { issues: IssueSyncRecord[]; hasMore: boolean; unreadable: boolean }>(),
	calls: [] as Array<{ repo: string; state: string; since?: string | null }>,
}));
vi.mock("./github-issues.js", async (orig) => ({
	...(await orig<typeof import("./github-issues.js")>()),
	listIssuesForSync: async (_env: unknown, _uid: string, repo: string, opts: { state: string; since?: string | null }) => {
		gh.calls.push({ repo, state: opts.state, since: opts.since });
		return gh.pages.get(repo) ?? { issues: [], hasMore: false, unreadable: false };
	},
	readIssue: async (_env: unknown, _uid: string, repo: string, n: number) => ({ number: n, title: `Read ${n}`, state: "open", labels: [], comments: 0, updatedAt: "2026-10-07T00:00:00Z", url: `https://github.com/${repo}/issues/${n}`, body: "Make it faster.\n\nDetails." }),
}));

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { syncRepoIssues } from "./issue-sync.js";
import { linkRunToIssue, issueJobKey } from "./issue-tickets.js";
import { buildInstanceBoard, linkBoardItemGithubIssue, refreshBoardGithubIssues } from "./board.js";
import { recordIssueClosures } from "./commit-close-watch.js";
import type { Env } from "../types.js";

const issue = (n: number, over: Partial<IssueSyncRecord> = {}): IssueSyncRecord => ({
	number: n,
	title: `Issue ${n}`,
	state: "open",
	stateReason: null,
	labels: [],
	assignees: [],
	url: `https://github.com/o/app/issues/${n}`,
	updatedAt: `2026-10-0${Math.min(n, 9)}T00:00:00Z`,
	closedAt: null,
	summary: `What ${n} asks`,
	...over,
});

let d1: RealSchemaD1;
let env: Env;
const repoRow = () => d1.sqlite.prepare("SELECT id, instance_id, user_id, github_repo, issues_synced_since FROM coding_repos WHERE id = 'r1'").get() as { id: string; instance_id: string; user_id: string; github_repo: string; issues_synced_since: string | null };
const tickets = () => d1.sqlite.prepare("SELECT job_key, repo_id, issue_number, linked_by, pickup_authority, issue_cache FROM tickets ORDER BY issue_number").all() as Array<{ job_key: string; repo_id: string; issue_number: number; linked_by: string; pickup_authority: string; issue_cache: string }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'i1', 'u1', 'app', 'o/app'), ('r2', 'i1', 'u1', 'web', 'o/web')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s1', 'i1', 'r1', 'u1')`);
	env = { DB: d1.DB } as unknown as Env;
	gh.pages.clear();
	gh.calls.length = 0;
});
afterEach(() => d1.close());

describe("the issue sync (#895)", () => {
	it("seeds a repo's OPEN issues as backlog tickets the queue may not pick up by itself", async () => {
		gh.pages.set("o/app", { issues: [issue(3), issue(5, { labels: ["P1"] })], hasMore: false, unreadable: false });
		const r = await syncRepoIssues(env, repoRow(), 1_000);
		expect(gh.calls[0]).toEqual({ repo: "o/app", state: "open", since: null });
		expect(r).toMatchObject({ created: 2, updated: 0, unreadable: false });
		expect(tickets()).toMatchObject([
			{ job_key: issueJobKey("r1", 3), issue_number: 3, linked_by: "sync", pickup_authority: "human" },
			{ job_key: issueJobKey("r1", 5), issue_number: 5, linked_by: "sync", pickup_authority: "human" },
		]);
		expect(repoRow().issues_synced_since).toBe("2026-10-05T00:00:00Z");
	});

	it("later syncs ask for what changed since, refresh known issues, and never import a closed stranger", async () => {
		gh.pages.set("o/app", { issues: [issue(3)], hasMore: false, unreadable: false });
		await syncRepoIssues(env, repoRow(), 1_000);
		gh.pages.set("o/app", { issues: [issue(3, { state: "closed", closedAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", stateReason: "completed" }), issue(4, { state: "closed" })], hasMore: false, unreadable: false });
		const r = await syncRepoIssues(env, repoRow(), 2_000);
		expect(gh.calls[1]).toEqual({ repo: "o/app", state: "all", since: "2026-10-03T00:00:00Z" });
		expect(r).toMatchObject({ created: 0, updated: 1 });
		expect(tickets()).toHaveLength(1);
		expect(JSON.parse(tickets()[0].issue_cache)).toMatchObject({ state: "closed", stateReason: "completed", closedAt: "2026-10-08T00:00:00Z", repo: "o/app" });
		expect(repoRow().issues_synced_since).toBe("2026-10-08T00:00:00Z");
	});

	it("an unreadable repo keeps its watermark — unreadable is not 'nothing changed'", async () => {
		d1.exec(`UPDATE coding_repos SET issues_synced_since = '2026-10-01T00:00:00Z' WHERE id = 'r1'`);
		gh.pages.set("o/app", { issues: [], hasMore: false, unreadable: true });
		expect((await syncRepoIssues(env, repoRow(), 5_000)).unreadable).toBe(true);
		expect(repoRow().issues_synced_since).toBe("2026-10-01T00:00:00Z");
		expect((d1.sqlite.prepare("SELECT issues_synced_at FROM coding_repos WHERE id = 'r1'").get() as { issues_synced_at: number }).issues_synced_at).toBe(5_000);
	});
});

describe("linking a run to its issue (#895)", () => {
	const run = (id: string, objective: string) => d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('${id}', 'u1', 'i1', '${objective}', 'running', 10, ${Date.now()}, 's1')`);
	const link = (runId: string, objective: string, issueNo?: number) => linkRunToIssue(env, { instanceId: "i1", userId: "u1", runId, sessionId: "s1", repoId: "r1", githubRepo: "o/app", objective, issue: issueNo });

	it("an explicit issue wins; the run, its ticket and its session all name it", async () => {
		run("run1", "Make the app faster");
		expect(await link("run1", "Make the app faster", 7)).toMatchObject({ issueNumber: 7, linkedBy: "explicit" });
		expect(d1.sqlite.prepare("SELECT ticket_id FROM agent_loop_runs WHERE run_id = 'run1'").get()).toEqual({ ticket_id: expect.stringMatching(/^tkt_/) });
		expect(d1.sqlite.prepare("SELECT issue_number, issue_title FROM coding_sessions WHERE id = 's1'").get()).toEqual({ issue_number: 7, issue_title: "Read 7" });
		expect(tickets()[0]).toMatchObject({ job_key: issueJobKey("r1", 7), linked_by: "explicit" });
	});

	it("else the objective's subject, recorded as a guess; a reference to another repo, or none, links nothing", async () => {
		run("run2", "Fix issue #12: slow startup");
		expect(await link("run2", "Fix issue #12: slow startup")).toMatchObject({ issueNumber: 12, linkedBy: "objective" });
		run("run3", "Port the fix from o/web#12");
		expect(await link("run3", "Port the fix from o/web#12")).toBeNull();
		run("run4", "Tidy the README");
		expect(await link("run4", "Tidy the README")).toBeNull();
	});

	it("a run on an issue the sync already found reuses its card, and a weaker link never downgrades a stronger one", async () => {
		gh.pages.set("o/app", { issues: [issue(12)], hasMore: false, unreadable: false });
		await syncRepoIssues(env, repoRow(), 1_000);
		run("run5", "Fix issue #12");
		await link("run5", "Fix issue #12");
		expect(tickets()).toHaveLength(1);
		expect(tickets()[0].linked_by).toBe("objective");
		await syncRepoIssues(env, repoRow(), 2_000);
		expect(tickets()[0].linked_by).toBe("objective");
	});
});

describe("the board shows each issue where it stands (#895)", () => {
	it("backlog, parked, running, waiting, done with its closing commit — and the coding card names its issue", async () => {
		gh.pages.set("o/app", {
			issues: [issue(1), issue(2, { labels: ["needs-human"] }), issue(3, { labels: ["P0"] }), issue(4), issue(5)],
			hasMore: false,
			unreadable: false,
		});
		await syncRepoIssues(env, repoRow(), 1_000);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES
		  ('ra', 'u1', 'i1', 'Fix issue #3', 'running', 10, 100, 's1'),
		  ('rb', 'u1', 'i1', 'Fix issue #4', 'running', 10, 50, NULL)`);
		await linkRunToIssue(env, { instanceId: "i1", userId: "u1", runId: "ra", sessionId: "s1", repoId: "r1", githubRepo: "o/app", objective: "Fix issue #3" });
		await linkRunToIssue(env, { instanceId: "i1", userId: "u1", runId: "rb", sessionId: "s1", repoId: "r1", githubRepo: "o/app", objective: "Fix issue #4" });
		d1.exec(`UPDATE agent_loop_runs SET waiting_reason = 'decision' WHERE run_id = 'rb'`);
		gh.pages.set("o/app", { issues: [issue(5, { state: "closed", updatedAt: "2026-10-09T00:00:00Z" })], hasMore: false, unreadable: false });
		await syncRepoIssues(env, repoRow(), 2_000);
		await recordIssueClosures(env, { id: "r1", github_repo: "o/app" }, [{ sha: "abc123", message: "perf: cache\n\nCloses #5", committedAt: "2026-10-09T00:00:00Z" }]);
		d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES ('csess-s1', 'i1', 'u1', 'coding.session', 'running', '{"id":"csess-s1","type":"coding.session","status":"running","title":"Coding: app"}', datetime('now'), datetime('now'))`);

		const board = await buildInstanceBoard(env, "i1", "u1");
		const card = (n: number) => board.items.find((i) => i.githubIssue?.number === n && i.ticketId);
		expect(card(1)).toMatchObject({ lane: "backlog", status: "queued", githubIssue: { repo: "o/app", summary: "What 1 asks" } });
		expect(card(2)).toMatchObject({ lane: "parked", status: "blocked" });
		expect(card(3)).toMatchObject({ lane: "running", status: "running", priority: 0, issueRun: { runId: "ra", sessionId: "s1" } });
		expect(card(4)).toMatchObject({ lane: "waiting_on_human", status: "needs_human", issueRun: { runId: "rb", waitingReason: "decision" } });
		expect(card(5)).toMatchObject({ lane: "done", status: "completed", closingCommit: { sha: "abc123", url: "https://github.com/o/app/commit/abc123" } });
		// The session's card shows what it is working ON — its newest linked run's issue — and stays in its own lane.
		expect(board.items.find((i) => i.codingSessionId === "s1")).toMatchObject({ lane: "running", githubIssue: { number: 3 } });
	});

	it("filters to one repo", async () => {
		gh.pages.set("o/app", { issues: [issue(1)], hasMore: false, unreadable: false });
		gh.pages.set("o/web", { issues: [issue(2, { url: "https://github.com/o/web/issues/2" })], hasMore: false, unreadable: false });
		await syncRepoIssues(env, repoRow(), 1_000);
		await syncRepoIssues(env, { ...repoRow(), id: "r2", github_repo: "o/web", issues_synced_since: null }, 1_000);
		expect((await buildInstanceBoard(env, "i1", "u1")).items).toHaveLength(2);
		expect((await buildInstanceBoard(env, "i1", "u1", { repo: "O/Web" })).items.map((i) => i.githubIssue?.number)).toEqual([2]);
	});
});

describe("the #682 card link now keeps its repo", () => {
	it("stores the repo with the link, and refreshes each card from its own repo", async () => {
		const linked = await linkBoardItemGithubIssue(env, "i1", "u1", "job-1", { repo: "o/web", issueNumber: 9 });
		expect(linked).toMatchObject({ ok: true, issue: { number: 9, repo: "o/web" } });
		expect(d1.sqlite.prepare("SELECT github_repo FROM board_items WHERE job_key = 'job-1'").get()).toEqual({ github_repo: "o/web" });
		expect(await refreshBoardGithubIssues(env, "i1", "u1", "")).toEqual({ refreshed: 1, skipped: 0 });
		await linkBoardItemGithubIssue(env, "i1", "u1", "job-1", null);
		expect(d1.sqlite.prepare("SELECT github_repo, github_issue_number FROM board_items WHERE job_key = 'job-1'").get()).toEqual({ github_repo: null, github_issue_number: null });
	});
});
