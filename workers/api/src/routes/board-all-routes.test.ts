/**
 * `GET /v1/board/projection` (#1698): every card of every agent the owner has, in the same four lanes as one agent's board, on the real
 * schema and the real auth. The property the issue asks for: the same card is classified identically in both views, because the
 * All Agents read is the per-instance read.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { readBoardProjection } from "../lib/board-projection.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { boardAllRoutes } from "./board-all-routes.js";
import type { Env } from "../types.js";

const SECRET = "board-all-secret";
const T = 1_800_000_000_000;
let d1: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const session = (id: string, instance: string, user: string) => {
	d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES (${q(`r-${id}`)}, ${q(instance)}, ${q(user)}, ${q(id)})`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES (${q(id)}, ${q(instance)}, ${q(`r-${id}`)}, ${q(user)})`);
};
const run = (id: string, sessionId: string, instance: string, user: string, status: string, wait?: string) =>
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, waiting_reason)
		 VALUES (${q(id)}, ${q(user)}, ${q(instance)}, 'o', ${q(status)}, 10, ${T}, ${q(sessionId)}, ${wait ? q(wait) : "NULL"})`,
	);
const task = (id: string, instance: string, user: string, status: string) =>
	d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES (${q(id)}, ${q(instance)}, ${q(user)}, 'browser.task', ${q(status)}, '{"title":"T"}', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["a1", "a2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["b1"] });
	session("s-a1", "a1", "u1");
	run("r-a1", "s-a1", "a1", "u1", "running", "human");
	session("s-a2", "a2", "u1");
	run("r-a2", "s-a2", "a2", "u1", "completed");
	task("t-a2", "a2", "u1", "queued");
	session("s-b1", "b1", "u2");
	run("r-b1", "s-b1", "b1", "u2", "running");
	env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env;
	app = new Hono<{ Bindings: Env }>();
	app.route("/v1", boardAllRoutes);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: (err as Error).message }, 500)));
});
afterEach(() => d1.close());

const get = async (user: string | null) => app.request("/v1/board/projection", { headers: user ? { Authorization: `Bearer ${await signSession(user, SECRET, { roles: ["user"] })}` } : {} }, env);
type Body = { lanes: Array<{ id: string }>; agents: Array<{ instanceId: string; name: string | null; cards: Array<{ cardId: string; lane: string; needsYou: boolean }> }>; truncated: boolean };

describe("GET /v1/board/projection", () => {
	it("returns the four lanes and every one of the owner's agents with its cards", async () => {
		const res = await get("u1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Body;
		expect(body.lanes.map((l) => l.id)).toEqual(["queued", "in_progress", "blocked", "done"]);
		expect(body.truncated).toBe(false);
		expect(body.agents.map((a) => a.instanceId).sort()).toEqual(["a1", "a2"]);
		const cards = Object.fromEntries(body.agents.flatMap((a) => a.cards.map((c) => [c.cardId, c.lane])));
		expect(cards).toEqual({ "csess-s-a1": "blocked", "csess-s-a2": "done", "task:t-a2": "queued" });
	});

	it("classifies every card exactly as that agent's own board does (one rule, two views)", async () => {
		const body = (await (await get("u1")).json()) as Body;
		for (const agent of body.agents) {
			const own = await readBoardProjection(env, agent.instanceId, "u1");
			expect(agent.cards).toEqual(JSON.parse(JSON.stringify(own)));
		}
		const blocked = body.agents.flatMap((a) => a.cards).find((c) => c.cardId === "csess-s-a1");
		expect(blocked).toMatchObject({ lane: "blocked", needsYou: true });
	});

	it("never shows another owner's agents or cards, and never leaks across owners", async () => {
		const mine = (await (await get("u1")).json()) as Body;
		expect(JSON.stringify(mine)).not.toMatch(/b1|s-b1|csess-s-b1/);
		const theirs = (await (await get("u2")).json()) as Body;
		expect(theirs.agents.map((a) => a.instanceId)).toEqual(["b1"]);
		expect(theirs.agents[0].cards.map((c) => c.cardId)).toEqual(["csess-s-b1"]);
	});

	it("an owner with no agents gets empty lanes, not an error", async () => {
		d1.exec(`INSERT INTO users (id, github_login) VALUES ('u3', 'u3')`);
		const body = (await (await get("u3")).json()) as Body;
		expect(body).toMatchObject({ agents: [], truncated: false });
	});

	it("an unauthenticated request is refused", async () => {
		expect([401, 403]).toContain((await get(null)).status);
	});
});
