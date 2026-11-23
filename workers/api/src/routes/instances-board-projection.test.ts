/**
 * `GET /v1/instances/:instanceId/board/projection` (#1698), driven through the real route and auth against the real schema: the owner
 * reads their cards in the four lanes, and anyone else is refused before any card is read.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { registerBoardProjectionRoutes } from "./board-projection-routes.js";
import type { Env } from "../types.js";

const SECRET = "board-projection-secret";
let d1: RealSchemaD1;
let app: Hono<{ Bindings: Env }>;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "owner-1", instanceIds: ["inst-1"] });
	seedTenant(d1, { userId: "owner-2", instanceIds: ["inst-2"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'inst-1', 'owner-1', 'app'), ('r2', 'inst-2', 'owner-2', 'other')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('mine', 'inst-1', 'r1', 'owner-1'), ('theirs', 'inst-2', 'r2', 'owner-2')`);
	d1.exec(
		`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('e1', 'inst-1', 'r1', 'owner-1', 'Add a health check', 'pending', 1)`,
	);
	env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env;
	app = new Hono<{ Bindings: Env }>();
	const router = new Hono<{ Bindings: Env }>();
	registerBoardProjectionRoutes(router);
	app.route("/v1/instances", router);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: (err as Error).message }, 500)));
});
afterEach(() => d1.close());

const get = async (instanceId: string, user: string | null) => {
	const headers: Record<string, string> = user ? { Authorization: `Bearer ${await signSession(user, SECRET, { roles: ["user"] })}` } : {};
	return app.request(`/v1/instances/${instanceId}/board/projection`, { headers }, env);
};

describe("GET /board/projection", () => {
	it("returns the four lanes and the owner's cards, each classified", async () => {
		const res = await get("inst-1", "owner-1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { lanes: Array<{ id: string; title: string }>; cards: Array<{ cardId: string; lane: string; kind: string }> };
		expect(body.lanes).toEqual([
			{ id: "queued", title: "Queued" },
			{ id: "in_progress", title: "In Progress" },
			{ id: "blocked", title: "Blocked" },
			{ id: "done", title: "Done" },
		]);
		expect(body.cards.map((c) => [c.cardId, c.kind, c.lane]).sort()).toEqual([
			["csess-mine", "coding-session", "in_progress"],
			["objective:e1", "queued-objective", "queued"],
		]);
	});

	it("a signed-in user who does not own the instance gets a 404 and none of its cards", async () => {
		const res = await get("inst-1", "owner-2");
		expect(res.status).toBe(404);
		expect(JSON.stringify(await res.json())).not.toMatch(/csess-|objective:/);
	});

	it("each owner sees only their own instance's cards", async () => {
		const theirs = (await (await get("inst-2", "owner-2")).json()) as { cards: Array<{ cardId: string }> };
		expect(theirs.cards.map((c) => c.cardId)).toEqual(["csess-theirs"]);
	});

	it("an unauthenticated request is refused", async () => {
		expect([401, 403]).toContain((await get("inst-1", null)).status);
	});
});
