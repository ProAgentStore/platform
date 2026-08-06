import { describe, expect, it } from "vitest";
import { listAgents, listInstances } from "./admin.js";
import type { Env } from "../types.js";

interface Query {
	sql: string;
	binds: unknown[];
}

/**
 * D1 stand-in that records every query with its binds, so a test can assert the
 * predicate AND that the values were bound rather than interpolated. `relayConnected`
 * returns false whenever `env.RELAY` is absent, which is the default here.
 */
function testEnv(opts: { rows?: unknown[]; count?: number; nodes?: string[]; relay?: boolean } = {}) {
	const queries: Query[] = [];
	const resultFor = (sql: string) => {
		if (sql.includes("COUNT(*) AS n")) return { n: opts.count ?? 0 };
		if (sql.includes("DISTINCT runner_node")) return { results: (opts.nodes ?? []).map((n) => ({ runner_node: n })) };
		return { results: opts.rows ?? [] };
	};
	const env = {
		RELAY: opts.relay
			? { idFromName: () => "id", get: () => ({ fetch: async () => new Response(JSON.stringify({ connected: true })) }) }
			: undefined,
		DB: {
			prepare(sql: string) {
				return {
					bind(...binds: unknown[]) {
						queries.push({ sql, binds });
						const r = resultFor(sql);
						return { all: async () => r, first: async () => r };
					},
					all: async () => {
						queries.push({ sql, binds: [] });
						return resultFor(sql);
					},
					first: async () => {
						queries.push({ sql, binds: [] });
						return resultFor(sql);
					},
				};
			},
		},
	} as unknown as Env;
	return { env, queries };
}

const AGENT_ROW = {
	id: "a1",
	slug: "coder",
	name: "Coder",
	category: "code",
	model: "claude-sonnet-4-6",
	visibility: "draft",
	status: "active",
	created_at: "2026-08-01 00:00:00",
	updated_at: "2026-08-02 00:00:00",
	owner_id: "u1",
	owner_login: "alice",
	instances: 2,
	config: JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "browser", tools: ["github_create_issue"] } }),
};

describe("listAgents (admin cross-tenant, #31)", () => {
	it("returns drafts — the whole reason this exists next to the public /v1/agents", async () => {
		// GET /v1/agents filters to visibility='published', so a creator's broken draft was
		// invisible to the operator who had to debug it. The admin list must NOT filter.
		const { env, queries } = testEnv({ rows: [AGENT_ROW], count: 1 });
		const { agents, total } = await listAgents(env);
		expect(total).toBe(1);
		expect(agents[0].visibility).toBe("draft");
		expect(queries.every((q) => !q.sql.includes("visibility = 'published'"))).toBe(true);
	});

	it("exposes the capability summary and derived connectors, but never the raw config", async () => {
		const { env } = testEnv({ rows: [AGENT_ROW], count: 1 });
		const { agents } = await listAgents(env);
		expect(agents[0].capabilities).toEqual({ surfaces: ["coding"], runtime: "browser", workflow: null });
		expect(agents[0].connectors).toEqual(["github"]);
		expect(agents[0]).not.toHaveProperty("config");
	});

	it("applies visibility/status/owner filters as BOUND parameters", async () => {
		const { env, queries } = testEnv({ rows: [], count: 0 });
		await listAgents(env, { visibility: "published", status: "active", owner: "alice" });
		const list = queries.find((q) => q.sql.includes("ORDER BY a.created_at"));
		expect(list?.sql).toContain("a.visibility = ?");
		expect(list?.sql).toContain("a.status = ?");
		expect(list?.sql).toContain("(a.owner_id = ? OR u.github_login = ?)");
		// Values are bound, never interpolated — the id/login are attacker-influenced strings.
		expect(list?.binds.slice(0, 4)).toEqual(["published", "active", "alice", "alice"]);
	});

	it("runs the SAME predicate for the page and the count", async () => {
		// When they drifted, page 2 of a filtered list reported the UNFILTERED total, so the
		// UI paged into empty results and the operator concluded rows had vanished.
		const { env, queries } = testEnv({ rows: [], count: 0 });
		await listAgents(env, { search: "cod", visibility: "draft" });
		const list = queries.find((q) => q.sql.includes("ORDER BY a.created_at"));
		const count = queries.find((q) => q.sql.includes("COUNT(*) AS n"));
		// lastIndexOf: the list SELECT also has a " WHERE " inside its instance-count sub-query.
		const whereOf = (s: string) => {
			const end = s.indexOf(" ORDER BY ");
			return s.slice(s.lastIndexOf(" WHERE "), end === -1 ? undefined : end);
		};
		expect(whereOf(count?.sql ?? "")).toBe(whereOf(list?.sql ?? ""));
		// The count binds are the filter binds only; the list adds limit+offset.
		expect(count?.binds).toEqual(list?.binds.slice(0, count?.binds.length));
	});

	it("clamps limit and offset so a caller can't ask for the whole table", async () => {
		const { env, queries } = testEnv();
		await listAgents(env, { limit: 100_000, offset: -5 });
		const list = queries.find((q) => q.sql.includes("ORDER BY a.created_at"));
		expect(list?.binds.slice(-2)).toEqual([200, 0]);
	});
});

const INSTANCE_ROW = {
	id: "i1",
	agent_id: "a1",
	agent_name: "Coder",
	agent_slug: "coder",
	user_id: "u1",
	owner_login: "alice",
	display_name: "Coder 2",
	status: "active",
	created_at: "2026-08-01 00:00:00",
	updated_at: "2026-08-02 00:00:00",
	runtime_nodes: 1,
	last_seen_at: "2026-08-02 00:00:00",
};

describe("listInstances (admin cross-tenant, #31)", () => {
	it("filters by agent/owner/status as bound parameters", async () => {
		const { env, queries } = testEnv({ rows: [], count: 0 });
		await listInstances(env, { agent: "coder", owner: "alice", status: "active" });
		const list = queries.find((q) => q.sql.includes("ORDER BY i.created_at"));
		expect(list?.sql).toContain("(i.agent_id = ? OR a.slug = ?)");
		expect(list?.sql).toContain("(i.user_id = ? OR u.github_login = ?)");
		expect(list?.binds.slice(0, 5)).toEqual(["coder", "coder", "alice", "alice", "active"]);
	});

	it("carries the subscriber's own display name", async () => {
		const { env } = testEnv({ rows: [INSTANCE_ROW], count: 1, relay: true });
		const { instances } = await listInstances(env);
		expect(instances[0].display_name).toBe("Coder 2");
	});

	it("reports runtimeConnected from the LIVE relay, not the DB status column", async () => {
		// instance_runtime_nodes.status is never cleared on an unclean disconnect, so it
		// reads "online" for machines that have been off for days. The RelayDO holds the
		// socket, so it is the only honest answer (issue #31 AC).
		const { env, queries } = testEnv({ rows: [INSTANCE_ROW], count: 1, nodes: ["laptop"], relay: true });
		const { instances } = await listInstances(env);
		expect(instances[0].runtimeConnected).toBe(true);
		expect(queries.some((q) => q.sql.includes("DISTINCT runner_node"))).toBe(true);
	});

	it("leaves runtimeConnected null for an instance that never registered a runner", async () => {
		// null means "unknown/not applicable". A cloud-only agent has no runner to be
		// offline, and reporting `false` would read as "the machine is down".
		const { env } = testEnv({ rows: [{ ...INSTANCE_ROW, runtime_nodes: 0 }], count: 1, relay: true });
		const { instances } = await listInstances(env);
		expect(instances[0].runtimeConnected).toBeNull();
	});

	it("skips the relay round-trips entirely when asked", async () => {
		const { env, queries } = testEnv({ rows: [INSTANCE_ROW], count: 1, relay: true });
		const { instances } = await listInstances(env, { skipLive: true });
		expect(instances[0].runtimeConnected).toBeNull();
		expect(queries.some((q) => q.sql.includes("DISTINCT runner_node"))).toBe(false);
	});

	it("caps the live-check fan-out so a big page can't issue a DO call per row", async () => {
		const rows = Array.from({ length: 120 }, (_, i) => ({ ...INSTANCE_ROW, id: `i${i}` }));
		const { env, queries } = testEnv({ rows, count: 120, nodes: ["laptop"], relay: true });
		const { instances } = await listInstances(env, { limit: 200 });
		expect(queries.filter((q) => q.sql.includes("DISTINCT runner_node")).length).toBe(50);
		// Beyond the budget the answer is "unknown", never a fabricated false.
		expect(instances.filter((i) => i.runtimeConnected === null).length).toBe(70);
	});
});
