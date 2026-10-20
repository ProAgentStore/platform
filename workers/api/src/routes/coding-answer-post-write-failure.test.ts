/**
 * #1256: the console answer-submit path (`POST /v1/instances/:id/input`) returned a bare 500 even
 * though the answer had already been written to the question's row — a D1 overload that hit the
 * NEXT lookup (`decisionRunForCard`, which run if any is waiting) after `recordAnswer` had already
 * committed the write. A post-write failure must report the degraded step, never erase the write
 * behind a generic error.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { codingCardId } from "../lib/coding-board.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/auth.js")>()),
	requireUser: async () => ({ uid: "u1", roles: [] }),
}));

const { decisionRunForCardMock } = vi.hoisted(() => ({ decisionRunForCardMock: vi.fn() }));
vi.mock("../lib/coding-answer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/coding-answer.js")>()),
	decisionRunForCard: (...a: unknown[]) => decisionRunForCardMock(...a),
}));

const { instanceRoutes } = await import("./instances.js");

const SID = "csess_s1";
const CARD = codingCardId(SID);
let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB }) as unknown as Env;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1', 'u1', 't1256-coder', 'Repo Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'demo')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('${SID}', 'i1', 'r1', 'u1')`);
	d1.exec(
		`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, repo, issue_number, question, options, state, asked_at, expires_at)
		 VALUES ('q1', 'i1', 'u1', '${SID}', NULL, '${CARD}', NULL, NULL, 'Ship it behind a flag?', '["yes","no"]', 'waiting_human', 1, ${Date.now() + 60_000})`,
	);
	decisionRunForCardMock.mockReset();
});
afterEach(() => d1.close());

const row = () => d1.sqlite.prepare("SELECT state, decision, answered_via FROM coder_questions WHERE id = 'q1'").get() as { state: string; decision: string; answered_via: string };

async function answer(taskId: string, value: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/i1/input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, value }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("a post-write failure never turns a persisted answer into a bare 500 (#1256)", () => {
	it("recordAnswer commits; decisionRunForCard then throws — the reply still reports the write, not a 500", async () => {
		decisionRunForCardMock.mockRejectedValue(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."));
		const r = await answer(CARD, "yes");
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ ok: true, kind: "coding", outcome: "stored", delivered: false, recorded: true, questionId: "q1" });
		expect(row()).toMatchObject({ state: "answered_human", decision: "yes", answered_via: "console" });
	});

	it("when recordAnswer itself finds nothing to write, the same failure still propagates (nothing was persisted)", async () => {
		decisionRunForCardMock.mockRejectedValue(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."));
		const r = await answer("no-such-card", "yes");
		expect(r.status).toBe(500);
	});
});
