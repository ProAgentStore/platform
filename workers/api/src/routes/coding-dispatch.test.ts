/**
 * One writer per checkout through EVERY engine-writing door, across the gap between admission and
 * delivery (#1015), on the real migrated schema with a simulated runner.
 *
 * Doors driven for real: `POST …/message` (direct and steer), the Co-pilot's `POST …/agent` in both
 * its owner (`@claude`) and controller (model `drive_claude`) forms, and the chat tool `send_to_cli`.
 * Faked: the runner transport (`runner-client`), the model provider for the Co-pilot, the queue drain
 * (observed, not run), and the on-demand session opener `send_to_cli` uses (its connectivity checks
 * are not the subject). No real queue, session, engine, checkout or credential.
 *
 * The suspension point is the simulated runner's `/coding/capture` — the engine-state probe every
 * dispatch makes AFTER admission and BEFORE the send, i.e. the real gap the race lived in.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { RunnerUnreachableError } from "../lib/runner-unreachable.js";
import type { Env } from "../types.js";

const h = vi.hoisted(() => ({ getRunnerConn: vi.fn(), callRunner: vi.fn(), drain: vi.fn(), ai: vi.fn(), session: { current: null as unknown } }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getRunnerConn: h.getRunnerConn,
	getRunnerConnIgnoringLiveness: h.getRunnerConn,
	getBoundRunnerConn: h.getRunnerConn,
	callRunner: h.callRunner,
}));
vi.mock("../lib/objective-queue-start.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/objective-queue-start.js")>()),
	tryDequeueAndStart: (...a: unknown[]) => h.drain(...a),
}));
vi.mock("../lib/user-ai.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/user-ai.js")>()), runUserWorkersAi: (...a: unknown[]) => h.ai(...a) }));
vi.mock("../lib/coding-session-open.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/coding-session-open.js")>()),
	ensureSessionForChat: async () => ({ ok: true, session: h.session.current }),
	startSessionOnRunner: async () => ({ conn: CONN }),
}));

const CONN = { kind: "relay", instanceId: "i1", runnerNode: "n1", relayName: "i1:node:n1" };
const { codingRoutes } = await import("./coding.js");
const { admitDirectTurn, repoFreeForRun, runnerEngineProbe } = await import("../lib/coding-ownership.js");
const { settleAfterDirectTurn } = await import("../workflows/coding-watch.js");
const { executeStorageTool } = await import("../lib/storage-tools.js");
const { getSession } = await import("../lib/coding-store.js");
const { setControllerAiSleepForTest } = await import("../lib/controller-ai-recovery.js");
const { UserAiProviderError } = await import("../lib/user-ai.js");

const SECRET = "dispatch-secret";
let d1: RealSchemaD1;
let env: Env;
type Engine = { alive: boolean; ready: boolean; runState: string };
let engine: Record<string, Engine>;
/** Every instruction that reached the simulated engine, in order: [session, text]. */
let acts: Array<[string, string]>;
/** A capture that parks until released — the gap between admission and send. */
let gate: { session: string; wait: () => Promise<void> } | null;
const scope = { instanceId: "i1", userId: "u1", repoId: "r1" };
const IDLE: Engine = { alive: true, ready: true, runState: "idle" };

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'acme/widget', '/w/widget', 'ready')`);
	for (const [id, status, client] of [["A", "ended", "codex"], ["B", "active", "claude"], ["C", "ended", "claude"]]) {
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('${id}', 'i1', 'r1', 'u1', '${status}', '${client}')`);
	}
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-B', 'u1', 'i1', 'synthetic', 'running', 10, 2, 'B')`);
	env = { DB: d1.DB, SESSION_SIGNING_KEY: SECRET, CODING_SESSION: { create: async () => ({ id: "cw" }) } } as unknown as Env;
	engine = { A: { ...IDLE }, B: { alive: true, ready: false, runState: "responding" }, C: { ...IDLE } };
	acts = [];
	gate = null;
	h.getRunnerConn.mockReset();
	h.getRunnerConn.mockResolvedValue(CONN);
	h.callRunner.mockReset();
	h.callRunner.mockImplementation(async (_c: unknown, path: string, body: { sessionId: string; action?: { text?: string } }) => {
		if (path === "/coding/capture" && gate && gate.session === body.sessionId) {
			const g = gate;
			gate = null;
			await g.wait();
		}
		if (path === "/coding/act") acts.push([body.sessionId, String(body.action?.text ?? "")]);
		return { pane: "$ ", ...engine[body.sessionId] };
	});
	h.drain.mockReset();
	h.drain.mockResolvedValue({ drained: false });
	h.ai.mockReset();
});
afterEach(() => d1.close());

/** Park the next capture of `session` until `release()`; `entered` resolves once it is parked. */
function park(session: string) {
	let entered!: () => void;
	let release!: () => void;
	const enteredP = new Promise<void>((r) => (entered = r));
	const releasedP = new Promise<void>((r) => (release = r));
	gate = {
		session,
		wait: async () => {
			entered();
			await releasedP;
		},
	};
	return { entered: enteredP, release };
}

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", codingRoutes);
	a.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 409) : c.json({ error: String(err) }, 500)));
	return a;
}
async function call(method: string, path: string, body?: unknown) {
	const token = await signSession("u1", SECRET, { roles: ["user"] });
	const res = await app().request(`/v1/instances/i1${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const claim = (sid: string) => d1.sqlite.prepare("SELECT direct_turn_id AS turn, direct_turn_delivered_at AS delivered FROM coding_sessions WHERE id = ?").get(sid) as { turn: string | null; delivered: number | null };
const directives = () => d1.sqlite.prepare("SELECT session_id, kind, run_id, delivery, content FROM coding_session_directives ORDER BY created_at").all();
const endRunB = () => d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-B'");
const probe = () => runnerEngineProbe(env, "i1", "u1");

describe("the gap between admission and delivery", () => {
	it("a steer whose run ends while it is in flight: the successor is held off, one writer, the run stays ended", async () => {
		const p = park("B");
		const pending = call("POST", "/coding/sessions/B/message", { text: "also check the docs" });
		await p.entered;
		// While the steer is between admission and send: its run ends, and a queued successor on
		// another session tries to take the checkout.
		endRunB();
		engine.B = { ...IDLE };
		expect(await repoFreeForRun(env, { ...scope, sessionId: "C" }, probe())).toMatchObject({ free: false, owner: { kind: "direct", sessionId: "B" } });
		expect(await admitDirectTurn(env, { ...scope, sessionId: "C" }, probe())).toMatchObject({ ok: false });
		p.release();
		const res = await pending;
		expect(res.status).toBe(200);
		// Sent once, to its own session — as the caller's OWN direct turn, not as a revival of run-B.
		expect(acts).toEqual([["B", expect.stringContaining("also check the docs")]]);
		expect(res.body.admission).toMatchObject({ kind: "direct" });
		expect(directives()).toEqual([{ session_id: "B", kind: "direct", run_id: null, delivery: "delivered", content: "also check the docs" }]);
		expect(d1.sqlite.prepare("SELECT status FROM agent_loop_runs WHERE run_id = 'run-B'").get()).toEqual({ status: "completed" });
	});

	it("an idle engine probed before the message arrives does not release the reservation", async () => {
		endRunB();
		const p = park("A");
		const pending = call("POST", "/coding/sessions/A/message", { text: "run the focused test" });
		await p.entered;
		// The engine IS idle — the message has not reached it yet. A watcher or admission probe now
		// must not read that as "turn finished".
		const held = claim("A").turn;
		expect(held).toMatch(/^dturn-/);
		expect(await settleAfterDirectTurn(env, { ...scope, sessionId: "A", turnId: held as string, finalPane: null }, probe())).toBe(false);
		expect(await repoFreeForRun(env, { ...scope, sessionId: "C" }, probe())).toMatchObject({ free: false });
		expect(claim("A").turn).toBe(held);
		p.release();
		expect((await pending).status).toBe(200);
		expect(acts).toHaveLength(1);
	});

	it("a reservation replaced while in flight sends NOTHING — no duplicate, no interleaving", async () => {
		endRunB();
		const p = park("A");
		const first = call("POST", "/coding/sessions/A/message", { text: "first instruction" });
		await p.entered;
		const second = await call("POST", "/coding/sessions/A/message", { text: "second instruction" });
		expect(second.status).toBe(200);
		p.release();
		const late = await first;
		expect(late).toMatchObject({ status: 409, body: { reason: "superseded" } });
		expect(acts.map(([, t]) => t.includes("first instruction"))).toEqual([false]);
		expect(acts).toHaveLength(1);
	});
});

describe("what a failed send proves", () => {
	it("a socket dropped with the command in flight is NOT re-sent and does NOT release the claim", async () => {
		endRunB();
		h.callRunner.mockImplementation(async (_c: unknown, path: string, body: { sessionId: string; action?: { text?: string } }) => {
			if (path === "/coding/act") {
				acts.push([body.sessionId, String(body.action?.text ?? "")]);
				throw new RunnerUnreachableError("Runner disconnected", { dispatched: true });
			}
			return { pane: "$ ", ...engine[body.sessionId] };
		});
		const res = await call("POST", "/coding/sessions/A/message", { text: "deploy the docs" });
		expect(res.status).toBe(202);
		expect(res.body.delivery).toMatchObject({ state: "accepted", confirmed: false });
		expect(acts).toHaveLength(1); // attempted once — a lost reply is never a reason to send again
		expect(claim("A")).toMatchObject({ turn: expect.stringMatching(/^dturn-/), delivered: expect.any(Number) });
		expect(directives()).toEqual([expect.objectContaining({ delivery: "accepted" })]);
	});

	it("a runner that lost the session is reattached and the instruction sent exactly once more", async () => {
		endRunB();
		let attempts = 0;
		h.callRunner.mockImplementation(async (_c: unknown, path: string, body: { sessionId: string; action?: { text?: string } }) => {
			if (path === "/coding/act" && ++attempts === 1) throw new Error(`Runner /coding/act → 404: No coding session ${body.sessionId}`);
			if (path === "/coding/act") acts.push([body.sessionId, String(body.action?.text ?? "")]);
			return { pane: "$ ", ...engine[body.sessionId] };
		});
		const res = await call("POST", "/coding/sessions/A/message", { text: "carry on" });
		expect(res).toMatchObject({ status: 200, body: { delivery: { confirmed: true } } });
		expect(attempts).toBe(2);
		expect(acts).toHaveLength(1);
	});

	it("an unknown engine elsewhere on the repo fails closed: nothing is admitted or sent", async () => {
		endRunB();
		d1.exec(`UPDATE coding_sessions SET direct_turn_id = 'dturn-other', direct_turn_at = 1, direct_turn_delivered_at = 1, runner_node = 'gone' WHERE id = 'C'`);
		// C's machine cannot be asked (this caller's own runner is fine): C's engine state is UNKNOWN.
		h.getRunnerConn.mockImplementation(async (_e: unknown, _i: unknown, _u: unknown, node?: string | null) => (node === "gone" ? null : CONN));
		const res = await call("POST", "/coding/sessions/A/message", { text: "go" });
		expect(res).toMatchObject({ status: 409, body: { admitted: false, owner: { kind: "direct", sessionId: "C" } } });
		expect(acts).toEqual([]);
		expect(claim("C").turn).toBe("dturn-other");
	});
});

describe("a stale watcher", () => {
	it("does not release a newer send's reservation; the newer watcher does, and drains once", async () => {
		endRunB();
		const first = await call("POST", "/coding/sessions/A/message", { text: "first" });
		const second = await call("POST", "/coding/sessions/A/message", { text: "second" });
		const t1 = (first.body.admission as { turnId: string }).turnId;
		const t2 = (second.body.admission as { turnId: string }).turnId;
		expect(claim("A").turn).toBe(t2);
		// The engine is idle; the FIRST send's watcher wakes late.
		expect(await settleAfterDirectTurn(env, { ...scope, sessionId: "A", turnId: t1, finalPane: null }, probe())).toBe(true);
		expect(claim("A").turn).toBe(t2);
		expect(h.drain).not.toHaveBeenCalled();
		expect(await settleAfterDirectTurn(env, { ...scope, sessionId: "A", turnId: t2, finalPane: null }, probe())).toBe(true);
		expect(claim("A").turn).toBeNull();
		expect(h.drain).toHaveBeenCalledTimes(1);
	});
});

describe("the Co-pilot door (driveClaude) goes through the same gate", () => {
	it("an owner's @claude instruction is refused while another session's run owns the checkout — nothing sent", async () => {
		const res = await call("POST", "/coding/sessions/A/agent", { message: "@claude fix the flaky test" });
		expect(res.body).toMatchObject({ delegated: false });
		expect(String(res.body.reply)).toContain("run-B");
		expect(acts).toEqual([]);
	});

	it("a model-composed delegation is sent once with a reservation, and is NOT recorded as an owner directive", async () => {
		endRunB();
		h.ai.mockResolvedValue({ tool_calls: [{ name: "drive_claude", arguments: { instruction: "run pnpm vitest run src/x.test.ts", summary: "running the test" } }] });
		const res = await call("POST", "/coding/sessions/A/agent", { message: "can you check the test?" });
		expect(res.body).toMatchObject({ delegated: true });
		expect(acts).toEqual([["A", expect.stringContaining("run pnpm vitest run src/x.test.ts")]]);
		expect(claim("A").turn).toMatch(/^dturn-/);
		expect(directives()).toEqual([]);
	});
});

describe("the chat door (send_to_cli) goes through the same gate", () => {
	const send = async () => {
		h.session.current = await getSession(env, "i1", "u1", "A");
		return executeStorageTool({ name: "send_to_cli", input: { repo_name: "acme/widget", message: "run the tests" } } as never, {} as never, { env, agentId: "i1", userId: "u1" } as never);
	};

	it("is refused while another session's run owns the checkout, and says nothing reached the engine", async () => {
		const out = await send();
		expect(out.success).toBe(false);
		expect(out.content).toContain("Nothing reached the engine");
		expect(acts).toEqual([]);
	});

	it("is sent once with a reservation when the checkout is free, and is not an owner directive", async () => {
		endRunB();
		const out = await send();
		expect(out.success).toBe(true);
		expect(acts).toEqual([["A", expect.stringContaining("run the tests")]]);
		expect(claim("A")).toMatchObject({ turn: expect.stringMatching(/^dturn-/), delivered: expect.any(Number) });
		expect(directives()).toEqual([]);
	});
});

describe("the Co-pilot door recovers a stalled controller reply (#907)", () => {
	const stall = () => new UserAiProviderError("The AI provider stopped sending mid-reply — 45s with no bytes received.", 504, undefined, undefined, true);
	const DRIVE = { tool_calls: [{ name: "drive_claude", arguments: { instruction: "run pnpm vitest run src/x.test.ts", summary: "running the test" } }] };
	beforeEach(() => {
		endRunB();
		setControllerAiSleepForTest(async () => undefined);
	});
	afterEach(() => setControllerAiSleepForTest(null));

	it("re-asks after a stall and delegates once, from the complete answer, with the policy's deadlines", async () => {
		h.ai.mockRejectedValueOnce(stall()).mockResolvedValueOnce(DRIVE);
		const res = await call("POST", "/coding/sessions/A/agent", { message: "can you check the test?" });
		expect(res.body).toMatchObject({ delegated: true });
		expect(h.ai).toHaveBeenCalledTimes(2);
		expect((h.ai.mock.calls[0][3] as { streamDeadlines: unknown }).streamDeadlines).toEqual({ preContentMs: 60_000, silenceMs: 45_000, totalMs: 240_000, attempt: 1 });
		expect(acts).toEqual([["A", expect.stringContaining("run pnpm vitest run src/x.test.ts")]]);
	});

	it("on exhaustion says the provider stalled and sends nothing — never a silent '(no response)'", async () => {
		h.ai.mockRejectedValue(stall());
		const res = await call("POST", "/coding/sessions/A/agent", { message: "can you check the test?" });
		expect(h.ai).toHaveBeenCalledTimes(4);
		expect(res.body).toMatchObject({ delegated: false });
		expect(String(res.body.reply)).toMatch(/^The AI provider stalled on 4 attempts over \d+s, so nothing was sent to the coding CLI\. Send your message again\.$/);
		expect(acts).toEqual([]);
	});

	it("does not retry a non-stall failure", async () => {
		h.ai.mockRejectedValue(new UserAiProviderError("Anthropic (401): invalid x-api-key", 401, 401, undefined, false));
		const res = await call("POST", "/coding/sessions/A/agent", { message: "can you check the test?" });
		expect(h.ai).toHaveBeenCalledTimes(1);
		expect(res.body).toMatchObject({ delegated: false, reply: "(no response)" });
		expect(acts).toEqual([]);
	});
});
