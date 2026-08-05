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
function buildEnv(opts: { edges?: Array<[string, string]>; instances?: Array<Record<string, unknown>>; work?: unknown[]; runs?: unknown[] } = {}) {
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
								if (sql.includes("FROM instance_runtime_tasks")) return { results: opts.work ?? [] };
								if (sql.includes("FROM agent_loop_runs")) return { results: opts.runs ?? [] };
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
		// `subscription`, not `status` — the field is agent_instances.status, the SUBSCRIPTION
		// lifecycle, which reads "active" for an idle agent and an on-fire one alike. Naming it
		// `status` invited the model to read it as work state; subordinate_status answers that.
		expect(JSON.parse(r.content)).toEqual([{ instanceId: "sub", name: "Repo Coder", subscription: "active" }]);
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

describe("subordinate_status — the observe verb", () => {
	const t = tool("subordinate_status");

	it("is a READ on the supervision connector, so registry gating and consent apply correctly", () => {
		expect(t.scope).toBe("read");
		expect(t.connector).toBe("supervision");
	});

	it("reports what a subordinate is doing, bucketed through THAT agent's declared columns", async () => {
		const env = buildEnv({
			instances: [{
				id: "sub", status: "active", config: null, agent_name: "Repo Coder",
				slug: "coder-repo", category: "code",
				agent_config: JSON.stringify({ capabilities: { surfaces: ["coding"], boardColumns: [
					{ id: "running", title: "Running", color: "#000", statuses: ["running"] },
				] } }),
			}],
			work: [{ instance_id: "sub", id: "t1", type: "delegation", status: "running",
			         payload: JSON.stringify({ title: "Delegated: green the suite" }), updated_at: "2026-08-05T10:00:00.000Z" }],
			runs: [{ instance_id: "sub", run_id: "r1", objective: "green the suite", status: "running", stop_reason: null,
			         detail: null, iteration: 4, max_iterations: 10, started_at: 1, finished_at: null, last_progress_at: 2 }],
		});
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].work[0]).toMatchObject({ status: "running", columnTitle: "Running", title: "Delegated: green the suite" });
		expect(out.subordinates[0].runs[0]).toMatchObject({ objective: "green the suite", iteration: 4, maxIterations: 10 });
	});

	it("REFUSES an instanceId outside the supervision graph rather than reading it", async () => {
		// Same posture as delegate_goal, which re-checks membership inside delegateToInstance
		// instead of trusting the tool description to discourage a model from naming another
		// owner's agent. A read is not exempt: it would leak what that agent is working on.
		const out = await t.handler(ctx(buildEnv()) as never, { instanceId: "someone-elses" });
		expect(out.content).toMatch(/do not supervise that agent/i);
		expect(out.success).toBe(true);
	});

	it("says so plainly when there is nobody to observe", async () => {
		const out = await t.handler(ctx(buildEnv({ edges: [] })) as never, {});
		expect(out.content).toMatch(/do not supervise any agents yet/i);
	});

	it("still reports the roster when the work reads fail — a broken read must not blind the supervisor", async () => {
		const env = {
			DB: {
				prepare(sql: string) {
					return { bind() { return { async all() {
						if (sql.includes("FROM agent_supervision")) return { results: [{ supervisor_instance_id: "sup", subordinate_instance_id: "sub" }] };
						if (sql.includes("FROM agent_instances")) return { results: [{ id: "sub", status: "active", config: null, agent_name: "Repo Coder" }] };
						throw new Error("D1 unavailable");
					} }; } };
				},
			},
		} as unknown as Env;
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].name).toBe("Repo Coder");
		expect(out.subordinates[0].work).toEqual([]);
	});
});
