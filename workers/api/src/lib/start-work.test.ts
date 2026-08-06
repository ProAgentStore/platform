import { describe, expect, it } from "vitest";
import { registryToolNameSet, getRegistryTool } from "./tool-registry.js";
import { CREATOR_SELECTABLE_TOOLS } from "../agent-do-tools.js";
import { toolNamesFor } from "../agent-do-tools.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

const caps = (over: Partial<AgentCapabilities> = {}) =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

describe("start_work — the chat's only way to actually DO something", () => {
	it("exists in the registry", () => {
		// The gap it fills, from a real conversation: a Repo Coder's chat has drive:false, which
		// correctly removes the engine tools (a chat driving the CLI would be a second,
		// uncoordinated driver) — but nothing replaced them. Told to "just do it", the agent
		// reached for the only action-shaped tool it had, invented a pipeline named "coding",
		// failed, and reported that the engine was running.
		expect(registryToolNameSet().has("start_work")).toBe(true);
		expect(getRegistryTool("start_work")?.tier).toBe("base");
	});

	it("is available to EVERY agent, including one with a narrow declared allowlist", () => {
		// A Repo Coder declares only repo_* and github_* tools. If start_work needed declaring,
		// the agent that most needs it would be the one without it.
		const coder = caps({ surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION", tools: ["repo_git"] });
		expect(toolNamesFor(coder).has("start_work")).toBe(true);
	});

	it("is not creator-selectable — it is base, not something to switch off", () => {
		// Declaring it would be redundant and forgetting to would silently mute the agent.
		expect(CREATOR_SELECTABLE_TOOLS.has("start_work")).toBe(false);
	});

	it("refuses on an agent whose executor IS this chat", async () => {
		// Starting a loop of the chat FROM the chat is recursion dressed as delegation. A plain
		// agent (no declared workflow) resolves to the chat driver, so it must decline.
		const env = {
			DB: {
				prepare: () => ({
					bind: () => ({ first: async () => ({ slug: "doc-chat", category: "productivity", config: "{}" }) }),
				}),
			},
		};
		const tool = getRegistryTool("start_work");
		const res = await tool?.handler({ env, instanceId: "i1", userId: "u1" } as never, { objective: "do a thing" });
		expect(res?.success).toBe(false);
		expect(String(res?.content)).toMatch(/no separate executor/i);
	});

	it("refuses an empty objective rather than starting an aimless run", async () => {
		// Rejected BEFORE any lookup, so no DB is needed — which is itself the assertion.
		const tool = getRegistryTool("start_work");
		const res = await tool?.handler({ env: {} as never, instanceId: "i1", userId: "u1" } as never, { objective: "   " });
		expect(res).toMatchObject({ success: false });
	});
});

describe("check_work — the other half: an agent must be able to OBSERVE what it started (#256)", () => {
	/**
	 * Mock D1, dispatching on the SQL. Routed rather than "every .all() returns `rows`" because
	 * check_work now asks three different questions (#318) — this instance's runs, the runs it
	 * DELEGATED, and whether it supervises anyone — and one answer for all three cannot express a
	 * supervisor that has delegated but never run anything itself, which is the whole case.
	 */
	function mockEnv(opts: { rows?: unknown[]; delegated?: unknown[]; edges?: unknown[]; first?: unknown } = {}) {
		const reads: { sql: string; args: unknown[] }[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						reads.push({ sql, args });
						return {
							async all() {
								if (sql.includes("delegated_by")) return { results: opts.delegated ?? [] };
								if (sql.includes("agent_supervision")) return { results: opts.edges ?? [] };
								return { results: opts.rows ?? [] };
							},
							async first() { return opts.first ?? null; },
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as never, reads };
	}

	const row = (over: Record<string, unknown> = {}) => ({
		run_id: "r1",
		user_id: "u1",
		instance_id: "i1",
		objective: "run git pull",
		status: "completed",
		stop_reason: "done",
		detail: "Already up to date.",
		iteration: 1,
		max_iterations: 10,
		cancel_requested: 0,
		budget_id: null,
		started_at: Date.now() - 60_000,
		finished_at: Date.now() - 30_000,
		last_progress_at: Date.now() - 40_000,
		...over,
	});

	it("is granted wherever start_work is — the pair is the point", () => {
		// An agent that can act but cannot observe its own actions is structurally forced to either
		// fabricate or deny. Both happened on the same instance within two days.
		expect(registryToolNameSet().has("check_work")).toBe(true);
		expect(getRegistryTool("check_work")?.tier).toBe("base");
		const coder = caps({ surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION", tools: ["repo_git"] });
		expect(toolNamesFor(coder).has("check_work")).toBe(true);
		expect(CREATOR_SELECTABLE_TOOLS.has("check_work")).toBe(false);
	});

	it("with no runId, reports this instance's recent runs", async () => {
		const { env, reads } = mockEnv({ rows: [row()] });
		const res = await getRegistryTool("check_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
		expect(res?.success).toBe(true);
		expect(String(res?.content)).toContain("Already up to date.");
		expect(reads[0].args).toEqual(["u1", "i1", 5]);
	});

	it("says plainly that nothing ran, so it can contradict its own earlier claim", async () => {
		const { env } = mockEnv({ rows: [] });
		const res = await getRegistryTool("check_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
		// Success, not an error: an error reads as "could not tell", which is the state that
		// produces a guess.
		expect(res?.success).toBe(true);
		expect(String(res?.content)).toMatch(/have not started any work/);
	});

	it("refuses a run belonging to a DIFFERENT instance of the same owner", async () => {
		// getLoopRun is user-scoped, so without the instance check an agent could read a sibling
		// agent's run and report it as its own — a fresh way to describe work it did not do.
		const { env } = mockEnv({ first: row({ instance_id: "other" }) });
		const res = await getRegistryTool("check_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, { runId: "r1" });
		expect(res?.success).toBe(false);
		expect(String(res?.content)).toMatch(/Do not describe it as if it happened/);
	});

	it("needs an owned instance context", async () => {
		const res = await getRegistryTool("check_work")?.handler({ env: {} as never } as never, {});
		expect(res?.success).toBe(false);
	});

	// ── #318: the guard that made a truthful supervisor recant ──────────────
	//
	// A Coder Lead delegated (`delegate_goal` → "Run 97a46cbc… started at depth 1"), told the user
	// so, and 90 seconds later `check_work` answered "You have not started any work on this
	// instance — there are no runs. If you told the user you did something, that was wrong; say
	// so." It complied and retracted a true statement. The scoping was right — a supervisor's runs
	// are simply not ON its instance — and the closing sentence was an inference the record could
	// not support.
	describe("a supervisor's work is on its subordinates, not on itself", () => {
		const delegatedRow = () => row({ run_id: "d1", instance_id: "sub-1", delegated_by: "i1", objective: "clean up FAS platform" });

		it("reports runs this instance DELEGATED, and names the agent they run on", async () => {
			const { env } = mockEnv({ rows: [], delegated: [delegatedRow()] });
			const res = await getRegistryTool("check_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
			expect(res?.success).toBe(true);
			expect(String(res?.content)).toContain("d1");
			expect(String(res?.content)).toContain("sub-1");
			expect(String(res?.content)).not.toMatch(/that was wrong/);
		});

		it("does not tell a delegator it misled the user when it has simply run nothing itself", async () => {
			// The sentence is an assertion about the CONVERSATION, and for a supervisor this record
			// cannot see the work — so it is not entitled to make it. "No runs" stays true and safe.
			const { env } = mockEnv({ rows: [], delegated: [], edges: [{ supervisor_instance_id: "i1", subordinate_instance_id: "sub-1" }] });
			const res = await getRegistryTool("check_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
			expect(res?.success).toBe(true);
			expect(String(res?.content)).not.toMatch(/that was wrong/);
			expect(String(res?.content)).toMatch(/check_delegation/);
		});

		it("KEEPS #254's correction for an agent that delegates to nobody", async () => {
			// The guard earns its place there: this is the agent that ran nothing and claimed it did.
			const { env } = mockEnv({ rows: [], delegated: [], edges: [] });
			const res = await getRegistryTool("check_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
			expect(String(res?.content)).toMatch(/that was wrong; say so/);
		});

		it("accepts a run id it delegated, which instance identity alone rejected", async () => {
			const { env } = mockEnv({ first: delegatedRow() });
			const res = await getRegistryTool("check_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, { runId: "d1" });
			expect(res?.success).toBe(true);
			expect(String(res?.content)).toContain("clean up FAS platform");
		});

		it("still refuses a run on a sibling agent that this one did NOT delegate", async () => {
			// `delegated_by` is an ownership test, not a widening: a run started on another of the
			// owner's agents by somebody else is still not this agent's work.
			const { env } = mockEnv({ first: row({ instance_id: "other", delegated_by: "some-other-lead" }) });
			const res = await getRegistryTool("check_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, { runId: "r1" });
			expect(res?.success).toBe(false);
		});
	});
});
