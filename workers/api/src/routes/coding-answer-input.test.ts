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

async function answer(taskId: string, value: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/i1/input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, value }) }, env());
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

	it("a coding card with nothing waiting says so — not that a browser session is gone", async () => {
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/No question is waiting on that coding session/);
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
