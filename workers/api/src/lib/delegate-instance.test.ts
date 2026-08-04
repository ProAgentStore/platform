import { describe, expect, it } from "vitest";
import { delegateToInstance } from "./delegate-instance.js";
import type { Env } from "../types.js";

/** D1 + workflow stub. `edges` seeds the owner's supervision graph. */
function buildEnv(edges: Array<[string, string]> = [["sup", "sub"]]) {
	const created: Array<Record<string, unknown>> = [];
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes("FROM delegation_budgets")) {
									return {
										id: "new-budget", user_id: "u1", root_instance_id: "sup",
										cost_micros_limit: 5_000_000, cost_micros_reserved: 0, cost_micros_spent: 0,
										delegations_limit: 50, delegations_used: 0, max_depth: 4,
										status: "open", exhausted_reason: null, exhausted_at_depth: null,
										created_at: "", updated_at: "",
									};
								}
								return null;
							},
							async all() {
								if (sql.includes("FROM agent_supervision")) {
									return {
										results: edges.map(([s, sub]) => ({
											supervisor_instance_id: s,
											subordinate_instance_id: sub,
										})),
									};
								}
								return { results: [] };
							},
							async run() {
								writes.push({ sql, args });
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
		AGENT_LOOP: {
			async create(arg: Record<string, unknown>) {
				created.push(arg);
				return { id: String(arg.id) };
			},
		},
	} as unknown as Env;
	return { env, created, writes };
}

const base = {
	userId: "u1",
	supervisorInstanceId: "sup",
	subordinateInstanceId: "sub",
	objective: "ship the thing",
};

describe("delegateToInstance — the graph is the authority", () => {
	it("starts a durable loop on the subordinate", async () => {
		const { env, created } = buildEnv();
		const res = await delegateToInstance(env, base);
		expect(res.ok).toBe(true);
		expect(created).toHaveLength(1);
		const params = created[0].params as Record<string, unknown>;
		expect(params.instanceId).toBe("sub"); // runs on the SUBORDINATE's brain
		expect(params.objective).toBe("ship the thing");
	});

	it("REFUSES delegation to an instance that is not a subordinate", async () => {
		// Without this the graph would be decorative: any instance could drive any other,
		// re-creating the bypass #185 closes from a different direction.
		const { env, created } = buildEnv([["sup", "someone-else"]]);
		const res = await delegateToInstance(env, base);
		expect(res).toMatchObject({ ok: false, status: 403 });
		expect(created).toHaveLength(0); // and never kicks the workflow
	});

	it("refuses self-delegation", async () => {
		const { env } = buildEnv([["sup", "sup"]]);
		const res = await delegateToInstance(env, { ...base, subordinateInstanceId: "sup" });
		expect(res).toMatchObject({ ok: false, status: 400 });
	});

	it("requires an objective", async () => {
		const { env } = buildEnv();
		expect(await delegateToInstance(env, { ...base, objective: "  " })).toMatchObject({ ok: false, status: 400 });
	});

	it("rejects an oversized objective", async () => {
		const { env } = buildEnv();
		expect(await delegateToInstance(env, { ...base, objective: "x".repeat(2001) })).toMatchObject({ ok: false, status: 400 });
	});
});

describe("delegateToInstance — depth and budget cannot be understated by the caller", () => {
	it("derives depth from the GRAPH, not from the request", async () => {
		// A subordinate that could name its own depth would escape the cap by claiming 0.
		const { env, created } = buildEnv([["root", "sup"], ["sup", "sub"]]);
		const res = await delegateToInstance(env, base);
		expect(res).toMatchObject({ ok: true, depth: 2 });
		expect((created[0].params as { depth: number }).depth).toBe(2);
	});

	it("INHERITS the parent's budget instead of opening a fresh pool per hop", async () => {
		// A new pool per hop is the per-path copy that makes a tree cost
		// allowance × fanout^depth — unbounded in the quantity being bounded.
		const { env, created } = buildEnv();
		const res = await delegateToInstance(env, { ...base, budgetId: "parent-pool" });
		expect(res).toMatchObject({ ok: true, budgetId: "parent-pool" });
		expect((created[0].params as { budgetId: string }).budgetId).toBe("parent-pool");
	});

	it("opens a pool only for a ROOT delegation", async () => {
		const { env } = buildEnv();
		const res = await delegateToInstance(env, base);
		expect(res).toMatchObject({ ok: true, budgetId: "new-budget" });
	});
});

describe("delegateToInstance — authority and trace", () => {
	it("passes the supervisor as onBehalfOf only — audit, never permission", async () => {
		// #185: the subordinate executes with its OWN consent and tools.
		const { env, created } = buildEnv();
		await delegateToInstance(env, base);
		const params = created[0].params as Record<string, unknown>;
		expect(params.onBehalfOf).toBe("sup");
		expect(params.instanceId).toBe("sub");
	});

	it("logs under the PARENT's trace so a multi-level tree reads as one run", async () => {
		const { env, writes } = buildEnv();
		await delegateToInstance(env, { ...base, parentTraceId: "trace-root" });
		const events = writes.filter((w) => w.sql.includes("agent_events"));
		expect(events.length).toBeGreaterThan(0);
		expect(events.some((w) => w.args.includes("trace-root"))).toBe(true);
	});

	it("records a run row before the workflow starts, so a crash is still visible", async () => {
		const { env, writes } = buildEnv();
		await delegateToInstance(env, base);
		expect(writes.some((w) => w.sql.includes("INSERT INTO agent_loop_runs"))).toBe(true);
	});
});
