import { describe, expect, it, vi } from "vitest";
import { createConnection, deleteConnection, deliverEvent, listConnections, type ConnectionRow } from "./connections.js";
import type { Env } from "../types.js";

/**
 * D1 stub resolved against SQL text. `owns` seeds which (instance,user) pairs exist;
 * `connections` seeds rows returned by the deliverEvent/list SELECTs. `writes` captures
 * INSERT/DELETE for assertions.
 */
function buildEnv(opts: { owns?: Array<[string, string]>; connections?: ConnectionRow[] } = {}) {
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
				return new Response("{}", { status: 200 });
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
		expect(r).toEqual({ connections: 0, delivered: 0, failed: 0 });
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
