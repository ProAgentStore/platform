/**
 * #1076 — what keeps a run parked on a question alive, and what wakes it, over the real schema.
 *
 * A parked run ticks NOTHING (it waits on `step.waitForEvent`), so every pass that reads silence as
 * death must leave it alone, and every door that writes a fact it should act on must wake it. Only
 * the Workflows binding (`sendEvent`) is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { requestCancel } from "./agent-loop-store.js";
import { answerEventType, DECISION_PARK_MS, PARK_WAKE_BACKSTOP_MS, runDueParkWakes, wakeParkedRun, wakeParkedRunDetailed } from "./coding-park.js";
import { recordAnswer } from "./coder-question-store.js";
import { defaultEffects, runDueCoderQuestions } from "./coder-question-sweep.js";
import { getCoderQuestion, storedAnswer } from "./coder-question-store.js";
import { listIdleSessions } from "./coding-sweep-queries.js";
import { reconcileOrphanedSessions } from "./coding-store.js";
import { sweepStaleRuns } from "./run-sweeper.js";
import { releaseStaleActiveSessions, repoFreeForRun, repoOwners } from "./coding-ownership.js";
import { listBlockedOnAnswerWithHolder } from "./blocked-on-answer.js";
import { duplicateCoderWarning } from "./coding-duplicate-coder.js";
import { describeBusyHolder } from "./loop-busy.js";
import { resumeSessionsForNode } from "./coding-store.js";
import { CHECKOUT_WAKE_GRACE_MS, putBackWork, releasedRunAwaitingCheckout, takeBackCheckout } from "./coding-park.js";
import { listBlockedOnAnswer, toLoopRunView, type LoopRunRow } from "./agent-loop-store.js";
import { tryDequeueAndStart } from "./objective-queue-start.js";
import { enqueueObjective } from "./objective-queue.js";
import type { Env } from "../types.js";

const DAY = 86_400_000;
let d1: RealSchemaD1;
let env: Env;
let sent: Array<{ instance: string; type: string; why: unknown }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'owner/repo')`);
	sent = [];
	const CODING_SESSION = { get: async (instance: string) => ({ sendEvent: async (e: { type: string; payload: { why?: unknown } }) => void sent.push({ instance, type: e.type, why: e.payload?.why }) }) };
	env = { DB: d1.DB, CODING_SESSION } as unknown as Env;
});
afterEach(() => d1.close());

/** A run parked on a question 10 days ago, as `parkOnQuestion` leaves it; its session quiet for as long. */
function parked(opts: { askedAt?: number; parkedAt?: number } = {}) {
	const now = Date.now();
	const at = opts.parkedAt ?? now - 10 * DAY;
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, last_activity_at, updated_at) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude', ${at}, datetime('now', '-10 days'))`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, last_alive_at, waiting_reason, waiting_until, parked_since, workflow_instance_id)
	  VALUES ('run-1', 'u1', 'i1', 'x', 'running', 10, ${at}, 's1', ${at}, 'decision', ${at + DECISION_PARK_MS}, ${at}, 'wf-1')`);
	d1.exec(`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, question, state, asked_at, expires_at)
	  VALUES ('q1', 'i1', 'u1', 's1', 'run-1', 'csess-s1', 'Keep it?', 'waiting_human', ${opts.askedAt ?? at}, ${(opts.askedAt ?? at) + 15 * 60_000})`);
}

describe("waking a parked run", () => {
	it("sends the event named for its question to the instance the park recorded", async () => {
		parked();
		expect(await wakeParkedRun(env, "run-1", "answer")).toBe(true);
		expect(sent).toEqual([{ instance: "wf-1", type: answerEventType("q1"), why: "answer" }]);
	});

	it("is a no-op for a run that is not parked on a question, and never throws", async () => {
		parked();
		d1.exec("UPDATE agent_loop_runs SET waiting_reason = NULL");
		expect(await wakeParkedRun(env, "run-1", "answer")).toBe(false);
		d1.exec("UPDATE agent_loop_runs SET waiting_reason = 'decision'");
		const broken = { DB: d1.DB, CODING_SESSION: { get: async () => { throw new Error("no such instance"); } } } as unknown as Env;
		expect(await wakeParkedRun(broken, "run-1", "answer")).toBe(false);
		expect(sent).toEqual([]);
	});

	it("reads the Workflow's status first: a live one is woken, a dead one is `gone` and is sent nothing (#1231)", async () => {
		parked();
		const withStatus = (status: string | Error) =>
			({
				DB: d1.DB,
				CODING_SESSION: {
					get: async (instance: string) => ({
						status: async () => {
							if (status instanceof Error) throw status;
							return { status };
						},
						sendEvent: async (e: { type: string; payload: { why?: unknown } }) => void sent.push({ instance, type: e.type, why: e.payload?.why }),
					}),
				},
			}) as unknown as Env;
		for (const live of ["waiting", "running", "queued", "paused"]) expect(await wakeParkedRunDetailed(withStatus(live), "run-1", "answer")).toBe("woken");
		expect(sent).toHaveLength(4);
		sent = [];
		for (const dead of ["errored", "terminated", "complete", "unknown"]) expect(await wakeParkedRunDetailed(withStatus(dead), "run-1", "answer")).toBe("gone");
		expect(sent).toEqual([]);
		// A status that cannot be READ is not taken as death: the event is still sent.
		expect(await wakeParkedRunDetailed(withStatus(new Error("binding hiccup")), "run-1", "answer")).toBe("woken");
		// An instance the binding no longer has is gone; any other failure is retryable.
		const missing = (message: string) => ({ DB: d1.DB, CODING_SESSION: { get: async () => { throw new Error(message); } } }) as unknown as Env;
		expect(await wakeParkedRunDetailed(missing("instance.not_found: wf-1"), "run-1", "answer")).toBe("gone");
		expect(await wakeParkedRunDetailed(missing("network"), "run-1", "answer")).toBe("failed");
		d1.exec("UPDATE agent_loop_runs SET waiting_reason = NULL");
		expect(await wakeParkedRunDetailed(withStatus("waiting"), "run-1", "answer")).toBe("not_parked");
	});

	it("the backstop hands a run whose Workflow is gone to recovery, instead of re-sending into nothing every minute (#1231)", async () => {
		parked();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "mcp", now: Date.now() - 2 * PARK_WAKE_BACKSTOP_MS });
		const dead = { DB: d1.DB, CODING_SESSION: { get: async () => ({ status: async () => ({ status: "errored" }), sendEvent: async () => void sent.push({ instance: "x", type: "x", why: "x" }) }) } } as unknown as Env;
		const gone: string[] = [];
		expect(await runDueParkWakes(dead, Date.now(), async (runId) => void gone.push(runId))).toBe(0);
		expect(gone).toEqual(["run-1"]);
		expect(sent).toEqual([]);
	});

	it("an event type is a legal Cloudflare event type", () => {
		expect(answerEventType("6f1d2c3b-aaaa-bbbb-cccc-0123456789ab")).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
	});

	it("the coder brain's delivery wakes a parked run, which reads the decision (or unresolved instruction) from the row", async () => {
		parked();
		d1.exec("UPDATE coder_questions SET state = 'unresolved', reason = 'the issue does not settle it', resolved_at = 5");
		const q = await getCoderQuestion(env, "q1");
		await defaultEffects(env).deliver(q!, "ignored: the row is the source");
		expect(sent).toEqual([{ instance: "wf-1", type: answerEventType("q1"), why: "answer" }]);
		expect((await storedAnswer(env, "q1"))?.value).toMatch(/^UNRESOLVED DECISION — nobody answered "Keep it\?" and the coder brain declined \(the issue does not settle it\)/);
	});

	it("stop_work on a parked run wakes it — the cancel would otherwise wait for the sweeper", async () => {
		parked();
		expect(await requestCancel(env, "u1", "run-1")).toBe(true);
		expect(sent).toEqual([{ instance: "wf-1", type: answerEventType("q1"), why: "cancel" }]);
	});
});

describe("the backstop re-sends what a lost event left undone", () => {
	it("wakes a parked run whose answer is on record and unapplied, once it is past the live path's minute", async () => {
		parked();
		const now = Date.now();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console", now });
		expect(await runDueParkWakes(env, now + 1_000)).toBe(0);
		expect(await runDueParkWakes(env, now + PARK_WAKE_BACKSTOP_MS + 1_000)).toBe(1);
		expect(sent.map((s) => s.why)).toEqual(["backstop"]);
	});

	it("leaves an applied answer and an unanswered question alone", async () => {
		parked();
		const later = Date.now() + 2 * PARK_WAKE_BACKSTOP_MS;
		expect(await runDueParkWakes(env, later)).toBe(0);
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "mcp" });
		d1.exec("UPDATE coder_questions SET applied_at = 1, applied_run_id = 'run-1'");
		expect(await runDueParkWakes(env, later)).toBe(0);
	});

	it("wakes a parked run with an unheard cancel", async () => {
		parked();
		d1.exec(`UPDATE agent_loop_runs SET cancel_requested = 1, cancel_requested_at = ${Date.now() - 2 * PARK_WAKE_BACKSTOP_MS}`);
		expect(await runDueParkWakes(env)).toBe(1);
	});
});

describe("nothing that reads silence as death touches a parked run", () => {
	it("the run sweeper keeps a park inside its published end — and still closes a silent run that published none", async () => {
		parked();
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, last_alive_at) VALUES ('dead', 'u1', 'i1', 'x', 'running', 10, ${Date.now() - DAY}, ${Date.now() - DAY})`);
		await sweepStaleRuns(env);
		const status = (id: string) => (d1.sqlite.prepare("SELECT status FROM agent_loop_runs WHERE run_id = ?").get(id) as { status: string }).status;
		expect(status("run-1")).toBe("running");
		expect(status("dead")).not.toBe("running");
	});

	it("the idle reaper and the orphan reconcile keep a parked run's session — its row, card and resume key", async () => {
		parked();
		expect((await listIdleSessions(env, Date.now() - 6 * 3_600_000, 50)).map((s) => s.id)).toEqual([]);
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual([]);
		// The same session with its run no longer parked is reaped as before.
		d1.exec("UPDATE agent_loop_runs SET waiting_reason = NULL");
		expect((await listIdleSessions(env, Date.now() - 6 * 3_600_000, 50)).map((s) => s.id)).toEqual(["s1"]);
	});

	it("the brain sweep does not expire a question its run is parked on — it expires once the run is gone", async () => {
		parked({ askedAt: Date.now() - DAY });
		await runDueCoderQuestions(env);
		const state = () => (d1.sqlite.prepare("SELECT state FROM coder_questions WHERE id = 'q1'").get() as { state: string }).state;
		expect(state()).toBe("waiting_human");
		d1.exec("UPDATE agent_loop_runs SET status = 'cancelled'");
		await runDueCoderQuestions(env);
		expect(state()).toBe("expired");
	});
});

// ── #1077: a released run owns nothing, and takes its place back first ──────────────────────────────

describe("a run that released its checkout is not an owner of its repo (#1077)", () => {
	/** Run 1 parked on its question with its checkout released: its session suspended, the work set aside. */
	function released() {
		parked();
		d1.exec(`UPDATE agent_loop_runs SET checkout_released_at = ${Date.now()}, checkout_snapshot = '${"a".repeat(40)}' WHERE run_id = 'run-1'`);
		d1.exec("UPDATE coding_sessions SET status = 'suspended', driver_id = NULL, runner_node = 'mac' WHERE id = 's1'");
	}
	const idle = async () => "idle" as const;
	const scope = { instanceId: "i1", userId: "u1", repoId: "r1" };

	it("a new run on the same repo is admitted — not refused `busy` — and the busy read names no holder", async () => {
		released();
		expect(await repoOwners(env, scope)).toEqual([]);
		expect(await repoFreeForRun(env, { ...scope, sessionId: "s-new" }, idle)).toEqual({ free: true });
		expect((await describeBusyHolder(env, { userId: "u1", instanceId: "i1", repoId: "r1" })).activeRun).toBeNull();
	});

	it("no change for a run that is working, or parked without having released: it still owns the repo", async () => {
		parked();
		expect((await repoOwners(env, scope)).map((o) => o.kind)).toEqual(["run"]);
		expect(await repoFreeForRun(env, { ...scope, sessionId: "s-new" }, idle)).toMatchObject({ free: false });
	});

	it("a runner reconnecting does not reactivate the released run's session (the next run must not inherit it)", async () => {
		released();
		expect(await resumeSessionsForNode(env, "i1", "u1", "mac")).toBe(0);
		expect((d1.sqlite.prepare("SELECT status FROM coding_sessions WHERE id = 's1'").get() as { status: string }).status).toBe("suspended");
	});

	it("once answered, it goes FIRST: a drain wakes it instead of starting the next queued objective", async () => {
		released();
		await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId: "r1", objective: "queued after it" });
		expect(await releasedRunAwaitingCheckout(env, "i1", "r1")).toBeNull(); // not answered yet: the queue is free to run
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		expect(await releasedRunAwaitingCheckout(env, "i1", "r1")).toBe("run-1");
		expect(await tryDequeueAndStart(env, "i1", "r1", "u1")).toEqual({ drained: false });
		expect(sent).toEqual([{ instance: "wf-1", type: answerEventType("q1"), why: "checkout" }]);
		expect((d1.sqlite.prepare("SELECT status FROM instance_objective_queue").get() as { status: string }).status).toBe("pending");
	});

	it("the backstop does not re-wake it while another run holds the repo — the holder's end does", async () => {
		released();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console", now: Date.now() - 2 * PARK_WAKE_BACKSTOP_MS });
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s2', 'i1', 'r1', 'u1', 'active', 'claude')");
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-2', 'u1', 'i1', 'y', 'running', 10, ${Date.now()}, 's2')`);
		expect(await runDueParkWakes(env)).toBe(0);
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-2'; UPDATE coding_sessions SET status = 'ended' WHERE id = 's2'");
		expect(await runDueParkWakes(env)).toBe(1);
	});

	it("an idle `active` session with no run does not hold the repo: the answer is applied (#1323)", async () => {
		released();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console", now: Date.now() - 2 * PARK_WAKE_BACKSTOP_MS });
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s-idle', 'i1', 'r1', 'u1', 'active', 'codex')");
		expect(await repoOwners(env, scope)).toEqual([]);
		expect(await runDueParkWakes(env)).toBe(1);
		expect(sent).toEqual([{ instance: "wf-1", type: answerEventType("q1"), why: "backstop" }]);
	});

	it("a session with a live driver or direct turn still holds the repo (#1323)", async () => {
		released();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console", now: Date.now() - 2 * PARK_WAKE_BACKSTOP_MS });
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, driver_id) VALUES ('s-drv', 'i1', 'r1', 'u1', 'active', 'claude', 'drv-1')");
		expect(await runDueParkWakes(env)).toBe(0);
		d1.exec("UPDATE coding_sessions SET driver_id = NULL, direct_turn_id = 't1' WHERE id = 's-drv'");
		expect(await runDueParkWakes(env)).toBe(0);
		d1.exec("UPDATE coding_sessions SET direct_turn_id = NULL WHERE id = 's-drv'");
		expect(await runDueParkWakes(env)).toBe(1);
	});

	it("two answered parked runs on one repo, both released, are both woken (#1323)", async () => {
		released();
		const at = Date.now() - 10 * DAY;
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s2', 'i1', 'r1', 'u1', 'suspended', 'claude')`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, last_alive_at, waiting_reason, waiting_until, parked_since, workflow_instance_id, checkout_released_at)
		  VALUES ('run-2', 'u1', 'i1', 'x', 'running', 10, ${at}, 's2', ${at}, 'decision', ${at + DECISION_PARK_MS}, ${at}, 'wf-2', ${Date.now()})`);
		d1.exec(`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, question, state, asked_at, expires_at) VALUES ('q2', 'i1', 'u1', 's2', 'run-2', 'csess-s2', 'Ship?', 'waiting_human', ${at}, ${at + 15 * 60_000})`);
		const old = Date.now() - 2 * PARK_WAKE_BACKSTOP_MS;
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console", now: old });
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s2", value: "yes", via: "console", now: old });
		expect(await runDueParkWakes(env)).toBe(2);
		expect(sent.map((e) => e.instance).sort()).toEqual(["wf-1", "wf-2"]);
	});

	it("takeBackCheckout lets go of a stale idle active session so the answered run resumes, and names a fresh one (#1323)", async () => {
		released();
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, runner_node, updated_at) VALUES ('s-idle', 'i1', 'r1', 'u1', 'active', 'codex', 'tiny-laptop', datetime('now'))");
		const fresh = await takeBackCheckout(env, runScope);
		expect(fresh).toMatchObject({ busy: expect.stringContaining("session s-idle on tiny-laptop") });
		expect(fresh).toMatchObject({ busy: expect.stringContaining("will not end on its own") });
		d1.exec("UPDATE coding_sessions SET updated_at = datetime('now', '-2 hours') WHERE id = 's-idle'");
		expect(await takeBackCheckout(env, runScope)).toMatchObject({ ok: true });
		const status = (id: string) => (d1.sqlite.prepare("SELECT status FROM coding_sessions WHERE id = ?").get(id) as { status: string }).status;
		expect(status("s-idle")).toBe("suspended");
		expect(status("s1")).toBe("active");
	});

	it("never releases a session that has a run, a driver or a direct turn (#1323)", async () => {
		released();
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, driver_id, updated_at) VALUES ('s-drv', 'i1', 'r1', 'u1', 'active', 'claude', 'd1', datetime('now', '-2 hours'))");
		expect(await releaseStaleActiveSessions(env, scope)).toEqual([]);
	});

	it("status names the actual holder of an answered run, and says whether it ends on its own (#1323)", async () => {
		released();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, runner_node) VALUES ('s-idle', 'i1', 'r1', 'u1', 'active', 'codex', 'tiny-laptop')");
		const idleHolder = (await listBlockedOnAnswerWithHolder(env, "i1", "u1"))[0];
		expect(idleHolder.answered).toBe(true);
		expect(idleHolder.waitingOn).toMatchObject({ endsOnItsOwn: false, text: expect.stringContaining("s-idle") });
		d1.exec("UPDATE coding_sessions SET status = 'ended' WHERE id = 's-idle'");
		holder();
		const runHolder = (await listBlockedOnAnswerWithHolder(env, "i1", "u1"))[0];
		expect(runHolder.waitingOn).toMatchObject({ endsOnItsOwn: true, text: expect.stringContaining("run-2") });
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-2'; UPDATE coding_sessions SET status = 'ended' WHERE id = 's2'");
		expect((await listBlockedOnAnswerWithHolder(env, "i1", "u1"))[0].waitingOn).toBeNull();
	});

	it("an answered run is found for auto-pickup across the whole instance, not one repo (#1323)", async () => {
		released();
		expect(await releasedRunAwaitingCheckout(env, "i1", null)).toBeNull();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		expect(await releasedRunAwaitingCheckout(env, "i1", null)).toBe("run-1");
	});

	it("warns when a second coder registers a repo another already has (#1323)", async () => {
		d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r-a', 'i1', 'u1', 'a', 'Owner/Repo')");
		expect(await duplicateCoderWarning(env, "u1", "i1", "owner/repo")).toBeUndefined();
		expect(await duplicateCoderWarning(env, "u1", "i2", "owner/repo")).toMatch(/also registered on another coder \(i1\)/);
		expect(await duplicateCoderWarning(env, "u1", "i2", "other/thing")).toBeUndefined();
		expect(await duplicateCoderWarning(env, "u1", "i2", null)).toBeUndefined();
	});

	// ── #1228: a parked decision never holds the queue ──────────────────────────────────────────────
	const queueStatus = () => (d1.sqlite.prepare("SELECT status FROM instance_objective_queue").get() as { status: string }).status;
	const wakeAt = () => (d1.sqlite.prepare("SELECT checkout_wake_at FROM agent_loop_runs WHERE run_id = 'run-1'").get() as { checkout_wake_at: number | null }).checkout_wake_at;
	/** Run 2 holding the repo: a working run on its own active session. */
	const holder = () => {
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s2', 'i1', 'r1', 'u1', 'active', 'claude')");
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-2', 'u1', 'i1', 'y', 'running', 10, ${Date.now()}, 's2')`);
	};
	const runScope = { runId: "run-1", instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1" };

	it("the queue drains past a run parked on an unanswered question (#1228)", async () => {
		released();
		await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId: "r1", objective: "queued after it" });
		expect(await tryDequeueAndStart(env, "i1", "r1", "u1")).toMatchObject({ drained: true });
		expect(queueStatus()).not.toBe("pending");
		expect(sent).toEqual([]); // the parked run was not woken: it has nothing to resume with yet
	});

	it("an answered run is not preempting: it waits while another run holds the repo, and takes it back once that run ends (#1228)", async () => {
		released();
		holder();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		expect(await takeBackCheckout(env, runScope)).toEqual({ busy: expect.stringContaining("is being worked by run run-2 on session s2") });
		expect((d1.sqlite.prepare("SELECT status FROM coding_sessions WHERE id = 's1'").get() as { status: string }).status).toBe("suspended");
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-2'; UPDATE coding_sessions SET status = 'ended' WHERE id = 's2'");
		expect(await tryDequeueAndStart(env, "i1", "r1", "u1")).toEqual({ drained: false }); // the holder's end wakes it first
		expect(sent).toEqual([{ instance: "wf-1", type: answerEventType("q1"), why: "checkout" }]);
		expect(await takeBackCheckout(env, runScope)).toEqual({ ok: true, snapshot: "a".repeat(40) });
	});

	it("a run woken for its checkout that never takes it back cannot starve the queue (#1228)", async () => {
		// FGS Platform Coder, 2026-10-19: two answered runs never resumed, every drain woke the older one and
		// started nothing, and #358 sat pending 12h behind `activeRun: null`.
		released();
		await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId: "r1", objective: "queued after it" });
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		expect(await tryDequeueAndStart(env, "i1", "r1", "u1")).toEqual({ drained: false });
		const first = wakeAt();
		expect(first).toBeGreaterThan(0);
		// Inside the grace it is still coming: the next drain waits for it again, without restarting its clock.
		expect(await tryDequeueAndStart(env, "i1", "r1", "u1")).toEqual({ drained: false });
		expect(wakeAt()).toBe(first);
		expect(queueStatus()).toBe("pending");
		// Past the grace, the drain passes over it and starts the next objective.
		d1.exec(`UPDATE agent_loop_runs SET checkout_wake_at = ${Date.now() - CHECKOUT_WAKE_GRACE_MS - 1} WHERE run_id = 'run-1'`);
		expect(await releasedRunAwaitingCheckout(env, "i1", "r1")).toBeNull();
		expect(await tryDequeueAndStart(env, "i1", "r1", "u1")).toMatchObject({ drained: true });
		expect(queueStatus()).not.toBe("pending");
		// It keeps its answer and its set-aside work, for the next free cycle.
		expect(await storedAnswer(env, "q1")).toMatchObject({ value: "yes", by: "human" });
		expect(d1.sqlite.prepare("SELECT checkout_released_at IS NOT NULL AS released, checkout_snapshot FROM agent_loop_runs WHERE run_id = 'run-1'").get()).toEqual({ released: 1, checkout_snapshot: "a".repeat(40) });
	});

	it("one holder at a time: a passed-over run cannot take the checkout from the run that started in its place (#1228)", async () => {
		released();
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		d1.exec(`UPDATE agent_loop_runs SET checkout_wake_at = ${Date.now() - CHECKOUT_WAKE_GRACE_MS - 1} WHERE run_id = 'run-1'`);
		holder();
		expect((await repoOwners(env, scope)).map((o) => o.sessionId)).toEqual(["s2"]);
		expect(await takeBackCheckout(env, runScope)).toMatchObject({ busy: expect.any(String) });
		expect((await repoOwners(env, scope)).map((o) => o.sessionId)).toEqual(["s2"]);
		// Once the holder ends it takes the checkout back, and the wake is cleared with the release.
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-2'; UPDATE coding_sessions SET status = 'ended' WHERE id = 's2'");
		expect(await takeBackCheckout(env, runScope)).toMatchObject({ ok: true });
		await putBackWork(env, {} as never, runScope, null);
		expect(wakeAt()).toBeNull();
		expect((await repoOwners(env, scope)).map((o) => o.sessionId)).toEqual(["s1"]);
	});

	it("status views list a released park apart from working runs (#1228)", async () => {
		released();
		holder();
		const row = (id: string) => d1.sqlite.prepare("SELECT * FROM agent_loop_runs WHERE run_id = ?").get(id) as unknown as LoopRunRow;
		expect(toLoopRunView(row("run-1")).blockedOnAnswer).toBe(true);
		expect(toLoopRunView(row("run-2")).blockedOnAnswer).toBe(false);
		d1.exec(`UPDATE agent_loop_runs SET waiting_ask = '${JSON.stringify({ question: "Keep it?", options: [], why: "", field: "Keep it?", taskId: "csess-s1" })}' WHERE run_id = 'run-1'`);
		expect(await listBlockedOnAnswer(env, "i1", "u1")).toEqual([{ runId: "run-1", objective: "x", question: "Keep it?", taskId: "csess-s1", answered: false, parkedSince: expect.any(Number) }]);
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		expect(await listBlockedOnAnswer(env, "i1", "u1", "r1")).toEqual([expect.objectContaining({ runId: "run-1", answered: true })]);
		expect(await listBlockedOnAnswer(env, "i1", "u1", "other")).toEqual([]);
	});
});
