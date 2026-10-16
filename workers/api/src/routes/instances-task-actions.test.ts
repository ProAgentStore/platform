/**
 * #1108 — `GET /v1/instances/:id/tasks/:taskId/actions` over the real schema and the real router:
 * the owner reads a card's log, a forged cursor is 400, and another owner's card is 404.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const who = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: who.uid, roles: [] }) };
});
const { instanceRoutes } = await import("./instances.js");
const { writeActionEntry } = await import("../lib/task-action-log.js");

let d1: RealSchemaD1;
beforeEach(() => {
	who.uid = "u1";
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES ('csess-1', 'i1', 'u1', 'coding.session', 'running', '{}', datetime('now'), datetime('now'))`);
});
afterEach(() => d1.close());

async function get(path: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, {}, { DB: d1.DB } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("GET /v1/instances/:id/tasks/:taskId/actions (#1108)", () => {
	it("the owner reads the card's log; a forged cursor is 400; another owner is 404", async () => {
		await writeActionEntry({ DB: d1.DB }, { instanceId: "i1", userId: "u1", taskId: "csess-1", actor: "coding-engine", actionType: "checkpoint", summary: "Coding run started", status: "running" });
		const ok = await get("/v1/instances/i1/tasks/csess-1/actions?limit=5");
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ taskId: "csess-1", total: 1, hasMore: false, entries: [{ actor: "coding-engine", summary: "Coding run started" }] });
		expect((await get("/v1/instances/i1/tasks/csess-1/actions?cursor=bogus")).status).toBe(400);
		who.uid = "u2";
		expect((await get("/v1/instances/i1/tasks/csess-1/actions")).status).toBe(404);
	});
});
