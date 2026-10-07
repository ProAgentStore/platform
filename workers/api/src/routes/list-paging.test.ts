/**
 * Newest-N lists say when there is more, and reach it (#898). `list_errors`, `list_notifications`
 * and the trigger list each returned a fixed window with nothing saying the rest existed.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { errorRoutes } = await import("./errors.js");
const { notificationRoutes } = await import("./notifications.js");

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
});
afterEach(() => d1.close());

const get = async (mount: string, routes: Hono<{ Bindings: Env }>, path: string) => {
	const app = new Hono<{ Bindings: Env }>();
	app.route(mount, routes);
	const res = await app.request(path, {}, { DB: d1.DB } as unknown as Env);
	expect(res.status).toBe(200);
	return (await res.json()) as Record<string, unknown>;
};

describe("list_errors pages", () => {
	it("says hasMore on a full page and reaches the next one", async () => {
		for (let i = 0; i < 5; i++) {
			d1.exec(`INSERT INTO error_log (id, created_at, user_id, source, message, level) VALUES ('e${i}', ${1_000 + i}, 'u1', 's', 'm${i}', 'error')`);
		}
		const first = await get("/v1/errors", errorRoutes, "/v1/errors?limit=3");
		expect(first).toMatchObject({ count: 3, hasMore: true, nextOffset: 3 });
		const second = await get("/v1/errors", errorRoutes, "/v1/errors?limit=3&offset=3");
		expect(second).toMatchObject({ count: 2, hasMore: false, nextOffset: null });
		expect((second.errors as Array<{ message: string }>).map((e) => e.message)).toEqual(["m1", "m0"]);
	});
});

describe("list_notifications pages", () => {
	it("says hasMore on a full page", async () => {
		for (let i = 0; i < 4; i++) {
			d1.exec(`INSERT INTO notifications (id, user_id, type, title, created_at) VALUES ('n${i}', 'u1', 'system', 't${i}', '2026-10-07 00:00:0${i}')`);
		}
		expect(await get("/v1/notifications", notificationRoutes, "/v1/notifications?limit=3")).toMatchObject({ hasMore: true, nextOffset: 3 });
		const rest = await get("/v1/notifications", notificationRoutes, "/v1/notifications?limit=3&offset=3");
		expect(rest).toMatchObject({ hasMore: false });
		expect((rest.notifications as unknown[]).length).toBe(1);
	});
});
