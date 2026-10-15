/**
 * #1084 — telemetry its primary store refused is spooled, replayed, and accounted for.
 *
 * Driven through the real writers (`logError`, `logEvent`, `recordAdminAction`) against the real
 * schema (`d1-sqlite.ts`) and KV as it behaves (`kv-fake.ts`). The outage is injected at the D1
 * boundary; every assertion reads the TABLE, so "no duplicate facts" is a row count, not a mock call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const auth = vi.hoisted(() => ({ session: null as null | { uid: string; roles: string[] } }));
vi.mock("./auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./auth.js")>();
	return {
		...actual,
		requireUser: async () => {
			if (!auth.session) throw new actual.HttpError(401, "Sign in");
			return auth.session;
		},
	};
});
const { errorRoutes } = await import("../routes/errors.js");
import { recordAdminAction } from "./admin.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { logError } from "./error-log.js";
import { logEvent } from "./events.js";
import { fakeKv } from "./kv-fake.js";
import { readAuditCoverage } from "./mcp-audit-ledger.js";
import { BACKOFF_MS, MAX_ATTEMPTS, MAX_SPOOL_PER_SINK, drainTelemetrySpool, spoolTelemetry, telemetryDelivery } from "./telemetry-spool.js";
import type { Env, SessionPayload } from "../types.js";

let d1: RealSchemaD1;
let kv: ReturnType<typeof fakeKv>;
let down = false;
let env: Pick<Env, "DB" | "OAUTH_KV">;

beforeEach(() => {
	d1 = realSchemaD1();
	kv = fakeKv();
	down = false;
	auth.session = null;
	// D1 that refuses every statement while `down` — the outage, at the boundary the writers use.
	const DB = new Proxy(d1.DB, {
		get(target, prop) {
			if (prop === "prepare" && down) {
				return () => {
					throw new Error("D1_ERROR: storage unavailable");
				};
			}
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	env = { DB, OAUTH_KV: kv.kv };
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
});

const rows = (table: string) => d1.sqlite.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
const spooled = (sink: string) => [...kv.data.keys()].filter((k) => k.startsWith(`tel_spool:${sink}:`));
const later = (ms: number) => Date.now() + ms;
const actor = { uid: "admin-1", roles: ["admin"] } as unknown as SessionPayload;

describe("a D1 outage no longer drops telemetry (#1084)", () => {
	it("spools a refused error row and replays it into the log — same id, same time, once", async () => {
		down = true;
		expect(await logError(env, { source: "auth", message: "token exchange failed", status: 502, userId: "u1" })).toBe("queued");
		expect(spooled("error_log")).toHaveLength(1);
		down = false;
		expect(rows("error_log")).toHaveLength(0);

		const stats = await drainTelemetrySpool(env, later(BACKOFF_MS[0]));
		expect(stats).toMatchObject({ delivered: 1, retrying: 0, dead: 0 });
		const [row] = rows("error_log");
		expect(row).toMatchObject({ source: "auth", message: "token exchange failed", status: 502, user_id: "u1", level: "error" });
		const record = JSON.parse(kv.data.get(`tel_dead:error_log:${row.id}`)?.value ?? "null");
		expect(record).toBeNull();
		expect(spooled("error_log")).toHaveLength(0);
		// The row is dated when it HAPPENED, not when it was replayed.
		expect(row.created_at).toBe(row.last_seen_at);
	});

	it("is not retried before it is due", async () => {
		down = true;
		await logEvent(env, { source: "chat", event: "chat.in", instanceId: "i1" });
		down = false;
		expect(await drainTelemetrySpool(env, Date.now())).toMatchObject({ delivered: 0 });
		expect(rows("agent_events")).toHaveLength(0);
		expect(await drainTelemetrySpool(env, later(BACKOFF_MS[0]))).toMatchObject({ delivered: 1 });
		expect(rows("agent_events")).toHaveLength(1);
	});

	it("repeated delivery writes no second fact — a replay after a lost response, and two ticks", async () => {
		down = true;
		await logEvent(env, { id: "act:s1:42", source: "coding", event: "engine.act", message: "merged a pull request" });
		down = false;
		// The original write DID land before its response was lost: the row exists AND is spooled.
		await logEvent(env, { id: "act:s1:42", source: "coding", event: "engine.act", message: "merged a pull request" });
		await drainTelemetrySpool(env, later(BACKOFF_MS[0]));
		await drainTelemetrySpool(env, later(BACKOFF_MS[0] * 2));
		expect(rows("agent_events").filter((r) => r.id === "act:s1:42")).toHaveLength(1);
		expect(spooled("agent_events")).toHaveLength(0);
	});

	it("an admin action is still audited when D1 refuses the audit row", async () => {
		down = true;
		expect(await recordAdminAction(env, actor, "user.suspend", { type: "user", id: "u9" }, { reason: "abuse" })).toBe("queued");
		down = false;
		await drainTelemetrySpool(env, later(BACKOFF_MS[0]));
		expect(rows("admin_audit_log")).toEqual([expect.objectContaining({ actor_user_id: "admin-1", action: "user.suspend", target_type: "user", target_id: "u9", detail: '{"reason":"abuse"}' })]);
	});

	it("backs off on every failed replay, then declares it DEAD — kept, counted, never silently dropped", async () => {
		down = true;
		await logError(env, { source: "x", message: "y" });
		let t = Date.now();
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			t += BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
			const stats = await drainTelemetrySpool(env, t);
			expect(stats).toMatchObject(attempt < MAX_ATTEMPTS ? { retrying: 1, dead: 0 } : { retrying: 0, dead: 1 });
			// Not due again until the next backoff step: an immediate second tick does nothing.
			if (attempt < MAX_ATTEMPTS) expect(await drainTelemetrySpool(env, t + 1)).toMatchObject({ retrying: 0, delivered: 0 });
		}
		expect(spooled("error_log")).toHaveLength(0);
		const health = await telemetryDelivery(env);
		expect(health.complete).toBe(false);
		expect(health.sinks.find((s) => s.sink === "error_log")).toMatchObject({ pending: 0, dead: 1, lost: 0 });
		const dead = JSON.parse([...kv.data.entries()].find(([k]) => k.startsWith("tel_dead:error_log:"))?.[1].value ?? "{}");
		expect(dead).toMatchObject({ attempts: MAX_ATTEMPTS, lastError: "Error", payload: { message: "y" } });
	});

	it("never logs through itself: a drain during the outage spools nothing new", async () => {
		down = true;
		await logError(env, { source: "x", message: "y" });
		const before = [...kv.data.keys()].filter((k) => k.startsWith("tel_spool:")).sort();
		await drainTelemetrySpool(env, later(BACKOFF_MS[0]));
		expect([...kv.data.keys()].filter((k) => k.startsWith("tel_spool:")).sort()).toEqual(before);
	});
});

describe("capacity and total loss are numbers, not silence (#1084)", () => {
	it("past the per-sink capacity a record is LOST and counted — the spool does not grow", async () => {
		for (let i = 0; i < MAX_SPOOL_PER_SINK; i++) kv.data.set(`tel_spool:agent_events:fill-${String(i).padStart(4, "0")}`, { value: "{}", metadata: { nextAt: 0, createdAt: 0 } });
		down = true;
		expect(await logEvent(env, { source: "chat", event: "chat.in" })).toBe("lost");
		expect(spooled("agent_events")).toHaveLength(MAX_SPOOL_PER_SINK);
		const health = await telemetryDelivery(env);
		expect(health.sinks.find((s) => s.sink === "agent_events")).toMatchObject({ pending: MAX_SPOOL_PER_SINK, pendingCapped: true, lost: 1 });
	});

	it("with the spool down too, the writer says lost — and still never throws", async () => {
		down = true;
		kv.failPuts((k) => k.startsWith("tel_spool:"));
		expect(await logError(env, { source: "x", message: "y" })).toBe("lost");
		expect((await telemetryDelivery(env)).sinks.find((s) => s.sink === "error_log")).toMatchObject({ pending: 0, lost: 1 });
	});

	it("with no spool store bound at all, the writer says lost", async () => {
		down = true;
		expect(await logError({ DB: env.DB }, { source: "x", message: "y" })).toBe("lost");
	});

	it("health refuses to read as healthy when the spool cannot be read", async () => {
		await expect(telemetryDelivery({})).rejects.toThrow(/no telemetry spool store/);
	});

	it("a healthy writer reports persisted and leaves the spool empty", async () => {
		expect(await logError(env, { source: "x", message: "y" })).toBe("persisted");
		expect(await logEvent(env, { source: "chat", event: "chat.in" })).toBe("persisted");
		expect(await recordAdminAction(env, actor, "settings.platform_ai")).toBe("persisted");
		expect((await telemetryDelivery(env)).complete).toBe(true);
	});
});

describe("partial MCP audit index writes are reconciled (#1084)", () => {
	// The marker shape the MCP Worker's `writeAudit` leaves when one of the two index keys failed
	// (`workers/mcp/src/safety.ts`; its own test pins the writer side).
	const NOW_S = Math.floor(Date.now() / 1000);
	const marker = (id: string, keys: string[], expiration: number) =>
		kv.data.set(`tel_spool:mcp_audit:${id}`, {
			value: JSON.stringify({ sink: "mcp_audit", id, payload: { keys, value: `{"id":"${id}","tool":"x"}`, expiration, metadata: { tool: "x" } }, attempts: 0, nextAt: 0, createdAt: Date.now() }),
			metadata: { nextAt: 0, createdAt: Date.now() },
		});

	it("re-puts the missing key with the same value and the same absolute expiry, idempotently", async () => {
		const expiration = NOW_S + 90 * 86_400;
		kv.data.set("audit_idx:u1:0001:e1", { value: '{"id":"e1","tool":"x"}', expiration, metadata: { tool: "x" } });
		marker("e1", ["audit_all:0001:u1:e1"], expiration);
		expect((await readAuditCoverage(kv.kv)).delivery).toMatchObject({ complete: false, pending: 1 });

		expect(await drainTelemetrySpool(env)).toMatchObject({ delivered: 1 });
		expect(kv.data.get("audit_all:0001:u1:e1")).toEqual(kv.data.get("audit_idx:u1:0001:e1"));
		// Again, as if the marker had survived: the same key and value — still one event in each index.
		marker("e1", ["audit_all:0001:u1:e1"], expiration);
		await drainTelemetrySpool(env);
		expect([...kv.data.keys()].filter((k) => k.startsWith("audit_all:"))).toEqual(["audit_all:0001:u1:e1"]);
		expect(await readAuditCoverage(kv.kv)).toMatchObject({ delivery: { complete: true, pending: 0 } });
	});

	it("does not resurrect an event past its retention", async () => {
		marker("e2", ["audit_all:0002:u1:e2"], NOW_S + 30);
		await drainTelemetrySpool(env);
		expect(kv.data.has("audit_all:0002:u1:e2")).toBe(false);
		expect(spooled("mcp_audit")).toHaveLength(0);
	});

	it("coverage separates the finished migration from incomplete delivery", async () => {
		kv.data.set("audit_ledger_migration", { value: JSON.stringify({ status: "complete", pass: 2, scanned: 0, copied: 0, expired: 0, unplaceable: 0, passUnplaceable: 0 }) });
		marker("e3", ["audit_all:0003:u1:e3"], NOW_S + 86_400);
		const coverage = await readAuditCoverage(kv.kv);
		expect(coverage).toMatchObject({ complete: false, migrationComplete: true, legacyIndex: "complete", delivery: { pending: 1 } });
		expect(coverage.detail).toMatch(/Legacy indexing finished\. Delivery is incomplete: 1 recent event is in only one index/);
	});
});

describe("POST /v1/errors/client says whether the report was kept (#1084)", () => {
	const post = async (bindings: Partial<Env>) => {
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/errors", errorRoutes);
		const res = await app.request("/v1/errors/client", { method: "POST", body: JSON.stringify({ message: "boom", source: "window" }), headers: { "Content-Type": "application/json" } }, bindings as Env);
		return { status: res.status, body: await res.json() };
	};

	it("200 durable when the row is in the log", async () => {
		expect(await post(env)).toEqual({ status: 200, body: { ok: true, durable: true } });
	});

	it("202 queued — accepted, NOT yet durable — when D1 refused it and it is spooled", async () => {
		down = true;
		expect(await post(env)).toEqual({ status: 202, body: { ok: true, durable: false, queued: true } });
	});

	it("503 when it could not be kept anywhere", async () => {
		down = true;
		expect(await post({ DB: env.DB })).toMatchObject({ status: 503, body: { ok: false, durable: false } });
	});
});

describe("GET /v1/errors/telemetry-health — the authorized delivery read (#1084)", () => {
	const get = async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/errors", errorRoutes);
		const res = await app.request("/v1/errors/telemetry-health", {}, env as Env);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};

	it("is admin-only: an ordinary account is refused and sees no platform-wide numbers", async () => {
		auth.session = { uid: "u1", roles: ["user"] };
		const res = await get();
		expect(res.status).toBe(403);
		expect(res.body).not.toHaveProperty("sinks");
	});

	it("reports pending, dead, lost and the last drain per sink to an admin", async () => {
		auth.session = { uid: "admin-1", roles: ["admin"] };
		down = true;
		await logError(env, { source: "x", message: "y" });
		await drainTelemetrySpool(env, later(BACKOFF_MS[0]));
		const res = await get();
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			complete: false,
			lastDrain: { retrying: 1, delivered: 0 },
			policy: { maxAttempts: MAX_ATTEMPTS, capacityPerSink: MAX_SPOOL_PER_SINK },
		});
		expect((res.body.sinks as Array<Record<string, unknown>>).map((x) => x.sink)).toEqual(["error_log", "agent_events", "admin_audit_log", "mcp_audit"]);
		expect((res.body.sinks as Array<Record<string, unknown>>)[0]).toMatchObject({ sink: "error_log", pending: 1 });
	});

	it("503 — never a healthy-looking answer — when the spool cannot be read", async () => {
		auth.session = { uid: "admin-1", roles: ["admin"] };
		env = { DB: env.DB } as typeof env;
		expect((await get()).status).toBe(503);
	});
});

describe("spoolTelemetry", () => {
	it("re-spooling the same id does not count against capacity twice", async () => {
		expect(await spoolTelemetry(env, "error_log", "same", { message: "a" })).toBe("queued");
		expect(await spoolTelemetry(env, "error_log", "same", { message: "a" })).toBe("queued");
		expect(spooled("error_log")).toEqual(["tel_spool:error_log:same"]);
	});
});
