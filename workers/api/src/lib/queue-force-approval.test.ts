/**
 * #1728 — two independent defects in coding-queue admission, on the real schema, with fixtures only:
 *
 *  1. A checkout-REPAIR run is maintenance. It ended `done` like any run, so the start guard read it as the issue being finished and the
 *     attempt counter recorded a success the feature never earned. It must neither satisfy delivery nor settle the attempt, and a repair
 *     that is still running must not make an ordinary feature start a "duplicate".
 *  2. A forced start the owner approved, queued behind a busy checkout, was accepted by the route and then refused at the drain as an
 *     ordinary start (the route dropped `force` + `force_reason` when it queued). The approval now rides in server-written columns and is
 *     re-checked at drain: same repository, same issue, still fresh, one audit comment — and anything else fails closed.
 *
 * No queue row, run row or recovery ref of anyone's is read or written: everything below lives in an in-memory schema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const posted: Array<{ number: number; body: string }> = [];
vi.mock("./github-issues.js", async () => {
	const actual = await vi.importActual<typeof import("./github-issues.js")>("./github-issues.js");
	return {
		...actual,
		postIssueComment: async (_e: unknown, _u: string, _r: string, number: number, body: string) => {
			posted.push({ number, body });
			return true;
		},
	};
});

const { checkStartIdempotency, validQueuedApproval, QUEUED_APPROVAL_MAX_AGE_MS } = await import("./start-idempotency.js");
const { claimApprovalAudit, dequeueNext, enqueueObjective } = await import("./objective-queue.js");
const { recordRunForIssue } = await import("./issue-attempt-hooks.js");
const { issueQuarantine, recordIssueAttempt } = await import("./issue-attempts.js");

const NOW = 1_800_000_000_000;
const GITHUB_REPO = "acme/app";
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', '${GITHUB_REPO}'), ('r2', 'coder', 'u1', 'other', 'acme/other')`);
	env = { DB: d1.DB } as unknown as Env;
	posted.length = 0;
	// The queue stamps an approval with the real clock, so the tests pin it: `Date.now()` is NOW unless a test moves it.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
	d1.close();
});

/** A run on `repoId`'s session, linked to issue #`issue` through a ticket — what `linkRunToIssue` leaves behind. */
function run(runId: string, o: { repoId?: string; status?: string; stop?: string | null; issue: number; finished?: number; maintenance?: boolean; objective?: string }) {
	const repoId = o.repoId ?? "r1";
	d1.exec(`INSERT OR IGNORE INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s-${runId}', 'coder', '${repoId}', 'u1')`);
	d1.exec(`INSERT OR IGNORE INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number) VALUES ('t-${repoId}-${o.issue}', 'coder', 'u1', 'issue:${repoId}#${o.issue}', 'T', 'human', '${repoId}', ${o.issue})`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id, ticket_id, cancel_requested, maintenance)
	  VALUES ('${runId}', 'u1', 'coder', '${o.objective ?? "work"}', '${o.status ?? "completed"}', ${o.stop === undefined ? "'done'" : o.stop ? `'${o.stop}'` : "NULL"}, 10, 1, ${o.finished ?? NOW - 3_600_000}, 's-${runId}', 't-${repoId}-${o.issue}', 0, ${o.maintenance ? 1 : "NULL"})`);
}
const check = (objective: string, extra: Record<string, unknown> = {}) =>
	checkStartIdempotency(env, { userId: "u1", instanceId: "coder", repo: { id: "r1", githubRepo: GITHUB_REPO }, objective, ...extra });
const checkOn = (repoId: string, objective: string, extra: Record<string, unknown> = {}) =>
	checkStartIdempotency(env, { userId: "u1", instanceId: "coder", repo: { id: repoId, githubRepo: GITHUB_REPO }, objective, ...extra });

describe("checkout maintenance is not delivery (#1728)", () => {
	it("a repair run that ended done does NOT make the issue 'already done': an ordinary feature start is admitted", async () => {
		run("repair-1", { issue: 1698, maintenance: true });
		expect(await check("Implement #1698", { issue: 1698 })).toBeNull();
	});

	it("control: the same finished run, not marked maintenance, still refuses as already_done", async () => {
		run("feature-1", { issue: 1698 });
		expect(await check("Implement #1698", { issue: 1698 })).toMatchObject({ reason: "already_done", detail: { run_id: "feature-1" } });
	});

	it("a repair that finished does not hide a real feature run that also finished: the feature run still counts", async () => {
		run("repair-1", { issue: 1698, maintenance: true, finished: NOW - 1000 });
		run("feature-1", { issue: 1698, finished: NOW - 5000 });
		expect(await check("Implement #1698", { issue: 1698 })).toMatchObject({ reason: "already_done", detail: { run_id: "feature-1" } });
	});

	it("a repair run still RUNNING does not make the feature start a duplicate (the repo lock is a separate, busy refusal)", async () => {
		run("repair-1", { issue: 1698, maintenance: true, status: "running", stop: null });
		expect(await check("Implement #1698", { issue: 1698 })).toBeNull();
	});

	it("a feature run still running is still a duplicate, and force still cannot override it", async () => {
		run("feature-1", { issue: 1698, status: "running", stop: null });
		expect(await check("Implement #1698", { issue: 1698 })).toMatchObject({ reason: "duplicate", detail: { duplicate_of: "feature-1" } });
		expect(await check("Implement #1698", { issue: 1698, force: true, forceReason: "approved" })).toMatchObject({ reason: "duplicate" });
	});

	it("a repair run's `done` records no success: it does not lift an issue's stop or reset its count", async () => {
		for (let n = 1; n <= 5; n++) await recordIssueAttempt(env, { userId: "u1", instanceId: "coder", githubRepo: GITHUB_REPO, issue: 1698, attemptKey: `run:f${n}`, kind: "run_unsuccessful", reason: "run ended failed", runId: `f${n}`, now: NOW + n });
		expect(await issueQuarantine(env, "u1", GITHUB_REPO, 1698)).not.toBeNull();
		run("repair-1", { issue: 1698, maintenance: true });
		await recordRunForIssue(env, "repair-1", "done", NOW);
		expect(await issueQuarantine(env, "u1", GITHUB_REPO, 1698)).not.toBeNull(); // still stopped: the repair settled nothing
		run("feature-ok", { issue: 1698 });
		await recordRunForIssue(env, "feature-ok", "done", NOW);
		expect(await issueQuarantine(env, "u1", GITHUB_REPO, 1698)).toBeNull(); // a real success still does
	});

	it("a repair run that FAILED is not an attempt against the feature either", async () => {
		run("repair-bad", { issue: 1698, maintenance: true, status: "failed", stop: "failed" });
		await recordRunForIssue(env, "repair-bad", "failed", NOW);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM issue_attempts").get() as { n: number }).n).toBe(0);
	});
});

/** What the drain does with a claimed entry: hand its recorded approval to the guard, with the audit claim bound to the entry, exactly as the driver does. */
async function drain(entryId: string, objective: string, over: { repoId?: string } = {}) {
	const entry = await dequeueNextFor(entryId);
	const approval = entry.approval ? { ...entry.approval, claimAudit: () => claimApprovalAudit(env, entry.id) } : undefined;
	const refusal = await checkOn(over.repoId ?? "r1", objective, { approval });
	return { entry, refusal };
}
/** Claim the entry the way the drain does, then put it back to pending as a busy-again requeue does, so it can be drained again. */
async function dequeueNextFor(entryId: string) {
	const entry = await dequeueNext(env, "coder", "r1");
	expect(entry?.id).toBe(entryId);
	d1.exec(`UPDATE instance_objective_queue SET status = 'pending' WHERE id = '${entryId}'`);
	return entry as NonNullable<typeof entry>;
}

describe("a forced start that queued keeps its approval to the drain (#1728)", () => {
	const OBJECTIVE = "Implement GitHub issue #1698 in acme/app: Rebuild per-instance Kanban";
	const queue = (approval?: { reason: string; issue: number; repoId: string; audited: boolean }, objective = OBJECTIVE) =>
		enqueueObjective(env, { instanceId: "coder", repoId: "r1", userId: "u1", objective, approval });

	beforeEach(() => run("repair-1", { issue: 1698 })); // a recent `done` run on the issue: what makes an ordinary start refuse

	it("regression, busy path A (queued behind a backing-off entry; no start ran): the drain starts it, with exactly one audit comment — however often it is drained", async () => {
		const entry = await queue({ reason: "regression found in prod", issue: 1698, repoId: "r1", audited: false });
		expect(entry.approval).toMatchObject({ reason: "regression found in prod", issue: 1698, repoId: "r1", auditedAt: null });

		const first = await drain(entry.id, OBJECTIVE);
		expect(first.refusal).toBeNull(); // admitted, where the same entry without an approval is refused (below)
		expect(posted).toEqual([{ number: 1698, body: expect.stringContaining("regression found in prod") }]);

		// Busy again → requeued → drained again: the comment is not posted a second time.
		const second = await drain(entry.id, OBJECTIVE);
		expect(second.refusal).toBeNull();
		expect(posted).toHaveLength(1);
	});

	it("regression, busy path B (the start already ran the guard and posted its comment when the repo turned out busy): the drain starts it and posts nothing more", async () => {
		// The route's start passed the guard with `force`, posted the audit comment, found the repo busy and queued — recording `audited`.
		posted.push({ number: 1698, body: "Started again on purpose (force): regression found in prod" });
		const entry = await queue({ reason: "regression found in prod", issue: 1698, repoId: "r1", audited: true });
		const out = await drain(entry.id, OBJECTIVE);
		expect(out.refusal).toBeNull();
		expect(posted).toHaveLength(1); // the one the start made; the drain added none
	});

	it("no approval recorded: the SAME entry is refused at drain, as an ordinary start, with no comment (fails closed)", async () => {
		const entry = await queue(undefined);
		expect(entry.approval).toBeUndefined();
		const out = await drain(entry.id, OBJECTIVE);
		expect(out.refusal).toMatchObject({ reason: "already_done", detail: { issue: 1698 } });
		expect(posted).toEqual([]);
	});

	it("an approval is bound to its repository: the same entry draining onto another repo is not approved", async () => {
		const entry = await queue({ reason: "approved", issue: 1698, repoId: "r1", audited: false });
		run("done-r2", { repoId: "r2", issue: 1698 });
		const out = await drain(entry.id, OBJECTIVE, { repoId: "r2" });
		expect(out.refusal).toMatchObject({ reason: "already_done" }); // not approved there: refused as any start would be
		expect(posted).toEqual([]);
	});

	it("an approval is bound to its issue: it does not excuse a different issue the objective names", async () => {
		const entry = await queue({ reason: "approved", issue: 1698, repoId: "r1", audited: false }, "Implement GitHub issue #1699 in acme/app: other work");
		run("done-1699", { issue: 1699 });
		const out = await drain(entry.id, "Implement GitHub issue #1699 in acme/app: other work");
		expect(out.refusal).toMatchObject({ reason: "already_done", detail: { issue: 1699 } });
		expect(posted).toEqual([]);
	});

	it("a stale approval is dropped and the ordinary guard refuses", async () => {
		const entry = await queue({ reason: "approved", issue: 1698, repoId: "r1", audited: false });
		vi.setSystemTime(NOW + QUEUED_APPROVAL_MAX_AGE_MS + 1);
		const out = await drain(entry.id, OBJECTIVE);
		expect(out.refusal).toMatchObject({ reason: "already_done" });
		expect(posted).toEqual([]);
	});

	it("an approval is still good right up to its limit", async () => {
		const entry = await queue({ reason: "approved", issue: 1698, repoId: "r1", audited: false });
		vi.setSystemTime(NOW + QUEUED_APPROVAL_MAX_AGE_MS);
		expect((await drain(entry.id, OBJECTIVE)).refusal).toBeNull();
	});

	it("force never overrides a run in flight, and an issue's stop is still honoured, approval or not", async () => {
		const entry = await queue({ reason: "approved", issue: 1698, repoId: "r1", audited: false });
		run("live-1", { issue: 1698, status: "running", stop: null });
		expect((await drain(entry.id, OBJECTIVE)).refusal).toMatchObject({ reason: "duplicate", detail: { duplicate_of: "live-1" } });
		expect(posted).toEqual([]); // refused before the force branch: nothing audited for a start that did not happen
		d1.exec("UPDATE agent_loop_runs SET status = 'completed', stop_reason = 'done', finished_at = 1 WHERE run_id = 'live-1'");
		for (let n = 1; n <= 5; n++) await recordIssueAttempt(env, { userId: "u1", instanceId: "coder", githubRepo: GITHUB_REPO, issue: 1698, attemptKey: `run:q${n}`, kind: "run_unsuccessful", reason: "failed", runId: `q${n}`, now: NOW });
		expect((await drain(entry.id, OBJECTIVE)).refusal).toMatchObject({ reason: "quarantined" });
		expect(posted).toEqual([]);
	});
});

describe("the guard and a recorded approval (#1728)", () => {
	const OBJ = "Implement GitHub issue #1698 in acme/app";
	const approval = { reason: "approved", issue: 1698, repoId: "r1", approvedAt: NOW - 1000 };
	beforeEach(() => run("done-1", { issue: 1698 }));

	it("an approval admits the start and the audit is claimed through it, once", async () => {
		let asked = 0;
		const claimAudit = async () => ++asked === 1;
		expect(await check(OBJ, { approval: { ...approval, claimAudit } })).toBeNull();
		expect(await check(OBJ, { approval: { ...approval, claimAudit } })).toBeNull();
		expect(asked).toBe(2); // asked on each pass; only the first said yes
		expect(posted).toHaveLength(1);
	});

	it("`force: true` itself wins over a recorded approval: its own reason, its own single comment, no second claim", async () => {
		let claimed = false;
		expect(await check(OBJ, { force: true, forceReason: "the owner said so", issue: 1698, approval: { ...approval, claimAudit: async () => (claimed = true) } })).toBeNull();
		expect(claimed).toBe(false);
		expect(posted).toEqual([{ number: 1698, body: expect.stringContaining("the owner said so") }]);
	});

	it("an approval for another issue does not admit this one, and posts nothing", async () => {
		expect(await check(OBJ, { approval: { ...approval, issue: 7 } })).toMatchObject({ reason: "already_done" });
		expect(posted).toEqual([]);
	});
});

describe("validQueuedApproval fails closed (#1728)", () => {
	const good = { reason: "approved", issue: 1698, repoId: "r1", approvedAt: NOW - 1000 };
	const ctx = { repoId: "r1", githubRepo: GITHUB_REPO, objective: "Implement GitHub issue #1698 in acme/app", now: NOW };

	it("accepts a recorded approval for this repository and issue", () => {
		expect(validQueuedApproval(good, ctx)).toEqual(good);
	});

	it("an objective that names no issue is covered by the approval's own explicit issue", () => {
		expect(validQueuedApproval(good, { ...ctx, objective: "finish the board work" })).toEqual(good);
	});

	it.each([
		["nothing recorded", undefined],
		["a blank reason", { ...good, reason: "   " }],
		["no reason", { ...good, reason: "" }],
		["a non-integer issue", { ...good, issue: 1698.5 }],
		["a zero issue", { ...good, issue: 0 }],
		["another repository", { ...good, repoId: "r2" }],
		["a future-dated approval", { ...good, approvedAt: NOW + 60_000 }],
		["an approval older than a day", { ...good, approvedAt: NOW - QUEUED_APPROVAL_MAX_AGE_MS - 1 }],
		["a non-finite time", { ...good, approvedAt: Number.NaN }],
	])("%s is not an approval", (_name, approval) => {
		expect(validQueuedApproval(approval as never, ctx)).toBeNull();
	});

	it("an objective naming a different issue in this repository is not covered; one naming ANOTHER repository's issue is read as no issue, not as a mismatch", () => {
		expect(validQueuedApproval(good, { ...ctx, objective: "Implement GitHub issue #1699 in acme/app" })).toBeNull();
		// Write scope refuses that objective before the guard ever runs; here it only must not widen the approval.
		expect(validQueuedApproval(good, { ...ctx, objective: "see acme/other#1699" })).toEqual(good);
	});

	it("exactly at the age limit is still good", () => {
		expect(validQueuedApproval({ ...good, approvedAt: NOW - QUEUED_APPROVAL_MAX_AGE_MS }, ctx)).not.toBeNull();
	});
});

describe("the queue row carries the approval and nothing else can plant one (#1728)", () => {
	const enqueue = (approval?: { reason: string; issue: number; repoId: string; audited: boolean }, metadata?: string) =>
		enqueueObjective(env, { instanceId: "coder", repoId: "r1", userId: "u1", objective: "Implement GitHub issue #5 in acme/app", metadata, approval });

	it("the approval round-trips through the drain's claim; an entry queued without one has none", async () => {
		const withApproval = await enqueue({ reason: "approved", issue: 5, repoId: "r1", audited: false });
		const claimed = await dequeueNext(env, "coder", "r1");
		expect(claimed?.id).toBe(withApproval.id);
		expect(claimed?.approval).toMatchObject({ reason: "approved", issue: 5, repoId: "r1", auditedAt: null });
		const plain = await enqueue();
		expect((await dequeueNext(env, "coder", "r1"))?.approval).toBeUndefined();
		expect(plain.approval).toBeUndefined();
	});

	it("caller-owned `metadata` is not an approval: naming one there does not make the drain force anything", async () => {
		const forged = await enqueue(undefined, JSON.stringify({ force: true, forceReason: "trust me", approval: { reason: "trust me", issue: 5, repoId: "r1" } }));
		const claimed = await dequeueNext(env, "coder", "r1");
		expect(claimed?.id).toBe(forged.id);
		expect(claimed?.approval).toBeUndefined();
	});

	it("a half-recorded approval is no approval", async () => {
		const e = await enqueue({ reason: "approved", issue: 5, repoId: "r1", audited: false });
		d1.exec(`UPDATE instance_objective_queue SET approval_repo_id = NULL WHERE id = '${e.id}'`);
		expect((await dequeueNext(env, "coder", "r1"))?.approval).toBeUndefined();
	});

	it("the audit is claimed exactly once, by the first caller; already audited at enqueue, or never approved, nobody claims it", async () => {
		const unaudited = await enqueue({ reason: "approved", issue: 5, repoId: "r1", audited: false });
		expect(await Promise.all([claimApprovalAudit(env, unaudited.id), claimApprovalAudit(env, unaudited.id)])).toEqual([true, false]);
		expect(await claimApprovalAudit(env, unaudited.id)).toBe(false);
		const audited = await enqueue({ reason: "approved", issue: 5, repoId: "r1", audited: true });
		expect(await claimApprovalAudit(env, audited.id)).toBe(false);
		const none = await enqueue();
		expect(await claimApprovalAudit(env, none.id)).toBe(false);
	});
});
