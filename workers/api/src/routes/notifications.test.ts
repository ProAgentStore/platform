/**
 * The notification feed's read/mark contract, executed against real SQLite (#613).
 *
 * `POST /:id/read` used to answer `{success:true}` for any id at all. The console only ever marks an
 * id it has just listed, so nothing noticed; `mark_notification_read` over MCP takes the id from a
 * model, where a success for an id that matched nothing is a false report that something was cleared.
 * The SQL runs for real here because the claim turns on what D1 reports as `changes` — in particular
 * that re-marking an already-read row still counts as a match, so it is not refused.
 */
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { signSession } from "../lib/session.js";
import { notificationRoutes } from "./notifications.js";
import type { Env } from "../types.js";

const TEST_SECRET = "test-secret";

function testApp() {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE notifications (
		id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT, title TEXT, body TEXT,
		read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
	const insert = db.prepare("INSERT INTO notifications (id, user_id, type, title, body, read, created_at) VALUES (?, ?, 'loop', 't', 'b', ?, ?)");
	insert.run("n-mine-unread", "user-1", 0, "2026-09-13 01:00:00");
	insert.run("n-mine-read", "user-1", 1, "2026-09-13 02:00:00");
	insert.run("n-theirs", "user-2", 0, "2026-09-13 03:00:00");

	// A D1-shaped adapter: `run` reports `meta.changes` the way D1 does.
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		DB: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => ({
					all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
					first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
					run: async () => {
						const r = db.prepare(sql).run(...(args as never[]));
						return { success: true, meta: { changes: Number(r.changes) } };
					},
				}),
			}),
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/notifications", notificationRoutes);
	const readFlag = (id: string) => (db.prepare("SELECT read FROM notifications WHERE id = ?").get(id) as { read: number }).read;
	return { app, env, readFlag };
}

async function call(t: ReturnType<typeof testApp>, path: string, method = "GET") {
	const token = await signSession("user-1", TEST_SECRET);
	return t.app.request(`/v1/notifications${path}`, { method, headers: { Authorization: `Bearer ${token}` } }, t.env);
}

describe("POST /v1/notifications/:id/read", () => {
	it("marks the caller's own notification read", async () => {
		const t = testApp();
		const res = await call(t, "/n-mine-unread/read", "POST");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(t.readFlag("n-mine-unread")).toBe(1);
	});

	it("is still a 200 for a notification that was already read — a match, not a miss", async () => {
		const res = await call(testApp(), "/n-mine-read/read", "POST");
		expect(res.status).toBe(200);
	});

	it("refuses an id that matches nothing, instead of reporting success", async () => {
		const res = await call(testApp(), "/no-such-id/read", "POST");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Notification not found" });
	});

	it("refuses another user's notification, and leaves it unread", async () => {
		const t = testApp();
		const res = await call(t, "/n-theirs/read", "POST");
		expect(res.status).toBe(404);
		expect(t.readFlag("n-theirs")).toBe(0);
	});
});

describe("the rest of the feed, as the MCP tools read it", () => {
	it("lists only the caller's notifications, newest first, with an unread count", async () => {
		const res = await call(testApp(), "");
		const body = (await res.json()) as { notifications: Array<{ id: string }>; unreadCount: number };
		expect(body.notifications.map((n) => n.id)).toEqual(["n-mine-read", "n-mine-unread"]);
		expect(body.unreadCount).toBe(1);
	});

	it("read-all clears only the caller's unread notifications", async () => {
		const t = testApp();
		const res = await call(t, "/read-all", "POST");
		expect(res.status).toBe(200);
		expect(t.readFlag("n-mine-unread")).toBe(1);
		expect(t.readFlag("n-theirs")).toBe(0);
	});
});
