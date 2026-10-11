/**
 * The #1015 incident, through the real coding routes on the real migrated schema.
 *
 * Only the machine is simulated (`runner-client`): no real runner, engine, queue, stash or
 * credentials. The sequence: run A's orchestration has ended but its retained session is still
 * there; another run (B) works the same checkout; the owner sends A a direct follow-up.
 *
 * Invariants protected: that direct turn is refused while B owns the checkout (no second writer);
 * once admitted it is a durable owner every status surface names; a captured working engine under
 * A's ENDED row reports working, not ended; a run start is refused until the runner confirms the
 * engine idle, and only then is the claim released and the queue drained.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const { getRunnerConn, callRunner, drain } = vi.hoisted(() => ({ getRunnerConn: vi.fn(), callRunner: vi.fn(), drain: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getRunnerConn,
	getRunnerConnIgnoringLiveness: getRunnerConn,
	callRunner,
}));
vi.mock("../lib/objective-queue-start.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/objective-queue-start.js")>()),
	tryDequeueAndStart: (...a: unknown[]) => drain(...a),
}));

const { codingRoutes } = await import("./coding.js");
const { repoFreeForRun, runnerEngineProbe } = await import("../lib/coding-ownership.js");
const { settleAfterDirectTurn } = await import("../workflows/coding-watch.js");

const SECRET = "direct-turn-secret";
let d1: RealSchemaD1;
let env: Env;
/** What the simulated engine is doing, per session. */
let engine: Record<string, { alive: boolean; ready: boolean; runState: string; lastTurn?: { at: number } }>;
let acts: string[];

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'acme/platform', '/w/platform', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('A', 'i1', 'r1', 'u1', 'ended', 'codex')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('B', 'i1', 'r1', 'u1', 'active', 'claude')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-A', 'u1', 'i1', 'issue one', 'completed', 10, 1, 'A')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-B', 'u1', 'i1', 'issue two', 'running', 10, 2, 'B')`);
	env = { DB: d1.DB, SESSION_SIGNING_KEY: SECRET, CODING_SESSION: { create: async () => ({ id: "cw" }) } } as unknown as Env;
	engine = { A: { alive: true, ready: true, runState: "idle" }, B: { alive: true, ready: false, runState: "responding" } };
	acts = [];
	getRunnerConn.mockResolvedValue({ kind: "relay", instanceId: "i1", runnerNode: "n1", relayName: "i1:node:n1" });
	callRunner.mockImplementation(async (_conn: unknown, path: string, body: { sessionId: string }) => {
		if (path === "/coding/act") acts.push(body.sessionId);
		return { pane: "$ ", ...engine[body.sessionId] };
	});
	drain.mockResolvedValue({ drained: false });
});
afterEach(() => d1.close());

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", codingRoutes);
	a.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	return a;
}
async function call(method: string, path: string, body?: unknown) {
	const token = await signSession("u1", SECRET, { roles: [] });
	const res = await app().request(`/v1/instances/i1${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const claimOf = (sid: string) => (d1.sqlite.prepare(`SELECT direct_turn_id FROM coding_sessions WHERE id = '${sid}'`).get() as { direct_turn_id: string | null }).direct_turn_id;
const scope = { instanceId: "i1", userId: "u1", repoId: "r1" };

describe("a direct follow-up to a retained session while another run works the checkout (#1015)", () => {
	it("is refused, names the owner, and never reaches the engine", async () => {
		const res = await call("POST", "/coding/sessions/A/message", { text: "one more correction" });
		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({ admitted: false, owner: { kind: "run", runId: "run-B", sessionId: "B" } });
		expect(String(res.body.error)).toContain("run-B");
		expect(acts).toEqual([]);
		expect(claimOf("A")).toBeNull();
	});

	it("once the checkout is free: admitted as a durable owner, named by capture, and blocking any run start until idle", async () => {
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-B'");
		const sent = await call("POST", "/coding/sessions/A/message", { text: "one more correction" });
		expect(sent.status).toBe(200);
		expect(sent.body).toMatchObject({ admission: { kind: "direct" }, delivery: { state: "delivered", engineBefore: "idle", processed: false } });
		expect(acts).toEqual(["A"]);
		expect(claimOf("A")).toMatch(/^dturn-/);

		// The engine is now working the turn under A's ENDED row.
		engine.A = { alive: true, ready: false, runState: "responding" };
		const cap = await call("GET", "/coding/sessions/A/capture");
		// Not `ended`: the originating orchestration ended, the engine did not.
		expect(cap.body).toMatchObject({ runState: "responding", sessionStatus: "ended" });
		expect((cap.body.ownership as { owners: Array<{ kind: string; sessionId: string }> }).owners).toEqual([expect.objectContaining({ kind: "direct", sessionId: "A" })]);

		// A queue drain / loop start on the repo is refused while the turn is live…
		const probe = runnerEngineProbe(env, "i1", "u1");
		expect(await repoFreeForRun(env, { ...scope, sessionId: "B" }, probe)).toMatchObject({ free: false, owner: { kind: "direct", sessionId: "A" } });
		// …and while the machine cannot answer at all (fail closed).
		getRunnerConn.mockResolvedValueOnce(null);
		expect((await repoFreeForRun(env, { ...scope, sessionId: "B" }, probe)).free).toBe(false);
		expect(claimOf("A")).not.toBeNull();

		// The watcher still sees it busy: the claim stays and nothing is drained.
		expect(await settleAfterDirectTurn(env, { ...scope, sessionId: "A", finalPane: null }, probe)).toBe(false);
		expect(drain).not.toHaveBeenCalled();

		// The engine finishes: the watcher releases the claim, marks the directive processed, drains once.
		engine.A = { alive: true, ready: true, runState: "idle", lastTurn: { at: Date.now() + 1000 } };
		expect(await settleAfterDirectTurn(env, { ...scope, sessionId: "A", finalPane: { lastTurn: engine.A.lastTurn } }, probe)).toBe(true);
		expect(claimOf("A")).toBeNull();
		expect(drain).toHaveBeenCalledTimes(1);
		expect(drain).toHaveBeenCalledWith(env, "i1", "r1", "u1");
		const directive = d1.sqlite.prepare("SELECT kind, delivery, processed_at FROM coding_session_directives WHERE session_id = 'A'").get() as { kind: string; delivery: string; processed_at: number | null };
		expect(directive).toMatchObject({ kind: "direct", delivery: "delivered" });
		expect(directive.processed_at).not.toBeNull();
	});

	it("a message to the session its own run drives is a steer of that run, recorded with its delivery state", async () => {
		// B's engine is mid-turn and B is a persistent (Claude) session: the message queues behind it.
		const res = await call("POST", "/coding/sessions/B/message", { text: "read-only from now on" });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ admission: { kind: "steer", runId: "run-B" }, delivery: { state: "queued", engineBefore: "busy" } });
		expect(claimOf("B")).toBeNull();
		const row = d1.sqlite.prepare("SELECT kind, run_id, delivery, content FROM coding_session_directives WHERE session_id = 'B'").get();
		expect(row).toEqual({ kind: "steer", run_id: "run-B", delivery: "queued", content: "read-only from now on" });
	});

	it("releases its own claim when nothing could be delivered", async () => {
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-B'");
		callRunner.mockImplementation(async (_c: unknown, path: string, body: { sessionId: string }) => (path === "/coding/act" ? null : { pane: "$ ", ...engine[body.sessionId] }));
		const res = await call("POST", "/coding/sessions/A/message", { text: "hello" });
		expect(res.status).toBe(409);
		expect(claimOf("A")).toBeNull();
	});
});
