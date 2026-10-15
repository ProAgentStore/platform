/**
 * #1090 — the retained error, trace and admin-audit history is reachable whole, in stable pages,
 * by the right people only.
 *
 * Driven through the real routes against the real migrated schema (`d1-sqlite.ts`). Every
 * "complete" assertion compares the walk with the rows the table actually holds, so a fixture too
 * small to page (G1) or a walk that silently stops early fails here rather than passing.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { logError, resetServerBuildForTests } from "../lib/error-log.js";
import { fakeKv } from "../lib/kv-fake.js";
import type { Env } from "../types.js";

const auth = vi.hoisted(() => ({ uid: "u1", roles: [] as string[] }));
vi.mock("../lib/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth.js")>();
	const session = () => ({ uid: auth.uid, roles: auth.roles });
	return {
		...actual,
		requireUser: async () => session(),
		// The real role check (`isAdmin`: role, allowlist, users row) on the mocked session — `requireAdmin`
		// calls the module-internal `requireUser`, which the mock above cannot reach.
		requireAdmin: async (c: Parameters<typeof actual.isAdmin>[0]) => {
			if (!(await actual.isAdmin(c, session() as never))) throw new actual.HttpError(403, "Admin access required");
			return session();
		},
	};
});
const { HttpError } = await import("../lib/auth.js");
const { registerTraceRoutes } = await import("./instances-trace.js");
const { errorRoutes } = await import("./errors.js");
const { auditRoutes } = await import("./audit.js");

let d1: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["iA"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["iZ"] });
	env = { DB: d1.DB, OAUTH_KV: fakeKv().kv } as unknown as Env;
	auth.uid = "u1";
	auth.roles = [];
	resetServerBuildForTests();
	vi.spyOn(Math, "random").mockReturnValue(0.5); // no opportunistic prune mid-test
	const instances = new Hono<{ Bindings: Env }>();
	registerTraceRoutes(instances);
	app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instances);
	app.route("/v1/errors", errorRoutes);
	app.route("/v1/audit", auditRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 403) : c.json({ error: String(e) }, 500)));
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
	resetServerBuildForTests();
});

const get = async (path: string) => {
	const res = await app.request(path, {}, env);
	// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON reply fields
	return { status: res.status, body: (await res.json()) as Record<string, any> };
};

/** Insert trace events directly — `count` of them, two per millisecond so `(ts, id)` ties are exercised. */
function seedEvents(count: number, opts: { from?: number; instanceId?: string; userId?: string; prefix?: string } = {}) {
	const insert = d1.sqlite.prepare(
		"INSERT INTO agent_events (id, ts, user_id, instance_id, source, level, event, message) VALUES (?, ?, ?, ?, 'chat', ?, 'chat.in', ?)",
	);
	const from = opts.from ?? 1_700_000_000_000;
	for (let i = 0; i < count; i++) {
		insert.run(`${opts.prefix ?? "e"}-${String(i).padStart(5, "0")}`, from + Math.floor(i / 2), opts.userId ?? "u1", opts.instanceId ?? "iA", i % 3 ? "info" : "warn", `m${i}`);
	}
}

const tableIds = (sql: string) => (d1.sqlite.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);

/** Walk a cursor endpoint to its end; returns every id delivered, in order, and the page count. */
async function walk(path: (cursor: string) => string, key: string, between?: (page: number) => void, start = "newest") {
	const ids: string[] = [];
	let cursor = start;
	let pages = 0;
	for (; pages < 100; pages++) {
		const { status, body } = await get(path(cursor));
		expect(status).toBe(200);
		ids.push(...(body[key] as Array<{ id: string }>).map((r) => r.id));
		if (!body.nextCursor) break;
		expect(body.hasMore).toBe(true);
		cursor = body.nextCursor;
		between?.(pages);
	}
	return { ids, pages: pages + 1 };
}

describe("the trace beyond its 1000-event window (#1090)", () => {
	it("the legacy window still stops at 1000 — the gap this walk closes", async () => {
		seedEvents(1203);
		const { body } = await get("/v1/instances/iA/trace?limit=5000");
		expect(body.count).toBe(1000);
		// The ~200 oldest are unreachable through the window at any limit.
		expect(body.events.some((e: { id: string }) => e.id === "e-00000")).toBe(false);
	});

	it("walks all 1203 retained events newest-first, with no gap and no repeat", async () => {
		seedEvents(1203);
		const { ids, pages } = await walk((c) => `/v1/instances/iA/trace?cursor=${c}&limit=500`, "events");
		expect(pages).toBe(3);
		expect(ids).toHaveLength(1203);
		expect(new Set(ids).size).toBe(1203);
		expect(ids).toEqual(tableIds("SELECT id FROM agent_events ORDER BY ts DESC, id DESC"));
	});

	it("events written DURING the walk never shift it: exactly the rows that existed at its start", async () => {
		seedEvents(600);
		const before = tableIds("SELECT id FROM agent_events ORDER BY ts DESC, id DESC");
		const { ids } = await walk(
			(c) => `/v1/instances/iA/trace?cursor=${c}&limit=100`,
			"events",
			(page) => seedEvents(25, { from: 1_800_000_000_000 + page * 100, prefix: `late${page}` }),
		);
		expect(ids).toEqual(before);
	});

	it("a page boundary row pruned mid-walk (expiry) neither stops nor repeats the walk", async () => {
		seedEvents(300);
		const first = await get("/v1/instances/iA/trace?cursor=newest&limit=100");
		const boundary = first.body.events[99].id;
		// Retention prunes the boundary row and everything newer than it on the next page's side.
		d1.sqlite.prepare("DELETE FROM agent_events WHERE id = ? OR id IN ('e-00199', 'e-00198')").run(boundary);
		const rest = await walk((c) => `/v1/instances/iA/trace?cursor=${c}&limit=100`, "events", undefined, first.body.nextCursor);
		const all = [...first.body.events.map((e: { id: string }) => e.id), ...rest.ids];
		expect(new Set(all).size).toBe(all.length);
		expect(rest.ids).toEqual(tableIds("SELECT id FROM agent_events ORDER BY ts DESC, id DESC").slice(99));
		expect(first.body.coverage.retention).toMatchObject({ days: 14 });
	});

	it("since/until bound the walk; the level floor still applies", async () => {
		seedEvents(100);
		const { body } = await get(`/v1/instances/iA/trace?since=${1_700_000_000_010}&until=${1_700_000_000_019}&level=warn`);
		expect(body.events.map((e: { ts: number }) => e.ts).every((t: number) => t >= 1_700_000_000_010 && t <= 1_700_000_000_019)).toBe(true);
		expect(body.events.every((e: { level: string }) => e.level === "warn")).toBe(true);
		expect(body.events.length).toBeGreaterThan(0);
	});

	it("refuses a cursor it did not issue, and an unparseable time, rather than starting over", async () => {
		expect((await get("/v1/instances/iA/trace?cursor=bogus")).status).toBe(400);
		expect((await get("/v1/instances/iA/trace?cursor=newest&since=yesterday")).status).toBe(400);
	});

	it("a storage read failure is a 503 naming it, never an empty page", async () => {
		seedEvents(5);
		const prepare = env.DB.prepare.bind(env.DB);
		env.DB.prepare = ((sql: string) => {
			if (sql.includes("FROM agent_events")) throw new Error("D1_ERROR: storage unavailable");
			return prepare(sql);
		}) as typeof env.DB.prepare;
		const { status, body } = await get("/v1/instances/iA/trace?cursor=newest");
		expect(status).toBe(503);
		expect(body.events).toBeNull();
		expect(body.error).toContain("storage unavailable");
	});
});

describe("tenant and admin boundaries (#1090)", () => {
	it("another owner's trace is not found, and scope=all does not widen it for a non-admin", async () => {
		seedEvents(5, { instanceId: "iZ", userId: "u2" });
		expect((await get("/v1/instances/iZ/trace?cursor=newest")).status).toBe(404);
		expect((await get("/v1/instances/iZ/trace?cursor=newest&scope=all")).status).toBe(404);
	});

	it("an admin may read another owner's trace with scope=all, and sees the replay backlog", async () => {
		seedEvents(5, { instanceId: "iZ", userId: "u2" });
		auth.roles = ["admin"];
		const { status, body } = await get("/v1/instances/iZ/trace?cursor=newest&scope=all");
		expect(status).toBe(200);
		expect(body.scope).toBe("all");
		expect(body.count).toBe(5);
		expect(body.coverage.delivery).toMatchObject({ sink: "agent_events", pending: 0 });
	});

	it("a non-admin is told the backlog is not visible to them — not shown a zero", async () => {
		seedEvents(5);
		const { body } = await get("/v1/instances/iA/trace?cursor=newest");
		expect(body.coverage.delivery).toEqual(expect.objectContaining({ visible: false }));
	});

	it("both admin audit readers refuse a non-admin", async () => {
		expect((await get("/v1/audit/mcp")).status).toBe(403);
		expect((await get("/v1/audit/admin-actions")).status).toBe(403);
	});
});

describe("the error log walk (#1090)", () => {
	const fail = (i: number, extra: Record<string, unknown> = {}) =>
		logError(env, { source: "pipeline-step", message: `failure ${i}`, userId: "u1", context: { instanceId: "iA" }, ...extra });

	it("repeats folding into rows DURING the walk cannot move a row past the cursor", async () => {
		for (let i = 0; i < 60; i++) {
			await fail(i);
			d1.sqlite.prepare("UPDATE error_log SET created_at = datetime('now', ?) WHERE message = ?").run(`-${60 - i} minutes`, `failure ${i}`);
		}
		const before = tableIds("SELECT id FROM error_log ORDER BY created_at DESC, id DESC");
		// Each page, re-fire the OLDEST failures: their last_seen jumps to now, which would reorder a
		// recency walk. A first-seen walk is unmoved.
		const { ids } = await walk(
			(c) => `/v1/errors?cursor=${c}&limit=20`,
			"errors",
			(page) => {
				for (let i = page * 5; i < page * 5 + 5; i++) d1.sqlite.prepare("UPDATE error_log SET last_seen_at = datetime('now'), repeat_count = repeat_count + 1 WHERE message = ?").run(`failure ${i}`);
			},
		);
		expect(ids).toEqual(before);
	});

	it("filters by level, build and time on the walk", async () => {
		await fail(1, { level: "warn" });
		await fail(2);
		d1.sqlite.prepare("UPDATE error_log SET build = 'abc123' WHERE message = 'failure 2'").run();
		expect((await get("/v1/errors?cursor=newest&level=warn")).body.errors.map((e: { message: string }) => e.message)).toEqual(["failure 1"]);
		expect((await get("/v1/errors?cursor=newest&build=abc123")).body.errors.map((e: { message: string }) => e.message)).toEqual(["failure 2"]);
		expect((await get(`/v1/errors?cursor=newest&since=${Date.now() + 3_600_000}`)).body.count).toBe(0);
		expect((await get("/v1/errors?cursor=newest")).body.coverage.retention).toMatchObject({ days: 30 });
	});

	it("scope=all is ignored for a non-admin on the walk and on the summary", async () => {
		await fail(1);
		await logError(env, { source: "x", message: "theirs", userId: "u2" });
		expect((await get("/v1/errors?cursor=newest&scope=all")).body.errors.map((e: { message: string }) => e.message)).toEqual(["failure 1"]);
		const summary = await get("/v1/errors/summary?scope=all");
		expect(summary.body.scope).toBe("me");
		expect(summary.body.total).toBe(1);
	});

	it("an admin's summary groups every account, and a truncated window says how far it reached", async () => {
		await fail(1);
		await logError(env, { source: "x", message: "theirs", userId: "u2" });
		auth.roles = ["admin"];
		const all = await get("/v1/errors/summary?scope=all");
		expect(all.body.scope).toBe("all");
		expect(all.body.total).toBe(2);
		const cut = await get("/v1/errors/summary?scope=all&limit=1");
		expect(cut.body.truncated).toBe(true);
		expect(cut.body.window.oldestRead).toBeTruthy();
	});
});

describe("the admin-action audit walk (#1090)", () => {
	function seedAudit(n: number) {
		const insert = d1.sqlite.prepare(
			"INSERT INTO admin_audit_log (id, created_at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'admin-1', ?, 'user', ?, ?)",
		);
		for (let i = 0; i < n; i++) {
			insert.run(`a-${String(i).padStart(4, "0")}`, `2026-10-0${1 + (i % 9)} 00:00:00`, i % 2 ? "user.suspend" : "user.roles", `u${i}`, JSON.stringify({ reason: "r", api_key: "sk-live-abcdefghijklmnopqrstuvwxyz0123" }));
		}
	}

	it("walks the whole log past the old 500-row reader cap, newest first", async () => {
		seedAudit(640);
		auth.roles = ["admin"];
		const { ids, pages } = await walk((c) => `/v1/audit/admin-actions?cursor=${c}&limit=200`, "audit");
		expect(pages).toBe(4);
		expect(ids).toEqual(tableIds("SELECT id FROM admin_audit_log ORDER BY created_at DESC, id DESC"));
	});

	it("redacts secrets in `detail` on read, and filters by action", async () => {
		seedAudit(4);
		auth.roles = ["admin"];
		const { body } = await get("/v1/audit/admin-actions?action=user.suspend");
		expect(body.audit).toHaveLength(2);
		expect(JSON.stringify(body.audit)).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123");
		expect(body.audit[0].detail.reason).toBe("r");
		expect(body.coverage.retention.days).toBeNull();
	});
});
