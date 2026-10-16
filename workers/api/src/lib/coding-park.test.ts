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
import { answerEventType, DECISION_PARK_MS, PARK_WAKE_BACKSTOP_MS, runDueParkWakes, wakeParkedRun } from "./coding-park.js";
import { recordAnswer } from "./coder-question-store.js";
import { defaultEffects, runDueCoderQuestions } from "./coder-question-sweep.js";
import { getCoderQuestion, storedAnswer } from "./coder-question-store.js";
import { listIdleSessions } from "./coding-sweep-queries.js";
import { reconcileOrphanedSessions } from "./coding-store.js";
import { sweepStaleRuns } from "./run-sweeper.js";
import { repoFreeForRun, repoOwners } from "./coding-ownership.js";
import { describeBusyHolder } from "./loop-busy.js";
import { resumeSessionsForNode } from "./coding-store.js";
import { releasedRunAwaitingCheckout } from "./coding-park.js";
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
});
