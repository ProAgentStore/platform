/**
 * One unit of work, started once (#1253): the idempotency check and the atomic repo lock, on the real schema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const issueState = { state: "open" };
const posted: Array<{ number: number; body: string }> = [];
vi.mock("./github-issues.js", async () => {
	const actual = await vi.importActual<typeof import("./github-issues.js")>("./github-issues.js");
	return {
		...actual,
		readIssue: async (_e: unknown, _u: string, _r: string, number: number) => ({ number, state: issueState.state, url: `https://github.com/o/r/issues/${number}` }),
		postIssueComment: async (_e: unknown, _u: string, _r: string, number: number, body: string) => {
			posted.push({ number, body });
			return true;
		},
	};
});

const { checkStartIdempotency } = await import("./start-idempotency.js");
const { createLoopRun } = await import("./agent-loop-store.js");

let d1: RealSchemaD1;
let env: Env;
const repo = (id: string) => ({ id, githubRepo: "o/r" });
const NOW = 1_000_000_000_000;

/** A run on a session of `repoId`, optionally linked to issue #`issue` through a ticket, as `linkRunToIssue` does. */
function run(runId: string, repoId: string, o: { status?: string; stop?: string | null; issue?: number; finished?: number; objective?: string; cancel?: number } = {}) {
	d1.exec(`INSERT OR IGNORE INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s-${runId}', 'i1', '${repoId}', 'u1')`);
	let ticket = "NULL";
	if (o.issue != null) {
		ticket = `'t-${repoId}-${o.issue}'`;
		d1.exec(`INSERT OR IGNORE INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number) VALUES (${ticket}, 'i1', 'u1', 'issue:${repoId}#${o.issue}', 'T', 'human', '${repoId}', ${o.issue})`);
	}
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id, ticket_id, cancel_requested)
	  VALUES ('${runId}', 'u1', 'i1', '${o.objective ?? "work"}', '${o.status ?? "running"}', ${o.stop ? `'${o.stop}'` : "NULL"}, 10, 1, ${o.finished ?? "NULL"}, 's-${runId}', ${ticket}, ${o.cancel ?? 0})`);
}
const check = (r: string, objective: string, extra: Record<string, unknown> = {}) => checkStartIdempotency(env, { userId: "u1", instanceId: "i1", repo: repo(r), objective, now: NOW, ...extra });

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'a'), ('r2', 'i1', 'u1', 'b')`);
	env = { DB: d1.DB } as unknown as Env;
	issueState.state = "open";
	posted.length = 0;
});
afterEach(() => d1.close());

describe("a start for work already in flight (#1253)", () => {
	it("is refused as a duplicate of the running run — the explicit issue decides, whatever the text says", async () => {
		run("run-1", "r1", { issue: 360 });
		const refused = await check("r1", "Context mentions #7 first. Please fix it.", { issue: 360 });
		expect(refused).toMatchObject({ reason: "duplicate", detail: { duplicate_of: "run-1", issue: 360, repoId: "r1" } });
		// Text-only: the same issue by a different phrasing is the same work (an objective naming it, no param).
		expect(await check("r1", "Work issue #360")).toMatchObject({ reason: "duplicate" });
	});

	it("the same number in ANOTHER repo is a different issue", async () => {
		run("run-1", "r1", { issue: 360 });
		expect(await check("r2", "Work issue #360", { issue: 360 })).toBeNull();
	});

	it("an explicit issue wins over the text: #7 in the text does not match a run on #360 (and 360 does)", async () => {
		run("run-1", "r1", { issue: 360 });
		expect(await check("r1", "Fix the thing, see #360 for background", { issue: 7 })).toBeNull();
	});

	it("a run being cancelled does not absorb the start", async () => {
		run("run-1", "r1", { issue: 360, cancel: 1 });
		expect(await check("r1", "x", { issue: 360 })).toBeNull();
	});

	it("`force` never overrides a run in flight", async () => {
		run("run-1", "r1", { issue: 360 });
		expect(await check("r1", "x", { issue: 360, force: true, forceReason: "because" })).toMatchObject({ reason: "duplicate" });
	});

	it("an objective naming no issue, and no explicit one, is not keyed at all", async () => {
		run("run-1", "r1", { issue: 360 });
		expect(await check("r1", "tidy the README")).toBeNull();
	});
});

describe("closed and recently-done work (#1253)", () => {
	it("a closed issue is refused without force, naming the run that finished it", async () => {
		issueState.state = "closed";
		run("run-1", "r1", { status: "completed", stop: "done", issue: 5, finished: NOW - 3_600_000 });
		expect(await check("r1", "x", { issue: 5 })).toMatchObject({ reason: "issue_closed", detail: { issue: 5, run_id: "run-1" } });
	});

	it("a closed issue with no prior run is still refused", async () => {
		issueState.state = "closed";
		expect(await check("r1", "x", { issue: 6 })).toMatchObject({ reason: "issue_closed" });
	});

	it("a run that ended done within the window is refused without force, with its id and time", async () => {
		run("run-1", "r1", { status: "completed", stop: "done", issue: 5, finished: NOW - 86_400_000 });
		expect(await check("r1", "x", { issue: 5 })).toMatchObject({ reason: "already_done", detail: { run_id: "run-1", finished_at: NOW - 86_400_000 } });
	});

	it("a run that ended done longer ago than the window, or that did not finish done, does not block", async () => {
		run("run-old", "r1", { status: "completed", stop: "done", issue: 5, finished: NOW - 30 * 86_400_000 });
		run("run-failed", "r1", { status: "failed", stop: "stuck", issue: 8, finished: NOW - 1000 });
		expect(await check("r1", "x", { issue: 5 })).toBeNull();
		expect(await check("r1", "x", { issue: 8 })).toBeNull();
	});

	it("force WITH a reason starts it and records the reason on the issue; force without one does not", async () => {
		issueState.state = "closed";
		run("run-1", "r1", { status: "completed", stop: "done", issue: 5, finished: NOW - 1000 });
		expect(await check("r1", "x", { issue: 5, force: true })).toMatchObject({ reason: "issue_closed" });
		expect(await check("r1", "x", { issue: 5, force: true, forceReason: "  " })).toMatchObject({ reason: "issue_closed" });
		expect(posted).toEqual([]);
		expect(await check("r1", "x", { issue: 5, force: true, forceReason: "regression found in prod" })).toBeNull();
		expect(posted).toEqual([{ number: 5, body: expect.stringContaining("regression found in prod") }]);
	});
});

describe("the repo lock is one statement (#1253)", () => {
	const create = (runId: string, repoId: string, sessionId: string) =>
		createLoopRun(env, { runId, userId: "u1", instanceId: "i1", objective: "w", maxIterations: 10, startedAt: 1, sessionId, exclusiveRepoId: repoId });

	it("concurrent starts on one repo: exactly one run is created, the rest are told no", async () => {
		// Five sessions of the same repo (one active, four retained) — runs on different sessions of one checkout.
		for (let i = 0; i < 5; i++) d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES ('s${i}', 'i1', 'r1', 'u1', '${i === 0 ? "active" : "ended"}')`);
		const results = await Promise.all([0, 1, 2, 3, 4].map((i) => create(`race-${i}`, "r1", `s${i}`)));
		expect(results.filter(Boolean)).toHaveLength(1);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_loop_runs WHERE status = 'running'").get() as { n: number }).n).toBe(1);
	});

	it("a run parked on a question that released the checkout does not hold it; another repo is independent", async () => {
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES ('sa', 'i1', 'r1', 'u1', 'active'), ('sb', 'i1', 'r1', 'u1', 'ended'), ('sc', 'i1', 'r2', 'u1', 'active')`);
		expect(await create("first", "r1", "sa")).toBe(true);
		expect(await create("blocked", "r1", "sb")).toBe(false);
		expect(await create("other-repo", "r2", "sc")).toBe(true);
		d1.exec(`UPDATE agent_loop_runs SET checkout_released_at = 5 WHERE run_id = 'first'`);
		expect(await create("after-release", "r1", "sb")).toBe(true);
	});
});
