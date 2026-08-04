import { describe, expect, it } from "vitest";
import { SUPERVISION_TOOLS } from "./supervision.js";
import type { Env } from "../../types.js";

const tool = (name: string) => {
	const t = SUPERVISION_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`missing tool ${name}`);
	return t;
};

/**
 * D1 stub that behaves like the REAL schema: `agent_instances` has no `name` column, so selecting
 * one is an error rather than a null. Live use hit exactly this — `SELECT i.name` took the whole
 * tool down with a D1_ERROR, which the model surfaced to the user as a platform failure.
 */
function buildEnv(opts: { edges?: Array<[string, string]>; instances?: Array<Record<string, unknown>> } = {}) {
	const INSTANCE_COLUMNS = new Set(["id", "user_id", "agent_id", "status", "config", "created_at", "updated_at"]);
	const env = {
		DB: {
			prepare(sql: string) {
				// Reject any column the real table does not have, the way D1 would.
				for (const m of sql.matchAll(/\bi\.([a-z_]+)\b/g)) {
					if (!INSTANCE_COLUMNS.has(m[1])) throw new Error(`D1_ERROR: no such column: i.${m[1]}`);
				}
				return {
					bind() {
						return {
							async all() {
								if (sql.includes("FROM agent_supervision")) {
									return {
										results: (opts.edges ?? [["sup", "sub"]]).map(([s, sub]) => ({
											supervisor_instance_id: s,
											subordinate_instance_id: sub,
										})),
									};
								}
								if (sql.includes("FROM agent_instances")) {
									return { results: opts.instances ?? [{ id: "sub", status: "active", config: null, agent_name: "Repo Coder" }] };
								}
								return { results: [] };
							},
							async first() { return null; },
							async run() { return { meta: { changes: 1 } }; },
						};
					},
				};
			},
		},
	} as unknown as Env;
	return env;
}

const ctx = (env: Env) => ({ env, userId: "u1", instanceId: "sup" });

describe("list_subordinates", () => {
	it("does not select a column agent_instances lacks", async () => {
		// The regression guard. `agent_instances` has no `name`; a per-instance display name
		// lives in config.displayName. Getting this wrong is a hard error, not a soft miss.
		const r = await tool("list_subordinates").handler(ctx(buildEnv()) as never, {});
		expect(r.success).toBe(true);
		expect(r.content).not.toContain("D1_ERROR");
	});

	it("falls back to the template's name", async () => {
		const r = await tool("list_subordinates").handler(ctx(buildEnv()) as never, {});
		expect(JSON.parse(r.content)).toEqual([{ instanceId: "sub", name: "Repo Coder", status: "active" }]);
	});

	it("prefers a per-instance display name when the owner set one", async () => {
		const env = buildEnv({ instances: [{ id: "sub", status: "active", config: JSON.stringify({ displayName: "API repo" }), agent_name: "Repo Coder" }] });
		expect(JSON.parse((await tool("list_subordinates").handler(ctx(env) as never, {})).content)[0].name).toBe("API repo");
	});

	it("still lists a subordinate whose config is malformed", async () => {
		// A broken config must not make an agent invisible to its supervisor.
		const env = buildEnv({ instances: [{ id: "sub", status: "active", config: "{not json", agent_name: "Repo Coder" }] });
		expect(JSON.parse((await tool("list_subordinates").handler(ctx(env) as never, {})).content)[0].name).toBe("Repo Coder");
	});

	it("says so plainly when there is nobody to delegate to", async () => {
		const r = await tool("list_subordinates").handler(ctx(buildEnv({ edges: [] })) as never, {});
		expect(r.success).toBe(true);
		expect(r.content).toMatch(/do not supervise any agents/i);
	});
});

describe("tool shape", () => {
	it("gates delegate_goal as a write — it starts real work and spends real money", () => {
		expect(tool("delegate_goal").scope).toBe("write");
		expect(tool("list_subordinates").scope).toBe("read");
		expect(tool("check_delegation").scope).toBe("read");
	});

	it("belongs to the supervision connector so registry gating applies", () => {
		for (const t of SUPERVISION_TOOLS) expect(t.connector).toBe("supervision");
	});
});

describe("check_delegation", () => {
	it("asks for one of the two identifiers rather than guessing", async () => {
		const r = await tool("check_delegation").handler(ctx(buildEnv()) as never, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/runId|instanceId/);
	});
});
