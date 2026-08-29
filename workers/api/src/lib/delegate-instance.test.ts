import { describe, expect, it } from "vitest";
import { delegateToInstance } from "./delegate-instance.js";
import type { Env } from "../types.js";

/** A registered, heartbeating runner — the default state these tests reason from. */
const RUNTIME_ROW = {
	instance_id: "sub",
	endpoint_url: "https://runner.local",
	token_plaintext: "t",
	runner_node: "macbook",
	runner_version: "0.4.32",
	last_seen_at: "2026-08-06 06:00:00",
};

/** D1 + workflow stub. `edges` seeds the owner's supervision graph. */
function buildEnv(
	edges: Array<[string, string]> = [["sup", "sub"]],
	opts: { targetConfig?: string | null; repos?: unknown[]; session?: unknown } = {},
) {
	const created: Array<Record<string, unknown>> = [];
	const codingCreated: Array<Record<string, unknown>> = [];
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					// Bind-less .run() — reached by logEvent's opportunistic retention DELETE (#680).
					async run() { return { meta: { changes: 0 } }; },
					bind(...args: unknown[]) {
						return {
							async first() {
								// The capability lookup that decides chat-loop vs Pilot.
								if (sql.includes("JOIN agents a ON a.id = i.agent_id")) {
									// Default to a PLAIN agent. agentCapabilities also has a slug/category
									// fallback for legacy agents, so a coder-ish slug here would route
									// every case to the Pilot and hide the branch under test.
									return opts.targetConfig
										? { slug: "coder-repo", category: "code", config: opts.targetConfig }
										: { slug: "doc-chat", category: "productivity", config: null };
								}
								if (sql.includes("FROM coding_sessions")) return opts.session ?? null;
								// A CONNECTED runner. The coding driver reads connectivity before it
								// does anything now (#271), so without this every coding case would
								// silently assert against the runner-offline path instead.
								if (sql.includes("FROM instance_runtimes") || sql.includes("FROM instance_runtime_nodes")) return RUNTIME_ROW;
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
								if (sql.includes("FROM coding_repos")) return { results: opts.repos ?? [] };
								if (sql.includes("FROM instance_runtimes")) return { results: [RUNTIME_ROW] };
								if (sql.includes("FROM instance_runtime_nodes")) return { results: [] };
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
		RELAY: {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					if (new URL(req.url).pathname === "/status") return new Response(JSON.stringify({ connected: true }));
					return new Response(JSON.stringify({ ok: true }));
				},
			}),
		},
		AGENT_LOOP: {
			async create(arg: Record<string, unknown>) {
				created.push(arg);
				return { id: String(arg.id) };
			},
		},
		CODING_SESSION: {
			async create(arg: Record<string, unknown>) {
				codingCreated.push(arg);
				return { id: "wf-coding" };
			},
		},
	} as unknown as Env;
	return { env, created, codingCreated, writes };
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

describe("delegateToInstance routes by the target's declared capability", () => {
	const CODING_CFG = JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } });
	const REPO = { id: "r1", name: "fas/platform", clone_url: null, branch: null, workdir: "~/dev/x", status: "ready" };
	const SESSION = { id: "s1", repo_id: "r1", client_type: "claude", runner_node: "mac", status: "active" };

	it("sends a CODING agent's goal to the Pilot, not the chat loop", async () => {
		// The live gap: a coding agent's work happens in its Pilot driving a real CLI. Routed to
		// the chat loop it would TALK about the repo and change nothing — success on the board,
		// no work done.
		const { env, created, codingCreated } = buildEnv([["sup", "sub"]], {
			targetConfig: CODING_CFG, repos: [REPO], session: SESSION,
		});
		const res = await delegateToInstance(env, base);
		expect(res.ok).toBe(true);
		expect(codingCreated).toHaveLength(1);
		expect(created).toHaveLength(0); // NOT the generic chat loop
		expect((codingCreated[0].params as { goal: { objective: string } }).goal.objective).toBe("ship the thing");
	});

	it("still uses the chat loop for a non-coding agent", async () => {
		const { env, created, codingCreated } = buildEnv();
		expect((await delegateToInstance(env, base)).ok).toBe(true);
		expect(created).toHaveLength(1);
		expect(codingCreated).toHaveLength(0);
	});

	it("refuses explicitly when the coding agent has no repo", async () => {
		// A silent no-op leaves a board card that looks delegated and never moves.
		const { env, codingCreated } = buildEnv([["sup", "sub"]], { targetConfig: CODING_CFG, repos: [] });
		const res = await delegateToInstance(env, base);
		expect(res).toMatchObject({ ok: false, status: 409 });
		expect(codingCreated).toHaveLength(0);
	});

	it("refuses with actionable wording when there is no live session", async () => {
		const { env, codingCreated } = buildEnv([["sup", "sub"]], { targetConfig: CODING_CFG, repos: [REPO], session: null });
		const res = await delegateToInstance(env, base);
		expect(res.ok).toBe(false);
		expect((res as { error: string }).error).toMatch(/pags up|Coding tab/);
		expect(codingCreated).toHaveLength(0);
	});

	it("passes the tree's budget to the Pilot — a delegated coding run must be metered", async () => {
		// Without this the Pilot inherits a pool id and never draws on it, leaving unbounded
		// spend on exactly the path a supervisor can trigger with nobody watching.
		const { env, codingCreated } = buildEnv([["sup", "sub"]], { targetConfig: CODING_CFG, repos: [REPO], session: SESSION });
		await delegateToInstance(env, { ...base, budgetId: "parent-pool" });
		const params = codingCreated[0].params as { budgetId: string; depth: number };
		expect(params.budgetId).toBe("parent-pool");
		expect(typeof params.depth).toBe("number");
	});

	it("opens a loop-run row so check_delegation can actually answer", async () => {
		// The tool tells the supervisor to track the returned id with check_delegation, which
		// reads agent_loop_runs. Returning a board-task id instead made those instructions a lie.
		const { env, writes, codingCreated } = buildEnv([["sup", "sub"]], { targetConfig: CODING_CFG, repos: [REPO], session: SESSION });
		const res = await delegateToInstance(env, base);
		expect(writes.some((w) => w.sql.includes("INSERT INTO agent_loop_runs"))).toBe(true);
		// The id handed back is the one that row uses, and the workflow gets it to close.
		expect((codingCreated[0].params as { loopRunId: string }).loopRunId).toBe((res as { runId: string }).runId);
	});

	it("opens an observable board task so the delegation is trackable", async () => {
		const { env, writes } = buildEnv([["sup", "sub"]], { targetConfig: CODING_CFG, repos: [REPO], session: SESSION });
		await delegateToInstance(env, base);
		expect(writes.some((w) => w.sql.includes("instance_runtime_tasks"))).toBe(true);
	});
});
