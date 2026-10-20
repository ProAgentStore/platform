/**
 * #960 item 4: `POST /v1/instances/:id/input` routed by run KIND, over the real schema.
 *
 * Before this, every answer went to the runner's BROWSER takeover map (keyed by task), so an answer
 * to a coding question missed and came back 409 "That takeover session is gone (the runner
 * restarted)" — a false statement about a live run. Only the relay is faked; the run record, the
 * session lookup and the routing are real code against the real migrations.
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

describe("an answer reaches the pause it answers (#960)", () => {
	it("a question parked on a coding card is delivered to the CODING takeover, with the value", async () => {
		await park();
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ ok: true, kind: "coding", runId: "run1", sessionId: SID });
		expect(sent).toEqual([{ path: `/coding/takeover/${SID}/resolve`, body: { value: "yes" } }]);
	});

	it("a coding card with no question at all says so — not that a browser session is gone", async () => {
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/No question was asked on that coding session/);
		expect(r.body.next).toBe("reread"); // #1243: what to do next, as a field
		expect(r.body.error).not.toMatch(/runner restarted/);
		expect(sent).toEqual([]);
	});

	it("an answer for another card does not resolve this run's question", async () => {
		await park();
		const r = await answer(codingCardId("csess_other"), "yes");
		expect(r.status).toBe(409);
		expect(sent).toEqual([]);
	});

	it("a cleared park is no longer answerable — the run record is the proof, not the runner's ok", async () => {
		await park();
		await recordLiveness(env(), "run1", 3_000, null);
		expect((await answer(CARD, "yes")).status).toBe(409);
		expect(sent).toEqual([]);
	});

	it("a runner that cannot be reached fails loudly rather than reporting the answer landed", async () => {
		await park();
		getRunnerConn.mockImplementation(async () => null);
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/still waiting for your answer/);
	});

	it("anything else still goes to the browser handoff, as before", async () => {
		await park();
		const r = await answer("apply-task-1", "0412 345 678");
		expect(r.status).toBe(200);
		expect(sent).toEqual([{ path: "/browser/input", body: { taskId: "apply-task-1", value: "0412 345 678" } }]);
	});
});

describe("an answer that arrives after the run stopped waiting is kept, not dropped (#1074)", () => {
	/** The live shape of run 42f65d22: the question was asked on an issue, and its 15-minute wait ran out. */
	const expired = (issue: number | null = 1013) =>
		d1.exec(
			`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, repo, issue_number, question, state, asked_at, expires_at)
			 VALUES ('q1', 'i1', 'u1', '${SID}', 'run1', '${CARD}', ${issue ? "'ProAgentStore/platform'" : "NULL"}, ${issue ?? "NULL"}, 'Allow an owner assertion to stand in for proof?', 'expired', 1, 2)`,
		);
	const row = () => d1.sqlite.prepare("SELECT state, answered_by, decision, history FROM coder_questions WHERE id = 'q1'").get() as { state: string; answered_by: string | null; decision: string | null; history: string };
	beforeEach(() => {
		posted.length = 0;
	});

	it("records the answer on the expired question, posts it under the question on its issue, and says it was not delivered", async () => {
		expired();
		const r = await answer(CARD, "YES — allow it");
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ ok: true, kind: "coding_late", delivered: false, recorded: true, questionId: "q1", postedToIssue: 1013 });
		expect(r.body.message).toMatch(/not delivered.*posted on issue #1013/);
		expect(row()).toMatchObject({ state: "expired", answered_by: "human", decision: "YES — allow it" });
		expect(JSON.parse(row().history).at(-1)).toMatchObject({ from: "expired", to: "expired", note: "answered by a person (console) after the run stopped waiting" });
		expect(posted).toEqual([{ repo: "ProAgentStore/platform", issue: 1013, body: expect.stringContaining("> YES — allow it") }]);
		expect(posted[0].body).toMatch(/Answer received after the run stopped waiting/);
		// Nothing reached a runner: the run is gone.
		expect(sent).toEqual([]);
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM agent_events WHERE event = 'coder_question.answered_late'").get()).toEqual({ n: 1 });
	});

	it("redacts a credential-shaped answer before it is stored or posted", async () => {
		expired();
		await answer(CARD, "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
		expect(row().decision).not.toMatch(/sk-ant-api03-abcdefghij/);
		expect(posted[0].body).not.toMatch(/sk-ant-api03-abcdefghij/);
	});

	it("a question asked on no issue is still recorded; nothing is posted", async () => {
		expired(null);
		const r = await answer(CARD, "no");
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ recorded: true, postedToIssue: null });
		expect(posted).toEqual([]);
	});
});


describe("the question's row is the source of truth for an answer (#1075)", () => {
	const ask = (state = "waiting_human", extra = "") =>
		d1.exec(
			`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, repo, issue_number, question, options, state, asked_at, expires_at${extra ? ", applied_at, applied_run_id, answered_by, answered_at, decision" : ""})
			 VALUES ('q1', 'i1', 'u1', '${SID}', 'run1', '${CARD}', 'ProAgentStore/platform', 1075, 'Ship it behind a flag?', '["yes","no"]', '${state}', 1, ${Date.now() + 60_000}${extra})`,
		);
	type Stored = { state: string; answered_by: string | null; answered_via: string | null; answered_at: number | null; applied_at: number | null; applied_run_id: string | null; decision: string | null; history: string };
	const row = () => d1.sqlite.prepare("SELECT state, answered_by, answered_via, answered_at, applied_at, applied_run_id, decision, history FROM coder_questions WHERE id = 'q1'").get() as Stored;
	beforeEach(() => {
		posted.length = 0;
	});

	it("a live waiter: the answer is written to the row FIRST, then delivered, and the reply says delivered", async () => {
		ask();
		await park();
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ ok: true, kind: "coding", outcome: "delivered", delivered: true, recorded: true, questionId: "q1", runId: "run1" });
		expect(row()).toMatchObject({ state: "answered_human", answered_by: "human", answered_via: "console", decision: "yes", applied_at: null });
		expect(row().answered_at).toBeGreaterThan(0);
		expect(sent).toEqual([{ path: `/coding/takeover/${SID}/resolve`, body: { value: "yes" } }]);
	});

	it("a live waiter whose runner can't be reached: the answer is still stored, and the reply says the run reads it from the row", async () => {
		ask();
		await park();
		getRunnerConn.mockImplementation(async () => null);
		const r = await answer(CARD, "no");
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ ok: true, kind: "coding", outcome: "stored", delivered: false, recorded: true, questionId: "q1" });
		expect(r.body.message).toMatch(/reads your answer from the question/);
		expect(row()).toMatchObject({ state: "answered_human", decision: "no" });
	});

	it("an answer sent after the run was cancelled but before the question's expires_at is recorded, not refused with 409", async () => {
		ask(); // still `waiting_human` — the sweep has not reached expires_at
		d1.exec("UPDATE agent_loop_runs SET status = 'cancelled' WHERE run_id = 'run1'");
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ ok: true, kind: "coding_late", recorded: true, delivered: false, questionId: "q1", postedToIssue: 1075 });
		expect(row()).toMatchObject({ state: "answered_human", answered_via: "console", decision: "yes", applied_at: null });
		expect(sent).toEqual([]);
	});

	it("MCP and the console are equal paths: the same row, the same reply, only answered_via differs", async () => {
		ask();
		await park();
		const viaMcp = await answer(CARD, "yes", { "X-PAGS-Client": "mcp" });
		const mcpRow = row();
		d1.exec("DELETE FROM coder_questions");
		ask();
		const viaConsole = await answer(CARD, "yes");
		expect(viaMcp).toEqual(viaConsole);
		expect(mcpRow).toMatchObject({ state: "answered_human", answered_via: "mcp", decision: "yes" });
		expect(row()).toMatchObject({ state: "answered_human", answered_via: "console", decision: "yes" });
	});

	it("a second answer to a decision a run already applied is recorded and reported as already applied — never dropped, never rewriting it", async () => {
		ask("answered_human", ", 5000, 'run1', 'human', 4000, 'yes'");
		await park(); // even with a park on the card, nothing is delivered for an applied decision
		const r = await answer(CARD, "actually no");
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ ok: true, kind: "coding", outcome: "already_applied", recorded: true, delivered: false, questionId: "q1", appliedRunId: "run1" });
		expect(row()).toMatchObject({ state: "answered_human", decision: "yes", applied_at: 5000, applied_run_id: "run1" });
		expect(JSON.parse(row().history).at(-1).note).toMatch(/answered again via console after run run1 used the earlier answer; recorded, not applied: actually no/);
		expect(sent).toEqual([]);
	});

	it("an applied question with a NEWER park on the card goes to the run that is waiting, not to the history (#1234)", async () => {
		// Run 75a17626: the version-bump question was applied at 07:12, the run parked again at 08:06 with no row of its
		// own, and the owner's answer came back `already_applied` — recorded on the old question, delivered to nothing.
		ask("answered_human", ", 5000, 'run1', 'human', 4000, 'yes'");
		await recordLiveness(env(), "run1", 9_000, { reason: "decision", ask: { question: "Stopped: the same instruction 3 times", options: [], why: "", field: "Stopped: the same instruction 3 times", taskId: CARD } });
		const r = await answer(CARD, "make the call yourself and keep going");
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ ok: true, kind: "coding", outcome: "delivered", delivered: true, runId: "run1" });
		expect(sent).toEqual([{ path: `/coding/takeover/${SID}/resolve`, body: { value: "make the call yourself and keep going" } }]);

		// …and a delivery that cannot reach the runner is said as one, never as delivered.
		getRunnerConn.mockImplementation(async () => null);
		getBoundRunnerConn.mockImplementation(async () => null);
		const down = await answer(CARD, "again");
		expect(down.status).toBe(409);
		expect(down.body).toMatchObject({ ok: false, outcome: "not_delivered", delivered: false, next: "retry" });
	});

	it("an owner may revise an answer no run has used yet; the row holds the latest", async () => {
		ask();
		d1.exec("UPDATE agent_loop_runs SET status = 'cancelled' WHERE run_id = 'run1'");
		await answer(CARD, "yes");
		await answer(CARD, "no");
		expect(row()).toMatchObject({ state: "answered_human", decision: "no", applied_at: null });
		expect(JSON.parse(row().history).at(-1).note).toMatch(/answer revised by a person \(console\) before any run used it/);
	});

	it("an answer days after the question expired is stored on its row and readable through GET coder-questions (MCP coder_questions)", async () => {
		ask("expired");
		const days = Date.now() + 3 * 24 * 60 * 60_000;
		vi.useFakeTimers({ now: days, toFake: ["Date"] });
		try {
			expect((await answer(CARD, "drop it")).status).toBe(202);
		} finally {
			vi.useRealTimers();
		}
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", instanceRoutes);
		const res = await app.request("/v1/instances/i1/coder-questions", {}, env());
		const { questions } = (await res.json()) as { questions: Array<Record<string, unknown>> };
		expect(questions[0]).toMatchObject({ id: "q1", state: "expired", answeredBy: "human", answeredVia: "console", answeredAt: days, decision: "drop it", appliedAt: null });
	});
});
