/**
 * #1185: an answer is never reported DELIVERED to a session that has ended.
 *
 * The runner's `/coding/takeover/:sid/resolve` answers `ok` whether or not a pause is pending, so a delivery that trusted it told the
 * owner an answer landed on a session that was already gone — after a repin, a restart, a killed session — while the run sat on the
 * same question forever. The session ROW is the authority: `ended` means there is nothing to hand an answer to. Only the relay is
 * faked; the run, the question, the session and the routing are the real code over the real migrations.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { recordLiveness } from "../lib/agent-loop-store.js";
import { codingCardId } from "../lib/coding-board.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn, getRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), getRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getBoundRunnerConn,
	getRunnerConn,
}));

const { posted } = vi.hoisted(() => ({ posted: [] as Array<{ repo: string; issue: number; body: string }> }));
vi.mock("../lib/github-issues.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/github-issues.js")>()),
	postIssueComment: async (_env: unknown, _uid: string, repo: string, issue: number, body: string) => {
		posted.push({ repo, issue, body });
		return true;
	},
}));

const { instanceRoutes } = await import("./instances.js");
const { codingRoutes } = await import("./coding.js");

const SID = "csess_s1";
const CARD = codingCardId(SID);
let d1: RealSchemaD1;
let sent: Array<{ path: string; body: Record<string, unknown> }>;
const relay = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const cmd = (await req.json()) as { path: string; body: string | Record<string, unknown> };
			const body = typeof cmd.body === "string" ? JSON.parse(cmd.body) : (cmd.body ?? {});
			sent.push({ path: cmd.path, body });
			return Response.json({ ok: true });
		},
	}),
};
const env = () => ({ DB: d1.DB, RELAY: relay }) as unknown as Env;
const conn = () => ({ runnerNode: "mac", instanceId: "i1", userId: "u1", relayName: "i1:node:mac", endpointUrl: "relay://", token: "", env: env() });

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1', 'u1', 't960-coder', 'Repo Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES ('i1', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-07 00:00:00')`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'demo')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('${SID}', 'i1', 'r1', 'u1')`);
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at, session_id) VALUES ('run1','u1','i1','x','running',1,10,1,'${SID}')`,
	);
	getRunnerConn.mockReset();
	getRunnerConn.mockImplementation(async () => conn());
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockImplementation(async () => conn());
	sent = [];
});
afterEach(() => d1.close());

async function answer(taskId: string, value: string, headers: Record<string, string> = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/i1/input", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ taskId, value }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const park = () =>
	recordLiveness(env(), "run1", 2_000, {
		reason: "decision",
		ask: { question: "Ship it behind a flag?", options: ["yes", "no"], why: "irreversible", field: "Ship it behind a flag?", taskId: CARD },
	});
const ask = () =>
	d1.exec(
		`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, repo, issue_number, question, options, state, asked_at, expires_at)
		 VALUES ('q1', 'i1', 'u1', '${SID}', 'run1', '${CARD}', 'ProAgentStore/platform', 1185, 'Ship it behind a flag?', '["yes","no"]', 'waiting_human', 1, ${Date.now() + 60_000})`,
	);
const setSession = (status: string) => d1.exec(`UPDATE coding_sessions SET status = '${status}', ended_at = ${status === "ended" ? "datetime('now')" : "NULL"} WHERE id = '${SID}'`);
const stored = () => d1.sqlite.prepare("SELECT state, decision, applied_at FROM coder_questions WHERE id = 'q1'").get() as { state: string; decision: string | null; applied_at: number | null };

describe("an answer to a session that has ended (#1185)", () => {
	it("is recorded but NOT reported delivered, and nothing is sent to the runner", async () => {
		ask();
		await park();
		setSession("ended");
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ ok: false, kind: "coding", outcome: "session_ended", delivered: false, recorded: true, runId: "run1", sessionId: SID, questionId: "q1", next: "rerun" });
		expect(r.body.error).toMatch(/session .* has ended/i);
		expect(r.body.error).toMatch(/saved on the question/);
		expect(r.body.error).toMatch(/coding_loop_stop/);
		expect(sent).toEqual([]);
		expect(stored()).toMatchObject({ state: "answered_human", decision: "yes", applied_at: null });
	});

	it("with no question row to keep it, says the answer was NOT saved either", async () => {
		await park(); // a park whose capture failed: no row
		setSession("ended");
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ ok: false, outcome: "session_ended", delivered: false, recorded: false });
		expect(r.body.error).toMatch(/not saved/i);
		expect(sent).toEqual([]);
	});

	it("an applied question with a newer park on an ended session says so too, never 'delivered'", async () => {
		d1.exec(
			`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, repo, issue_number, question, options, state, asked_at, expires_at, applied_at, applied_run_id, answered_by, answered_at, decision)
			 VALUES ('q1', 'i1', 'u1', '${SID}', 'run1', '${CARD}', 'ProAgentStore/platform', 1185, 'Ship it?', '[]', 'answered_human', 1, ${Date.now() + 60_000}, 5000, 'run1', 'human', 4000, 'yes')`,
		);
		await recordLiveness(env(), "run1", 9_000, { reason: "decision", ask: { question: "Stopped: the same instruction 3 times", options: [], why: "", field: "Stopped: the same instruction 3 times", taskId: CARD } });
		setSession("ended");
		const r = await answer(CARD, "keep going");
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ ok: false, outcome: "session_ended", delivered: false });
		expect(sent).toEqual([]);
	});

	it("the explicit resume route refuses an ended session instead of calling the runner", async () => {
		await park();
		setSession("ended");
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", codingRoutes);
		app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
		const res = await app.request(`/v1/instances/i1/coding/sessions/${SID}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "yes" }) }, env());
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/has ended/);
		expect(sent).toEqual([]);
	});
});

describe("an answer to a session that is still there is delivered as before (#1185)", () => {
	it("an active session on the same machine: delivered, and the runner is handed the value", async () => {
		ask();
		await park();
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ ok: true, outcome: "delivered", delivered: true, recorded: true, runId: "run1", sessionId: SID });
		expect(sent).toEqual([{ path: `/coding/takeover/${SID}/resolve`, body: { value: "yes" } }]);
		expect(stored()).toMatchObject({ state: "answered_human", decision: "yes" });
	});

	it("a SUSPENDED session is a parked run's normal state (its machine was taken over or its checkout released): still delivered", async () => {
		ask();
		await park();
		setSession("suspended");
		const r = await answer(CARD, "no");
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ ok: true, outcome: "delivered", delivered: true });
		expect(sent).toHaveLength(1);
	});

	it("a session that ended AFTER the answer was delivered does not rewrite what happened", async () => {
		ask();
		await park();
		expect((await answer(CARD, "yes")).body.outcome).toBe("delivered");
		setSession("ended");
		expect(stored()).toMatchObject({ decision: "yes" });
	});
});
