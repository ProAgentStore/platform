import { describe, expect, it, vi } from "vitest";
import { createConnection, deleteConnection, deliverEvent, listConnections, matchesConnectionFilter, validateConnectionFilter, type ConnectionRow } from "./connections.js";
import type { Env } from "../types.js";

/**
 * D1 stub resolved against SQL text. `owns` seeds which (instance,user) pairs exist;
 * `connections` seeds rows returned by the deliverEvent/list SELECTs. `writes` captures
 * INSERT/DELETE for assertions.
 */
function buildEnv(opts: { owns?: Array<[string, string]>; connections?: ConnectionRow[]; agentStatus?: number; insertChanges?: number } = {}) {
	const owns = new Set((opts.owns ?? []).map(([i, u]) => `${i}::${u}`));
	const rows = opts.connections ?? [];
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const agentFetches: Request[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (sql.includes("FROM agent_instances")) {
								const [id, uid] = args as [string, string];
								return owns.has(`${id}::${uid}`) ? { id } : null;
							}
							if (sql.includes("SELECT * FROM agent_connections WHERE id")) {
								// createConnection re-reads by the freshly-minted id; echo a seeded row.
								return rows.find((r) => r.id === args[0]) ?? rows[0] ?? null;
							}
							return null;
						},
						async all<T>() {
							if (sql.includes("FROM agent_connections")) {
								// deliverEvent: WHERE source_instance_id AND event_type AND enabled
								if (sql.includes("source_instance_id = ?1 AND event_type = ?2")) {
									const [src, ev] = args as [string, string];
									return { results: rows.filter((r) => r.source_instance_id === src && r.event_type === ev && r.enabled) as unknown as T[] };
								}
								return { results: rows as unknown as T[] };
							}
							return { results: [] as T[] };
						},
						async run() {
							writes.push({ sql, args });
							// An idempotency-key collision surfaces as 0 changes from INSERT OR IGNORE.
							if (sql.includes("INSERT OR IGNORE INTO agent_connection_deliveries")) {
								return { meta: { changes: opts.insertChanges ?? 1 } };
							}
							return { meta: { changes: sql.includes("DELETE") ? (rows.length ? 1 : 0) : 1 } };
						},
					};
				},
			};
		},
	};
	const AGENT = {
		idFromName: (n: string) => ({ name: n }),
		get: () => ({
			async fetch(req: Request) {
				agentFetches.push(req);
				return new Response("{}", { status: opts.agentStatus ?? 200 });
			},
		}),
	};
	const env = { DB, AGENT } as unknown as Env;
	return { env, writes, agentFetches };
}

const conn = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
	id: "c1",
	user_id: "u1",
	source_instance_id: "finder",
	event_type: "lead.created",
	target_instance_id: "outreach",
	action: "insert_record",
	config: JSON.stringify({ collection: "prospects" }),
	enabled: 1,
	created_at: "",
	updated_at: "",
	...over,
});

describe("createConnection", () => {
	it("requires ownership of BOTH instances", async () => {
		const { env } = buildEnv({ owns: [["finder", "u1"]] }); // owns source, not target
		const res = await createConnection(env, "u1", { sourceInstanceId: "finder", eventType: "lead.created", targetInstanceId: "outreach", action: "insert_record" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.status).toBe(404);
	});

	it("rejects a disallowed action", async () => {
		const { env } = buildEnv({ owns: [["finder", "u1"], ["outreach", "u1"]] });
		const res = await createConnection(env, "u1", { sourceInstanceId: "finder", eventType: "lead.created", targetInstanceId: "outreach", action: "sync_connector" as never });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.status).toBe(400);
	});

	it("rejects a self-loop", async () => {
		const { env } = buildEnv({ owns: [["finder", "u1"]] });
		const res = await createConnection(env, "u1", { sourceInstanceId: "finder", eventType: "x", targetInstanceId: "finder", action: "create_task" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.status).toBe(400);
	});

	it("creates when the caller owns both + the action is allowed", async () => {
		const { env, writes } = buildEnv({ owns: [["finder", "u1"], ["outreach", "u1"]], connections: [conn()] });
		const res = await createConnection(env, "u1", { sourceInstanceId: "finder", eventType: "lead.created", targetInstanceId: "outreach", action: "insert_record", config: { collection: "prospects" } });
		expect(res.ok).toBe(true);
		expect(writes.some((w) => w.sql.includes("INSERT INTO agent_connections"))).toBe(true);
	});
});

describe("deliverEvent", () => {
	it("no-op (no fetch) when nothing is wired", async () => {
		const { env, agentFetches } = buildEnv({ connections: [] });
		const r = await deliverEvent(env, "finder", "u1", "lead.created", [{ name: "X" }]);
		expect(r).toMatchObject({ connections: 0, delivered: 0, failed: 0, queued: 0 });
		expect(agentFetches.length).toBe(0);
	});

	it("delivers each net-new record to the target's action", async () => {
		const { env, agentFetches } = buildEnv({ connections: [conn()] });
		const r = await deliverEvent(env, "finder", "u1", "lead.created", [{ name: "A" }, { name: "B" }]);
		expect(r.connections).toBe(1);
		expect(r.delivered).toBe(2);
		// insert_record → POST to the TARGET instance's collection endpoint, twice.
		expect(agentFetches.length).toBe(2);
		expect(agentFetches.every((req) => req.url.includes("/collections/prospects/records"))).toBe(true);
	});

	it("ignores connections for a different event type", async () => {
		const { env, agentFetches } = buildEnv({ connections: [conn({ event_type: "other.event" })] });
		const r = await deliverEvent(env, "finder", "u1", "lead.created", [{ name: "A" }]);
		expect(r.connections).toBe(0);
		expect(agentFetches.length).toBe(0);
	});
});

describe("listConnections / deleteConnection", () => {
	it("maps rows to views + deletes", async () => {
		const { env, writes } = buildEnv({ connections: [conn()] });
		const list = await listConnections(env, "u1", { sourceInstanceId: "finder" });
		expect(list[0]).toMatchObject({ id: "c1", eventType: "lead.created", action: "insert_record", enabled: true, config: { collection: "prospects" } });
		expect(await deleteConnection(env, "u1", "c1")).toBe(true);
		expect(writes.some((w) => w.sql.includes("DELETE FROM agent_connections"))).toBe(true);
	});
});


// ── durability, idempotency, routing (migration 0058) ──────────────────────────────────
describe("deliverEvent — at-least-once delivery", () => {
	it("persists every delivery to the outbox BEFORE attempting it", async () => {
		const { env, writes } = buildEnv({ connections: [conn()] });
		await deliverEvent(env, "finder", "u1", "lead.created", [{ place_id: "p1" }]);
		// A crash between enqueue and attempt must leave the work recoverable, so the row
		// has to exist first — this is the whole difference from the old inline behaviour.
		const enqueued = writes.filter((w) => w.sql.includes("INSERT OR IGNORE INTO agent_connection_deliveries"));
		expect(enqueued).toHaveLength(1);
		expect(writes.some((w) => w.sql.includes("SET status = 'delivered'"))).toBe(true);
	});

	it("stamps the emitting run on the delivery so the chain can be followed", async () => {
		const { env, writes } = buildEnv({ connections: [conn()] });
		await deliverEvent(env, "finder", "u1", "lead.created", [{ place_id: "p1" }], { traceId: "run-abc" });
		const enqueued = writes.find((w) => w.sql.includes("INSERT OR IGNORE INTO agent_connection_deliveries"))!;
		expect(enqueued.args).toContain("run-abc");
	});

	it("schedules a retry instead of losing the event when the target fails", async () => {
		// The failure this exists for: a transient fault in the consumer used to drop the
		// lead permanently and silently.
		const { env, writes } = buildEnv({ connections: [conn()], agentStatus: 500 });
		const r = await deliverEvent(env, "finder", "u1", "lead.created", [{ place_id: "p1" }]);
		expect(r.delivered).toBe(0);
		expect(r.failed).toBe(1);
		const retry = writes.find((w) => w.sql.includes("SET status = 'pending'"));
		expect(retry).toBeTruthy();
		expect(retry!.args.some((a) => typeof a === "string" && /\d{4}-\d{2}-\d{2}T/.test(a))).toBe(true); // next_attempt_at set
	});

	it("counts a duplicate emission instead of delivering it twice", async () => {
		// INSERT OR IGNORE reports 0 changes on an idempotency-key collision.
		const { env, agentFetches } = buildEnv({ connections: [conn()], insertChanges: 0 });
		const r = await deliverEvent(env, "finder", "u1", "lead.created", [{ place_id: "p1" }], { traceId: "run-abc" });
		expect(r.duplicate).toBe(1);
		expect(r.delivered).toBe(0);
		expect(agentFetches.length).toBe(0); // the consumer's expensive work never ran again
	});
});

describe("connection filters — routing", () => {
	it("matches everything when no filter is set", () => {
		expect(matchesConnectionFilter({}, { city: "Sydney" })).toBe(true);
	});

	it("routes on a bare clause array (AND)", () => {
		const cfg = { filter: [{ field: "city", op: "eq", value: "Sydney" }, { field: "rating", op: "gte", value: 4 }] };
		expect(matchesConnectionFilter(cfg, { city: "Sydney", rating: 4.5 })).toBe(true);
		expect(matchesConnectionFilter(cfg, { city: "Sydney", rating: 3 })).toBe(false);
		expect(matchesConnectionFilter(cfg, { city: "Perth", rating: 5 })).toBe(false);
	});

	it("supports {where, any} for OR", () => {
		const cfg = { filter: { any: true, where: [{ field: "city", op: "eq", value: "Sydney" }, { field: "city", op: "eq", value: "Perth" }] } };
		expect(matchesConnectionFilter(cfg, { city: "Perth" })).toBe(true);
		expect(matchesConnectionFilter(cfg, { city: "Hobart" })).toBe(false);
	});

	it("reads dotted paths, like the filter step", () => {
		expect(matchesConnectionFilter({ filter: [{ field: "geo.state", op: "eq", value: "NSW" }] }, { geo: { state: "NSW" } })).toBe(true);
	});

	it("a filtered-out payload is never enqueued — no row, no attempt", async () => {
		const { env, writes, agentFetches } = buildEnv({ connections: [conn({ config: JSON.stringify({ filter: [{ field: "city", op: "eq", value: "Sydney" }] }) })] });
		const r = await deliverEvent(env, "finder", "u1", "lead.created", [{ city: "Perth" }]);
		expect(r).toMatchObject({ filtered: 1, queued: 0, delivered: 0 });
		expect(writes.some((w) => w.sql.includes("INSERT OR IGNORE INTO agent_connection_deliveries"))).toBe(false);
		expect(agentFetches.length).toBe(0);
	});
});

describe("validateConnectionFilter", () => {
	it("accepts an absent filter and a well-formed one", () => {
		expect(validateConnectionFilter(undefined)).toBeNull();
		expect(validateConnectionFilter([{ field: "city", op: "eq", value: "Sydney" }])).toBeNull();
		expect(validateConnectionFilter({ where: [{ field: "x", op: "exists" }], any: true })).toBeNull();
	});

	it("rejects malformed clauses at CREATE time rather than silently never matching", () => {
		// A filter that never matches stops the chain while the connection still looks healthy.
		expect(validateConnectionFilter([{ op: "eq", value: 1 }])).toMatch(/needs a "field"/);
		expect(validateConnectionFilter([{ field: "x", op: "beginsWith" }])).toMatch(/op must be one of/);
		expect(validateConnectionFilter([{ field: "x", op: "in", value: "notarray" }])).toMatch(/needs an array/);
		expect(validateConnectionFilter("nope")).toMatch(/clause array/);
	});
});

describe("validateConnectionFilter — a clause that can NEVER match is a rejected clause", () => {
	it("rejects a numeric comparison against a string value", () => {
		// "Only Sydney leads rated 4+" written as `{"op":"gte","value":"4"}` — the natural result
		// of a text input or a hand-written JSON body. `evalClause` requires BOTH sides to be
		// numbers, so this is a guaranteed false: the connection is created, shows enabled and
		// healthy, and silently drops every event. That is the exact never-matches failure this
		// validation exists to catch, and it walked straight past it.
		for (const op of ["gt", "gte", "lt", "lte"]) {
			expect(validateConnectionFilter([{ field: "rating", op, value: "4" }])).toMatch(/never match/);
			expect(validateConnectionFilter([{ field: "rating", op, value: 4 }])).toBeNull();
		}
	});

	it("rejects a `contains` against a non-string value", () => {
		expect(validateConnectionFilter([{ field: "name", op: "contains", value: 42 }])).toMatch(/never match/);
		expect(validateConnectionFilter([{ field: "name", op: "contains", value: "cafe" }])).toBeNull();
	});

	it("still allows eq/ne against any type, and the value-free ops", () => {
		expect(validateConnectionFilter([{ field: "x", op: "eq", value: "s" }])).toBeNull();
		expect(validateConnectionFilter([{ field: "x", op: "ne", value: 3 }])).toBeNull();
		expect(validateConnectionFilter([{ field: "x", op: "exists" }])).toBeNull();
		expect(validateConnectionFilter([{ field: "x", op: "truthy" }])).toBeNull();
	});
});
