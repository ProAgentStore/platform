/**
 * #1336 — the per-issue attempt counter and hard stop, on the real schema: threshold 4/5/6, replays, concurrent writers,
 * cross-instance keys, owner isolation, release and success resets, every start path refusing, and no flood.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AutoPickupDeps, autoPickupPatchProblem, runAutoPickup, setAutoPickup } from "./auto-pickup.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { IssueSummary } from "./github-issues.js";
import { recordDrainRefusal, recordRunForIssue } from "./issue-attempt-hooks.js";
import { isGuardRefusal, issueQuarantine, listIssueQuarantines, recordIssueAttempt, recordIssueSuccess, releaseIssueQuarantine } from "./issue-attempts.js";
import { checkStartIdempotency, quarantineRefusal } from "./start-idempotency.js";
import type { Env } from "../types.js";

const NOW = 1_800_000_000_000;
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder", "coder2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["other"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', 'acme/app'), ('r1b', 'coder2', 'u1', 'app', 'Acme/App'), ('r9', 'other', 'u2', 'app', 'acme/app')`);
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const attempt = (n: number, o: Partial<Parameters<typeof recordIssueAttempt>[1]> = {}) =>
	recordIssueAttempt(env, { userId: "u1", instanceId: "coder", githubRepo: "acme/app", issue: 7, attemptKey: `run:r${n}`, kind: "run_unsuccessful", reason: "run ended failed", runId: `r${n}`, now: NOW + n, ...o });
const count = () => (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM issue_attempts").get() as { n: number }).n;

describe("the threshold is exact (#1336)", () => {
	it("4 attempts do not stop the issue, the 5th does, and the 6th does not open a second incident", async () => {
		for (let n = 1; n <= 4; n++) expect(await attempt(n)).toMatchObject({ recorded: true, count: n, threshold: 5, quarantine: "none" });
		expect(await issueQuarantine(env, "u1", "acme/app", 7)).toBeNull();
		expect(await attempt(5)).toMatchObject({ recorded: true, count: 5, quarantine: "opened" });
		const q = await issueQuarantine(env, "u1", "acme/app", 7);
		expect(q).toMatchObject({ state: "quarantined", threshold: 5, attemptCount: 5, githubRepo: "acme/app", issue: 7 });
		expect(q?.incidentId).toMatch(/^iq-/);
		expect(await attempt(6)).toMatchObject({ recorded: true, count: 6, quarantine: "none" });
		expect((await issueQuarantine(env, "u1", "acme/app", 7))?.incidentId).toBe(q?.incidentId);
		expect((await issueQuarantine(env, "u1", "acme/app", 7))?.attemptCount).toBe(6);
	});

	it("the threshold is the instance's maxAttemptsPerIssue, validated at the write", async () => {
		await setAutoPickup(env, "coder", "u1", { maxAttemptsPerIssue: 3 });
		await attempt(1);
		await attempt(2);
		expect(await attempt(3)).toMatchObject({ quarantine: "opened", threshold: 3 });
		expect(autoPickupPatchProblem({ maxAttemptsPerIssue: 5 })).toBeNull();
		for (const bad of [0, 51, 5.5, "5", null]) expect(autoPickupPatchProblem({ maxAttemptsPerIssue: bad })).toMatch(/maxAttemptsPerIssue must be a whole number from 1 to 50/);
	});
});

describe("distinct attempts only (#1336)", () => {
	it("a replayed event is not counted twice, and never opens an incident early", async () => {
		for (let i = 0; i < 10; i++) await attempt(1);
		expect(count()).toBe(1);
		expect(await attempt(1)).toEqual({ recorded: false });
	});

	it("simultaneous writers at the boundary open exactly one incident", async () => {
		for (let n = 1; n <= 4; n++) await attempt(n);
		const results = await Promise.all([5, 5, 5, 6, 6, 7].map((n) => attempt(n)));
		expect(results.filter((r) => r.recorded && r.quarantine === "opened")).toHaveLength(1);
		expect(count()).toBe(7);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM issue_quarantine").get()).toEqual({ n: 1 });
	});

	it("a restart between attempts changes nothing: the count is in the database, not in a process", async () => {
		for (let n = 1; n <= 4; n++) await attempt(n);
		const fresh = { DB: d1.DB } as unknown as Env; // a new isolate
		expect(await recordIssueAttempt(fresh, { userId: "u1", instanceId: "coder", githubRepo: "acme/app", issue: 7, attemptKey: "run:r5", kind: "run_unsuccessful", reason: "x", now: NOW })).toMatchObject({ quarantine: "opened" });
	});

	it("deferrals, cancellations, credit and machine stops and guard refusals are not attempts", async () => {
		const run = (id: string, stop: string, status: string) => {
			d1.exec(`INSERT OR IGNORE INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s-${id}', 'coder', 'r1', 'u1')`);
			d1.exec(`INSERT OR IGNORE INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number) VALUES ('t7', 'coder', 'u1', 'issue:r1#7', 'T', 'human', 'r1', 7)`);
			d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id, ticket_id) VALUES ('${id}', 'u1', 'coder', 'Implement GitHub issue #7', '${status}', '${stop}', 5, 1, 2, 's-${id}', 't7')`);
		};
		for (const [i, stop] of ["cancelled", "provider_credit", "engine_auth", "engine_limit", "runner_gone", "decision", "interrupted"].entries()) {
			run(`x${i}`, stop, "needs_human");
			await recordRunForIssue(env, `x${i}`, stop, NOW);
		}
		expect(count()).toBe(0);
		expect(["duplicate", "issue_closed", "already_done", "quarantined"].every((r) => isGuardRefusal(r))).toBe(true);
		expect(isGuardRefusal("no_repo")).toBe(false);
		run("bad", "failed", "failed");
		await recordRunForIssue(env, "bad", "failed", NOW);
		await recordRunForIssue(env, "bad", "failed", NOW); // the finish step retried
		expect(count()).toBe(1);
	});
});

describe("admission failures with no run (#1336)", () => {
	const entry = (id: string, objective = "Implement GitHub issue #7 in acme/app: t") => ({ id, instanceId: "coder", userId: "u1", repoId: "r1", objective, metadata: null });

	it("a structural refusal counts once per queue entry; a start-guard refusal does not count at all", async () => {
		await recordDrainRefusal(env, entry("q1"), null, undefined, "no checkout");
		await recordDrainRefusal(env, entry("q1"), null, undefined, "no checkout"); // duplicate delivery
		await recordDrainRefusal(env, entry("q2"), null, "already_done", "finished recently");
		await recordDrainRefusal(env, entry("q3"), null, "quarantined", "stopped");
		expect(count()).toBe(1);
		expect(d1.sqlite.prepare("SELECT kind, run_id, queue_entry_id FROM issue_attempts").get()).toEqual({ kind: "admission_failed", run_id: null, queue_entry_id: "q1" });
	});

	it("the picker's own metadata names the issue; an objective naming another repository is not this issue", async () => {
		await recordDrainRefusal(env, { ...entry("q4", "work"), metadata: JSON.stringify({ autoPickup: { repo: "acme/app", issue: 7 } }) }, null, undefined, "x");
		await recordDrainRefusal(env, entry("q5", "Implement GitHub issue #7 in other/thing#7"), null, undefined, "x");
		expect(count()).toBe(1);
	});

	it("five of them stop the issue: the loop that burned 98 entries ends at 5", async () => {
		for (let n = 1; n <= 5; n++) await recordDrainRefusal(env, entry(`q${n}`), null, undefined, "no coding CLI");
		expect(await issueQuarantine(env, "u1", "acme/app", 7)).toMatchObject({ attemptCount: 5 });
	});
});

describe("the key is owner + canonical repo + issue (#1336)", () => {
	it("two instances on one repo, in any letter case, share one counter", async () => {
		await attempt(1, { instanceId: "coder", githubRepo: "acme/app" });
		await attempt(2, { instanceId: "coder2", githubRepo: "ACME/App" });
		await attempt(3, { instanceId: "coder", githubRepo: "Acme/app" });
		await attempt(4, { instanceId: "coder2", githubRepo: "acme/APP" });
		expect(await attempt(5, { instanceId: "coder2", githubRepo: "acme/app" })).toMatchObject({ quarantine: "opened", count: 5 });
		expect(await issueQuarantine(env, "u1", "ACME/APP", 7)).not.toBeNull();
	});

	it("another owner's counter, quarantine and release are separate, and another issue is untouched", async () => {
		for (let n = 1; n <= 5; n++) await attempt(n);
		expect(await issueQuarantine(env, "u2", "acme/app", 7)).toBeNull();
		expect(await listIssueQuarantines(env, "u2")).toEqual([]);
		expect(await releaseIssueQuarantine(env, "u2", "acme/app", 7, "not mine")).toBe(false);
		expect(await issueQuarantine(env, "u1", "acme/app", 7)).not.toBeNull();
		expect(await issueQuarantine(env, "u1", "acme/app", 8)).toBeNull();
		expect(await attempt(1, { userId: "u2", instanceId: "other", attemptKey: "run:r1" })).toMatchObject({ recorded: true, count: 1 }); // same key text, another owner
	});
});

describe("how a quarantine ends (#1336)", () => {
	const stop = async () => {
		for (let n = 1; n <= 5; n++) await attempt(n);
	};

	it("it does not expire: any amount of time later it is still stopped", async () => {
		await stop();
		d1.exec("UPDATE issue_attempts SET created_at = 1");
		expect(await quarantineRefusal(env, { userId: "u1", githubRepo: "acme/app", repoId: "r1", issue: 7 })).toMatchObject({ reason: "quarantined" });
	});

	it("an owner release is audited, needs a reason, restarts the count, and a second release is a no-op", async () => {
		await stop();
		await expect(releaseIssueQuarantine(env, "u1", "acme/app", 7, "  ")).rejects.toThrow(/reason/);
		expect(await releaseIssueQuarantine(env, "u1", "acme/app", 7, "fixed the missing secret")).toBe(true);
		expect(await releaseIssueQuarantine(env, "u1", "acme/app", 7, "again")).toBe(false);
		expect(await issueQuarantine(env, "u1", "acme/app", 7)).toBeNull();
		const [released] = await listIssueQuarantines(env, "u1", { includeReleased: true });
		expect(released).toMatchObject({ state: "released", releasedBy: "owner:u1", releaseReason: "fixed the missing secret" });
		const audit = (d1.sqlite.prepare("SELECT event, user_id FROM agent_events WHERE source = 'issue-attempts' ORDER BY ts, rowid").all() as Array<{ event: string; user_id: string }>).map((r) => `${r.event}:${r.user_id}`);
		expect(audit).toEqual(["issue_quarantine.opened:u1", "issue_quarantine.released:u1"]);
		// The count starts again: four more attempts do not stop it, the fifth does, with a NEW incident.
		for (let n = 6; n <= 9; n++) expect(await attempt(n)).toMatchObject({ quarantine: "none", count: n - 5 });
		expect(await attempt(10)).toMatchObject({ quarantine: "opened", count: 5 });
	});

	it("a verified success (a run ended done) restarts the count and lifts the stop", async () => {
		await stop();
		await recordIssueSuccess(env, "u1", "acme/app", 7, "r-done", NOW);
		expect(await issueQuarantine(env, "u1", "acme/app", 7)).toBeNull();
		expect(await attempt(11)).toMatchObject({ count: 1, quarantine: "none" });
	});

	it("a success on an issue that was never stopped also restarts its count", async () => {
		await attempt(1);
		await attempt(2);
		await recordIssueSuccess(env, "u1", "acme/app", 7, "r-done", NOW);
		for (let n = 3; n <= 6; n++) expect(await attempt(n)).toMatchObject({ quarantine: "none" });
		expect(await attempt(7)).toMatchObject({ quarantine: "opened", count: 5 });
	});
});

describe("every path honours the stop, and only this issue stops (#1336)", () => {
	const stop = async () => {
		for (let n = 1; n <= 5; n++) await attempt(n);
	};

	it("the start guard refuses it — force included — and still lets another issue through", async () => {
		await stop();
		const check = (issue: number, extra: Record<string, unknown> = {}) => checkStartIdempotency(env, { userId: "u1", instanceId: "coder2", repo: { id: "r1b", githubRepo: "acme/app" }, objective: `Implement GitHub issue #${issue}`, issue, now: NOW, ...extra });
		expect(await check(7)).toMatchObject({ reason: "quarantined", detail: { attempts: 5, threshold: 5 } });
		expect(await check(7, { force: true, forceReason: "try anyway" })).toMatchObject({ reason: "quarantined" });
		expect(await check(8)).toBeNull();
	});

	it("the picker passes over it and starts the next eligible issue, queueing nothing for the stopped one", async () => {
		await stop();
		await setAutoPickup(env, "coder", "u1", { enabled: true });
		const open: IssueSummary[] = [7, 8].map((number) => ({ number, title: `issue ${number}`, state: "open", labels: number === 7 ? ["P0"] : [], assignees: [], comments: 0, updatedAt: "", url: `u/${number}` }));
		const deps: AutoPickupDeps = { listOpenIssues: async () => ({ issues: open, unreadable: false }), postComment: async () => true, notify: async () => undefined, startQueued: async () => ({ drained: true, started: true, runId: "r", driver: "d" }) };
		expect(await runAutoPickup(env, "coder", "u1", deps, NOW)).toMatchObject({ started: true, issue: 8 });
		const queued = d1.sqlite.prepare("SELECT metadata FROM instance_objective_queue").all() as Array<{ metadata: string }>;
		expect(queued.map((q) => JSON.parse(q.metadata).autoPickup.issue)).toEqual([8]);
	});

	it("repeated wakes with only the stopped issue open queue nothing, count nothing and write no new attempts (no flood)", async () => {
		await stop();
		await setAutoPickup(env, "coder", "u1", { enabled: true });
		const deps: AutoPickupDeps = { listOpenIssues: async () => ({ issues: [{ number: 7, title: "t", state: "open", labels: [], assignees: [], comments: 0, updatedAt: "", url: "u" }], unreadable: false }), postComment: async () => true, notify: async () => undefined, startQueued: async () => ({ drained: false }) };
		for (let i = 0; i < 30; i++) expect(await runAutoPickup(env, "coder", "u1", deps, NOW + i * 1000)).toMatchObject({ started: false });
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_objective_queue").get()).toEqual({ n: 0 });
		expect(count()).toBe(5);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM issue_quarantine").get()).toEqual({ n: 1 });
	});

	it("a queued objective for the stopped issue is refused by the drain's start guard and that refusal is not another attempt", async () => {
		await stop();
		const before = count();
		await recordDrainRefusal(env, { id: "qx", instanceId: "coder", userId: "u1", repoId: "r1", objective: "Implement GitHub issue #7", metadata: null }, null, "quarantined", "stopped");
		expect(count()).toBe(before);
	});
});

describe("the real run-end path feeds the counter (#1336)", () => {
	it("finishLoopRun counts an unsuccessful end once, ignores a late duplicate finish, and a done end restarts the count", async () => {
		const { finishLoopRun } = await import("./agent-loop-store.js");
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s1', 'coder', 'r1', 'u1')`);
		d1.exec(`INSERT INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number) VALUES ('t7', 'coder', 'u1', 'issue:r1#7', 'T', 'human', 'r1', 7)`);
		const start = (id: string) => d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, ticket_id) VALUES ('${id}', 'u1', 'coder', 'Implement GitHub issue #7', 'running', 5, 1, 's1', 't7')`);
		for (let n = 1; n <= 4; n++) {
			start(`f${n}`);
			expect(await finishLoopRun(env, `f${n}`, "failed", "boom", NOW)).toBe("applied");
			expect(await finishLoopRun(env, `f${n}`, "failed", "boom", NOW)).toBe("already"); // a retried step
		}
		expect(count()).toBe(4);
		expect(await issueQuarantine(env, "u1", "acme/app", 7)).toBeNull();
		start("f5");
		await finishLoopRun(env, "f5", "max_iterations", "cap", NOW);
		expect(await issueQuarantine(env, "u1", "acme/app", 7)).toMatchObject({ attemptCount: 5 });
		start("ok");
		await finishLoopRun(env, "ok", "done", "shipped", NOW);
		expect(await issueQuarantine(env, "u1", "acme/app", 7)).toBeNull();
	});
});
