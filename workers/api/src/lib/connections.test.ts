import { describe, expect, it } from "vitest";
import { createConnection, deleteConnection, deliverEvent, listConnections, matchesConnectionFilter, setConnectionEnabled, validateConnectionFilter, type ConnectionRow } from "./connections.js";
import type { Env } from "../types.js";

/**
 * D1 stub resolved against SQL text. `owns` seeds which (instance,user) pairs exist;
 * `connections` seeds rows returned by the deliverEvent/list SELECTs. `writes` captures
 * INSERT/DELETE for assertions.
 */
function buildEnv(
	opts: {
		owns?: Array<[string, string]>;
		connections?: ConnectionRow[];
		agentStatus?: number;
		insertChanges?: number;
		/** Target instances as `id -> {agentName, config}` — what the #363 pipeline check reads. */
		instances?: Record<string, { agentName?: string; config: unknown }>;
		/** `agent_instances.status` per target id, for the #649 gate. Absent → 'active'. */
		targetStatus?: Record<string, string>;
	} = {},
) {
	const owns = new Set((opts.owns ?? []).map(([i, u]) => `${i}::${u}`));
	const instances = opts.instances ?? {};
	const rows = opts.connections ?? [];
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const agentFetches: Request[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							// loadPipeline — distinct from the ownership probe below, which selects `id`.
							if (sql.includes("SELECT config FROM agent_instances")) {
								const seeded = instances[String(args[0])];
								return seeded ? { config: JSON.stringify(seeded.config) } : null;
							}
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
							// targetFactsFor — the batched "what is this agent called, what pipelines
							// does it have" read behind the #363 annotation.
							if (sql.includes("JOIN agents a ON a.id = ai.agent_id")) {
								const ids = args.slice(1).map(String);
								return {
									results: ids
										.filter((id) => instances[id])
										.map((id) => ({ id, config: JSON.stringify(instances[id].config), agent_name: instances[id].agentName ?? null })) as unknown as T[],
								};
							}
							if (sql.includes("FROM agent_connections")) {
								// deliverEvent: WHERE source_instance_id AND event_type. NOT filtered on
								// `enabled` — the real SELECT stopped filtering it in SQL (#644) so a paused
								// edge can be counted and reported rather than looking like an unwired one.
								if (sql.includes("c.source_instance_id = ?1 AND c.event_type = ?2")) {
									const [src, ev] = args as [string, string];
									// `target_status` comes from the LEFT JOIN the real statement carries
									// (#649). This stub cannot model a join, so it answers 'active' unless a
									// test seeds otherwise — which is exactly why the gate itself is measured
									// against the real migrated schema in `connection-instance-status.test.ts`
									// and not here.
									return {
										results: rows
											.filter((r) => r.source_instance_id === src && r.event_type === ev)
											.map((r) => ({ ...r, target_status: opts.targetStatus?.[r.target_instance_id] ?? "active" })) as unknown as T[],
									};
								}
								return { results: rows as unknown as T[] };
							}
							return { results: [] as T[] };
						},
						async run() {
							writes.push({ sql, args });
							// The enabled toggle (#644) mutates the seeded row, so the function's own
							// re-read sees what it just wrote — a stub that echoed the old row would
							// report `enabled:true` from a call that disabled it.
							if (sql.includes("UPDATE agent_connections SET enabled")) {
								const [id, uid, enabled] = args as [string, string, number];
								const row = rows.find((r) => r.id === id && r.user_id === uid);
								if (!row) return { meta: { changes: 0 } };
								row.enabled = enabled;
								return { meta: { changes: 1 } };
							}
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

// ── #363: a connection may not silently name a pipeline the target does not have ────────
const GOOD = { name: "site-builder", steps: [{ tool: "geocode", inputs: { city: "Sydney" } }] };

/** A target agent that owns exactly the pipelines listed, plus a broken one when asked. */
function builder(pipelines: Record<string, unknown>) {
	return { agentName: "Website Builder", config: { pipelines } };
}

describe("createConnection — the named pipeline must exist on the target (#363)", () => {
	const input = (pipeline: string) => ({
		sourceInstanceId: "finder",
		targetInstanceId: "outreach",
		eventType: "lead.created",
		action: "run_pipeline" as const,
		config: { pipeline },
	});
	const owns: Array<[string, string]> = [
		["finder", "u1"],
		["outreach", "u1"],
	];

	it("warns — naming the pipeline, the agent, and what that agent actually has", async () => {
		const { env } = buildEnv({ owns, connections: [conn({ action: "run_pipeline" })], instances: { outreach: builder({ "site-builder": GOOD }) } });
		const res = await createConnection(env, "u1", input("site-buidler"));
		expect(res.ok).toBe(true);
		const warnings = res.ok ? res.warnings : [];
		expect(warnings.join(" ")).toContain('"site-buidler"');
		expect(warnings.join(" ")).toContain("Website Builder");
		expect(warnings.join(" ")).toContain('"site-builder"');
	});

	it("still CREATES it — a pipeline can legitimately be added to the target afterwards", async () => {
		const { env, writes } = buildEnv({ owns, connections: [conn({ action: "run_pipeline" })], instances: { outreach: builder({}) } });
		const res = await createConnection(env, "u1", input("site-deploy"));
		expect(res.ok).toBe(true);
		expect(writes.some((w) => w.sql.includes("INSERT INTO agent_connections"))).toBe(true);
	});

	it("says nothing when the pipeline is there", async () => {
		const { env } = buildEnv({ owns, connections: [conn({ action: "run_pipeline" })], instances: { outreach: builder({ "site-builder": GOOD }) } });
		const res = await createConnection(env, "u1", input("site-builder"));
		expect(res.ok && res.warnings).toEqual([]);
	});

	it("says nothing when the target's config cannot be read — a failed read is not evidence", async () => {
		const { env } = buildEnv({ owns, connections: [conn({ action: "run_pipeline" })] });
		const res = await createConnection(env, "u1", input("site-deploy"));
		expect(res.ok && res.warnings).toEqual([]);
	});
});

describe("listConnections — an already-invalid row is surfaced, not removed (#363)", () => {
	it("annotates a stored edge naming a pipeline the target does not have", async () => {
		const { env } = buildEnv({
			connections: [conn({ action: "run_pipeline", config: JSON.stringify({ pipeline: "site-deploy" }) })],
			instances: { outreach: builder({ "site-builder": GOOD }) },
		});
		const [row] = await listConnections(env, "u1", { sourceInstanceId: "finder" });
		expect(row.warnings.join(" ")).toContain('"site-deploy"');
	});

	it("leaves a healthy edge and every non-pipeline action unannotated", async () => {
		const { env } = buildEnv({
			connections: [
				conn({ id: "c1", action: "run_pipeline", config: JSON.stringify({ pipeline: "site-builder" }) }),
				conn({ id: "c2", action: "insert_record" }),
			],
			instances: { outreach: builder({ "site-builder": GOOD }) },
		});
		const list = await listConnections(env, "u1", {});
		expect(list.map((r) => r.warnings)).toEqual([[], []]);
	});

	it("flags a name that is PRESENT but whose definition would never run", async () => {
		const { env } = buildEnv({
			connections: [conn({ action: "run_pipeline", config: JSON.stringify({ pipeline: "site-deploy" }) })],
			instances: { outreach: builder({ "site-deploy": { name: "site-deploy", steps: [] } }) },
		});
		const [row] = await listConnections(env, "u1", { sourceInstanceId: "finder" });
		expect(row.warnings.join(" ")).toContain("not valid");
	});

	it("never takes the listing down with it when the annotation read fails", async () => {
		const { env } = buildEnv({ connections: [conn({ action: "run_pipeline", config: JSON.stringify({ pipeline: "site-deploy" }) })] });
		const [row] = await listConnections(env, "u1", { sourceInstanceId: "finder" });
		expect(row.id).toBe("c1");
		expect(row.warnings).toEqual([]);
	});
});

// ── #632: source-side emit warning ───────────────────────────────────────────────────────

/** A source agent that owns the given pipelines. */
function sourceAgent(pipelines: Record<string, unknown>) {
	return { agentName: "Lead Finder", config: { pipelines } };
}

/** A minimal `dedupe_upsert` step with a literal emit. */
const emitStep = (eventType: string) => ({ tool: "dedupe_upsert", inputs: { collection: "leads", key: "id", emit: eventType } });

describe("createConnection — source must be able to statically emit the wired eventType (#632)", () => {
	const input = {
		sourceInstanceId: "finder",
		targetInstanceId: "outreach",
		eventType: "lead.created",
		action: "run_pipeline" as const,
		config: { pipeline: "site-builder" },
	};
	const owns: Array<[string, string]> = [
		["finder", "u1"],
		["outreach", "u1"],
	];

	it("warns when the source has NO pipeline that emits the wired eventType (sink-only producer)", async () => {
		const { env } = buildEnv({
			owns,
			connections: [conn({ action: "run_pipeline" })],
			instances: {
				// Source: has a pipeline but it ends in a sink (no dedupe_upsert with emit).
				finder: sourceAgent({ finder: { name: "finder", steps: [{ tool: "geocode" }], sink: { collection: "leads" } } }),
				outreach: builder({ "site-builder": GOOD }),
			},
		});
		const res = await createConnection(env, "u1", input);
		expect(res.ok).toBe(true);
		const warnings = res.ok ? res.warnings : [];
		expect(warnings.join(" ")).toContain("dedupe_upsert");
		expect(warnings.join(" ")).toContain('"lead.created"');
	});

	it("does NOT warn when the source has a dedupe_upsert step emitting the eventType", async () => {
		const { env } = buildEnv({
			owns,
			connections: [conn({ action: "run_pipeline" })],
			instances: {
				finder: sourceAgent({ finder: { name: "finder", steps: [emitStep("lead.created")] } }),
				outreach: builder({ "site-builder": GOOD }),
			},
		});
		const res = await createConnection(env, "u1", input);
		expect(res.ok).toBe(true);
		const warnings = res.ok ? res.warnings : [];
		// No source-side warning — the source CAN emit.
		expect(warnings.some((w) => w.includes("dedupe_upsert"))).toBe(false);
	});

	it("does NOT warn when the source config cannot be read — a failed read is not evidence", async () => {
		// `instances` does not include `finder` → targetFactsFor returns nothing for it → stay silent.
		const { env } = buildEnv({
			owns,
			connections: [conn({ action: "run_pipeline" })],
			instances: { outreach: builder({ "site-builder": GOOD }) },
		});
		const res = await createConnection(env, "u1", input);
		expect(res.ok).toBe(true);
		const warnings = res.ok ? res.warnings : [];
		expect(warnings.some((w) => w.includes("dedupe_upsert"))).toBe(false);
	});

	it("does not warn for non-pipeline actions — only run_pipeline can start a chain", async () => {
		const { env } = buildEnv({
			owns,
			connections: [conn()],
			instances: { finder: sourceAgent({}) }, // source has no pipelines at all
		});
		// insert_record action — source emit capability is irrelevant.
		const res = await createConnection(env, "u1", { ...input, action: "insert_record", config: { collection: "leads" } });
		expect(res.ok).toBe(true);
		const warnings = res.ok ? res.warnings : [];
		expect(warnings.some((w) => w.includes("dedupe_upsert"))).toBe(false);
	});
});

describe("listConnections — source-side emit warning on already-stored rows (#632)", () => {
	it("annotates a stored edge when the source has no pipeline emitting the eventType", async () => {
		const { env } = buildEnv({
			connections: [conn({ action: "run_pipeline", config: JSON.stringify({ pipeline: "site-builder" }) })],
			instances: {
				finder: sourceAgent({ finder: { name: "finder", steps: [{ tool: "geocode" }], sink: { collection: "leads" } } }),
				outreach: builder({ "site-builder": GOOD }),
			},
		});
		const [row] = await listConnections(env, "u1", { sourceInstanceId: "finder" });
		expect(row.warnings.join(" ")).toContain("dedupe_upsert");
		expect(row.warnings.join(" ")).toContain('"lead.created"');
	});

	it("leaves a healthy edge unannotated when the source CAN emit", async () => {
		const { env } = buildEnv({
			connections: [conn({ action: "run_pipeline", config: JSON.stringify({ pipeline: "site-builder" }) })],
			instances: {
				finder: sourceAgent({ finder: { name: "finder", steps: [emitStep("lead.created")] } }),
				outreach: builder({ "site-builder": GOOD }),
			},
		});
		const [row] = await listConnections(env, "u1", { sourceInstanceId: "finder" });
		expect(row.warnings).toEqual([]);
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

// ── #644: a connection can be paused, and a paused connection says so ───────────────────
describe("setConnectionEnabled (#644)", () => {
	it("writes enabled=0 and reports it back — before this there was no UPDATE at all", async () => {
		const { env, writes } = buildEnv({ connections: [conn()] });
		const view = await setConnectionEnabled(env, "u1", "c1", false);
		expect(view?.enabled).toBe(false);
		const update = writes.find((w) => w.sql.includes("UPDATE agent_connections SET enabled"));
		expect(update).toBeDefined();
		expect(update?.args).toEqual(["c1", "u1", 0]);
	});

	it("re-enables, so the pause is reversible", async () => {
		const { env } = buildEnv({ connections: [conn({ enabled: 0 })] });
		expect((await setConnectionEnabled(env, "u1", "c1", true))?.enabled).toBe(true);
	});

	it("is owner-scoped — another user's id matches no row", async () => {
		const { env } = buildEnv({ connections: [conn()] });
		expect(await setConnectionEnabled(env, "someone-else", "c1", false)).toBeNull();
	});

	it("keeps the row, its config and its outbox history — that is the whole point vs delete", async () => {
		const { env, writes } = buildEnv({ connections: [conn({ config: JSON.stringify({ collection: "prospects", filter: [{ field: "city", op: "eq", value: "Sydney" }] }) })] });
		const view = await setConnectionEnabled(env, "u1", "c1", false);
		// Deleting was the only pause available before this, and it destroys the routing filter and
		// orphans `agent_connection_deliveries.connection_id`. Disabling must touch neither.
		expect(view?.config).toMatchObject({ collection: "prospects" });
		expect(writes.some((w) => w.sql.includes("DELETE FROM agent_connections"))).toBe(false);
	});
});

describe("deliverEvent — a disabled connection (#644)", () => {
	it("delivers nothing and counts it as disabled", async () => {
		const { env, agentFetches } = buildEnv({ connections: [conn({ enabled: 0 })] });
		const r = await deliverEvent(env, "finder", "u1", "lead.created", [{ name: "A" }]);
		expect(r.delivered).toBe(0);
		expect(r.connections).toBe(0);
		expect(r.disabled).toBe(1);
		expect(agentFetches.length).toBe(0);
	});

	it("logs a warn event, so a paused chain is not the same as an unwired one", async () => {
		const { env, writes } = buildEnv({ connections: [conn({ enabled: 0 })] });
		await deliverEvent(env, "finder", "u1", "lead.created", [{ name: "A" }]);
		// The only difference between "paused" and "never built" used to be invisible: both
		// returned zero and wrote nothing anywhere.
		const logged = writes.filter((w) => JSON.stringify(w.args).includes("connection.paused"));
		expect(logged.length).toBe(1);
		expect(JSON.stringify(logged[0].args)).toContain("1 connection(s) disabled");
	});

	it("still delivers through the enabled edges beside it", async () => {
		const { env, agentFetches } = buildEnv({ connections: [conn({ id: "c1", enabled: 0 }), conn({ id: "c2", enabled: 1 })] });
		const r = await deliverEvent(env, "finder", "u1", "lead.created", [{ name: "A" }]);
		expect(r.connections).toBe(1);
		expect(r.delivered).toBe(1);
		expect(r.disabled).toBe(1);
		expect(agentFetches.length).toBe(1);
	});
});
