/**
 * #1334 — auto-pickup must not queue work the start guard will refuse, must not spend the run allowance on
 * attempts, and must not report "started" for an entry the drain refused. Real schema; GitHub and the queue kick are the fakes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitAutoPickup, AUTO_PICKUP_ATTEMPT_FACTOR } from "./auto-pickup-admission.js";
import { type AutoPickupDeps, runAutoPickup, setAutoPickup, settleStart } from "./auto-pickup.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { IssueSummary } from "./github-issues.js";
import type { Env } from "../types.js";

const issue = (number: number, labels: string[] = []): IssueSummary => ({ number, title: `issue ${number}`, state: "open", labels, assignees: [], comments: 0, updatedAt: "", url: `u/${number}` });
const NOW = 1_800_000_000_000;

let d1: RealSchemaD1;
let env: Env;
let open: IssueSummary[];
let kicked: string[];
const deps = (drain: unknown = { drained: true, started: true, runId: "r", driver: "d" }): AutoPickupDeps => ({
	listOpenIssues: async () => ({ issues: open, unreadable: false }),
	postComment: async () => true,
	notify: async () => undefined,
	startQueued: async (repoId) => {
		kicked.push(repoId);
		return drain;
	},
});
const queueRows = () => d1.sqlite.prepare("SELECT id, status, run_id FROM instance_objective_queue").all() as Array<{ id: string; status: string; run_id: string | null }>;
const logRows = (outcome = "started") => d1.sqlite.prepare("SELECT * FROM auto_pickup_log WHERE outcome = ?1").all(outcome) as Array<Record<string, unknown>>;

/** A finished run on issue #n of repo r1, as `linkRunToIssue` leaves it. */
function doneRun(n: number, finishedAt: number, stop = "done") {
	d1.exec(`INSERT OR IGNORE INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s-${n}', 'coder', 'r1', 'u1')`);
	d1.exec(`INSERT OR IGNORE INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number) VALUES ('t-${n}', 'coder', 'u1', 'issue:r1#${n}', 'T', 'human', 'r1', ${n})`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id, ticket_id)
	  VALUES ('done-${n}', 'u1', 'coder', 'Implement GitHub issue #${n}', 'completed', '${stop}', 10, 1, ${finishedAt}, 's-${n}', 't-${n}')`);
}

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', 'acme/app')`);
	env = { DB: d1.DB } as unknown as Env;
	open = [];
	kicked = [];
	await setAutoPickup(env, "coder", "u1", { enabled: true });
});
afterEach(() => d1.close());

describe("recently done work is passed over BEFORE it is queued (#1334)", () => {
	it("an open epic whose run finished done two days ago is never queued, and the next candidate starts", async () => {
		open = [issue(3, ["P1"]), issue(8)];
		doneRun(3, NOW - 2 * 86_400_000);
		const r = await runAutoPickup(env, "coder", "u1", deps(), NOW);
		expect(r).toMatchObject({ started: true, issue: 8 });
		expect(queueRows()).toHaveLength(1); // only #8 was ever queued
		expect(String(logRows()[0].detail)).toContain("passed over #3 (already_done)");
	});

	it("repeated wakes with only a recently-done issue open queue nothing and spend nothing, however many times they run", async () => {
		open = [issue(3, ["P1"])];
		doneRun(3, NOW - 86_400_000);
		for (let i = 0; i < 25; i++) {
			const r = await runAutoPickup(env, "coder", "u1", deps(), NOW + i * 1000);
			expect(r).toMatchObject({ started: false });
		}
		expect(queueRows()).toEqual([]);
		expect(logRows("started")).toEqual([]);
		expect(String(logRows("none_eligible")[0].detail)).toContain("#3 (already_done)");
	});

	it("the seven-day window is not weakened: a run that finished eight days ago does not block the issue", async () => {
		open = [issue(3)];
		doneRun(3, NOW - 8 * 86_400_000);
		expect(await runAutoPickup(env, "coder", "u1", deps(), NOW)).toMatchObject({ started: true, issue: 3 });
	});

	it("a closed issue (cached GitHub state) is passed over too", async () => {
		open = [issue(5), issue(6)];
		const cache = JSON.stringify({ number: 5, repo: "acme/app", title: "T", state: "closed", stateReason: null, labels: [], assignees: [], url: "u", updatedAt: "", closedAt: null, summary: "" });
		d1.exec(`INSERT INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number, issue_cache) VALUES ('t-5', 'coder', 'u1', 'issue:r1#5', 'T', 'human', 'r1', 5, '${cache}')`);
		expect(await runAutoPickup(env, "coder", "u1", deps(), NOW)).toMatchObject({ started: true, issue: 6 });
	});
});

describe("the run allowance counts runs, not attempts (#1334)", () => {
	const seedAttempt = (id: string, status: string, runId: string | null, at: number) => {
		d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, metadata, status, created_at, run_id) VALUES ('${id}', 'coder', 'r1', 'u1', 'Implement GitHub issue #3', '{}', '${status}', ${at}, ${runId ? `'${runId}'` : "NULL"})`);
		d1.exec(`INSERT INTO auto_pickup_log (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at, entry_id) VALUES ('${id}', 'coder', 'u1', 'acme/app', 3, 'started', 'x', ${at}, '${id}')`);
	};

	it("98 entries refused before any run existed leave the allowance of 100 untouched: a real issue still starts", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 100 });
		for (let i = 0; i < 98; i++) seedAttempt(`rej-${i}`, "failed", null, NOW - 3600_000 + i);
		open = [issue(9)];
		expect(await runAutoPickup(env, "coder", "u1", deps(), NOW)).toMatchObject({ started: true, issue: 9 });
	});

	it("entries that did become runs still count against the cap", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 2 });
		seedAttempt("ran-1", "started", "run-1", NOW - 5000);
		seedAttempt("ran-2", "started", "run-2", NOW - 4000);
		open = [issue(9)];
		expect(await runAutoPickup(env, "coder", "u1", deps(), NOW)).toEqual({ started: false, reason: "the daily cap of 2 auto-picked run(s) is reached" });
	});

	it("one entry short of the cap still starts; attempts have their own wider ceiling that pauses an endless loop", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 2 });
		seedAttempt("ran-1", "started", "run-1", NOW - 5000);
		open = [issue(9)];
		expect(await runAutoPickup(env, "coder", "u1", deps(), NOW)).toMatchObject({ started: true });
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled' WHERE status = 'pending'");
		d1.exec("DELETE FROM instance_objective_queue; DELETE FROM auto_pickup_log; DELETE FROM auto_pickup_admissions");
		for (let i = 0; i < 2 * AUTO_PICKUP_ATTEMPT_FACTOR; i++) seedAttempt(`rej-${i}`, "failed", null, NOW - 3600_000 + i);
		const r = await runAutoPickup(env, "coder", "u1", deps(), NOW);
		expect(r).toMatchObject({ started: false, reason: expect.stringContaining("attempts in 24h") });
	});

	it("the atomic admission enforces the same two rules at the database, not only in the picker", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
		for (let i = 0; i < 2; i++) seedAttempt(`rej-${i}`, "failed", null, NOW - 1000 + i); // not runs: allowance free
		const base = { instanceId: "coder", userId: "u1", repoId: "r1", repo: "acme/app", issue: 9, objective: "o", maxIterations: 5, detail: "d", now: NOW, observedAdmission: 0 };
		expect(await admitAutoPickup(env, { ...base, entryId: "objq-a" })).toBe(true);
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled' WHERE id = 'objq-a'"); // pending/running would block anyway
		expect(await admitAutoPickup(env, { ...base, entryId: "objq-b", issue: 10 })).toBe(false); // the first is a started run: cap 1 reached
	});
});

describe("'started' means the drain made a run (#1334)", () => {
	it("a drain that refused the entry is reported as not started, with its reason", async () => {
		open = [issue(9)];
		const r = await runAutoPickup(env, "coder", "u1", deps({ drained: true, entryId: "e", started: false, requeued: false, error: "no checkout" }), NOW);
		expect(r).toEqual({ started: false, reason: "#9 was queued but was refused: no checkout" });
	});
	it("a drain that kept the entry waiting says so", () => {
		expect(settleStart({ drained: true, entryId: "e", started: false, requeued: true, error: "runner offline" }, { repo: "a/b", issue: 4, entryId: "e" })).toEqual({ started: false, reason: "#4 was queued but is waiting to start: runner offline" });
	});
	it("nothing drained (paused, held) is not a start", () => {
		expect(settleStart({ drained: false, held: "credit hold" }, { repo: "a/b", issue: 4, entryId: "e" })).toEqual({ started: false, reason: "#4 was queued; nothing started yet (credit hold)" });
	});
	it("only a real start is a start", async () => {
		open = [issue(9)];
		expect(await runAutoPickup(env, "coder", "u1", deps({ drained: true, entryId: "e", started: true, runId: "run-1", driver: "d" }), NOW)).toMatchObject({ started: true, issue: 9 });
	});
});

describe("concurrency and duplicate delivery keep their guarantees (#1315, #1334)", () => {
	it("simultaneous wakes over a recently-done head still queue the next issue exactly once", async () => {
		open = [issue(3), issue(8)];
		doneRun(3, NOW - 86_400_000);
		const results = await Promise.all(Array.from({ length: 6 }, () => runAutoPickup(env, "coder", "u1", deps(), NOW)));
		expect(queueRows()).toHaveLength(1);
		expect(results.filter((r) => r.started && "issue" in r && r.issue === 8).length).toBeGreaterThanOrEqual(1);
		expect(logRows("started")).toHaveLength(1);
	});

	it("a duplicate delivery of the same wake after the entry is pending recovers that entry, not a second one", async () => {
		open = [issue(8)];
		await runAutoPickup(env, "coder", "u1", deps({ drained: false }), NOW); // enqueued; the drain did nothing
		const again = await runAutoPickup(env, "coder", "u1", deps(), NOW + 1000);
		expect(queueRows()).toHaveLength(1);
		expect(again).toMatchObject({ started: true, issue: 8 });
	});

	it("a guarded owner retry (force with a reason) is not something auto-pickup ever does: a recently-done issue stays refused on every wake", async () => {
		open = [issue(3)];
		doneRun(3, NOW - 3600_000);
		await runAutoPickup(env, "coder", "u1", deps(), NOW);
		await runAutoPickup(env, "coder", "u1", deps(), NOW + 60_000);
		expect(queueRows()).toEqual([]);
	});
});
