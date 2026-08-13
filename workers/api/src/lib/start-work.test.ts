import { describe, expect, it } from "vitest";
import { registryToolNameSet, getRegistryTool, registryTools } from "./tool-registry.js";
import { CREATOR_SELECTABLE_TOOLS } from "../agent-do-tools.js";
import { toolNamesFor } from "../agent-do-tools.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

const caps = (over: Partial<AgentCapabilities> = {}) =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

/**
 * ONE object, three verbs (#540).
 *
 * `start_work` (#210) and `check_work` (#256) shipped a year apart and the third was never built,
 * which is not a cosmetic asymmetry: the owner asked five times to finish a session and got
 * *"that's controlled by the app on your device"* — a fabrication produced by an agent that had a
 * verb it could not complete. The list is stated once and every assertion below reads it, so adding
 * a fourth lifecycle verb without granting it fails here rather than in production.
 */
const WORK_LIFECYCLE = ["start_work", "check_work", "stop_work"] as const;

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

describe("the work lifecycle travels together — start, check, stop (#540)", () => {
	/**
	 * Every capability profile the platform actually resolves. The point of the matrix is that the
	 * gap #540 reports is a PER-AGENT one, and `tool-reachability.test.ts` is structurally blind to
	 * that: it asks "does SOME agent declare this tool", which is green while the one agent that
	 * needs it goes without (that is how #506 stayed green).
	 */
	const PROFILES: Array<[string, AgentCapabilities]> = [
		["a generic agent with no declared anything", caps()],
		["Repo Chat (repo surface, read-only KB)", caps({ surfaces: ["repo"] })],
		[
			"a Repo Coder — declared allowlist, drive:false, the agent in #540",
			caps({
				surfaces: ["coding"],
				runtime: "coding",
				workflow: "CODING_SESSION",
				tools: ["repo_git", "github_read_issue"],
				surfaceOptions: { coding: { repos: "single", drive: false, copilot: false } },
			} as Partial<AgentCapabilities>),
		],
		["a driving Coder", caps({ surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" })],
		["an apply agent", caps({ surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" })],
	];

	it.each(PROFILES)("%s can start, check AND stop", (_label, profile) => {
		const tools = toolNamesFor(profile);
		for (const verb of WORK_LIFECYCLE) expect(tools.has(verb), `${verb} missing`).toBe(true);
	});

	it("every verb is base tier and none is creator-selectable", () => {
		// Creator-selectable would put the stop behind the same decision that already lost tools on
		// the agents that most needed them: a declared `capabilities.tools` is an AUTHORITATIVE
		// allowlist, so a creator who forgot the verb ships an agent that cannot be told to stop.
		for (const verb of WORK_LIFECYCLE) {
			expect(registryToolNameSet().has(verb), `${verb} is not registered`).toBe(true);
			expect(getRegistryTool(verb)?.tier, `${verb} tier`).toBe("base");
			expect(CREATOR_SELECTABLE_TOOLS.has(verb), `${verb} should not be selectable`).toBe(false);
		}
	});

	it("no fourth `*_work` verb exists outside the family", () => {
		// The assertion that makes the list above a rule rather than a comment: a `pause_work` added
		// to the registry and granted to nobody would pass every test in this file without this one.
		const family = registryTools()
			.map((t) => t.name)
			.filter((n) => n.endsWith("_work"))
			.sort();
		expect(family, "add it to WORK_LIFECYCLE, and to BASE, or name it something that is not a work verb").toEqual(
			[...WORK_LIFECYCLE].sort(),
		);
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
		// Matched on the SHAPE of the run-list read rather than on read ordinal. `check_work` also
		// looks up the owner's timezone now (#329), so pinning `reads[0]` was pinning "which query
		// happens to run first" — a fact about neither this tool's scoping nor its output.
		expect(reads.some((r) => r.args.length === 3 && r.args[0] === "u1" && r.args[1] === "i1" && r.args[2] === 5)).toBe(true);
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

describe("stop_work — the third verb, and the one the owner asked for five times (#540)", () => {
	/**
	 * Mock D1 that also records WRITES, because the whole tool is a write. Reads dispatch on the SQL
	 * the way `check_work`'s mock does; `run()` reports `meta.changes`, which is how `requestCancel`
	 * distinguishes "a running run took the flag" from "there was no running run to take it".
	 */
	function mockEnv(opts: { rows?: unknown[]; delegated?: unknown[]; first?: unknown; changes?: number; capabilities?: unknown } = {}) {
		const writes: { sql: string; args: unknown[] }[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						if (sql.includes("UPDATE")) writes.push({ sql, args });
						return {
							async all() {
								if (sql.includes("delegated_by")) return { results: opts.delegated ?? [] };
								return { results: opts.rows ?? [] };
							},
							async first() {
								// `capabilitiesForInstance` joins agents; everything else here reads a run row.
								if (sql.includes("agent_instances")) return opts.capabilities ?? { slug: "coder-repo", category: "developer", config: "{}" };
								return opts.first ?? null;
							},
							async run() {
								return { meta: { changes: opts.changes ?? 1 } };
							},
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as never, writes };
	}

	const runRow = (over: Record<string, unknown> = {}) => ({
		run_id: "r1",
		user_id: "u1",
		instance_id: "i1",
		objective: "refactor the parser",
		status: "running",
		stop_reason: null,
		detail: null,
		iteration: 4,
		max_iterations: 10,
		cancel_requested: 0,
		budget_id: null,
		started_at: Date.now() - 120_000,
		finished_at: null,
		last_progress_at: Date.now() - 5_000,
		...over,
	});

	it("asks the running run to stop, and says ASKED rather than STOPPED", async () => {
		const { env, writes } = mockEnv({ rows: [runRow()] });
		const res = await getRegistryTool("stop_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
		expect(res?.success).toBe(true);
		expect(String(res?.content)).toMatch(/Asked run r1 to stop/);
		expect(String(res?.content)).toMatch(/REQUEST, not a completed stop/);
		// The write that actually happened: the cooperative flag, scoped to owner + running.
		expect(writes.some((w) => w.sql.includes("cancel_requested = 1") && w.args.includes("r1") && w.args.includes("u1"))).toBe(true);
	});

	it("with nothing running, answers plainly instead of fabricating a stop", async () => {
		// The sentence this replaces, verbatim from production: "I can't stop or end your session
		// from here — that's controlled by the app on your device." No app on his device owns this.
		const { env, writes } = mockEnv({ rows: [] });
		const res = await getRegistryTool("stop_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
		// Success, not an error: an error reads as "could not tell", which is what produces a guess.
		expect(res?.success).toBe(true);
		expect(String(res?.content)).toMatch(/Nothing is running/);
		expect(writes).toEqual([]);
	});

	it("does not cancel a run that has already finished", async () => {
		const { env, writes } = mockEnv({ first: runRow({ status: "completed", stop_reason: "done", finished_at: Date.now() }) });
		const res = await getRegistryTool("stop_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, { runId: "r1" });
		expect(res?.success).toBe(true);
		expect(String(res?.content)).toMatch(/had already ended/);
		expect(writes).toEqual([]);
	});

	it("reuses check_work's ownership test exactly — a sibling agent's run is not stoppable", async () => {
		// Relaxing this would give a Lead the power to cancel runs on agents it does not supervise,
		// which is strictly worse than the read it already has.
		const { env, writes } = mockEnv({ first: runRow({ instance_id: "other" }) });
		const res = await getRegistryTool("stop_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, { runId: "r1" });
		expect(res?.success).toBe(false);
		expect(String(res?.content)).toMatch(/nothing was stopped/i);
		expect(writes).toEqual([]);
	});

	it("stops a run it DELEGATED — the other way a run is yours (#318)", async () => {
		const { env, writes } = mockEnv({ first: runRow({ run_id: "d1", instance_id: "sub-1", delegated_by: "i1" }) });
		const res = await getRegistryTool("stop_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, { runId: "d1" });
		expect(res?.success).toBe(true);
		expect(String(res?.content)).toContain("sub-1");
		expect(writes.some((w) => w.args.includes("d1"))).toBe(true);
	});

	it("stops the delegated runs too when no runId is given", async () => {
		const { env, writes } = mockEnv({ rows: [runRow()], delegated: [runRow({ run_id: "d1", instance_id: "sub-1", delegated_by: "i1" })] });
		const res = await getRegistryTool("stop_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
		expect(writes.map((w) => w.args.find((a) => a === "r1" || a === "d1")).sort()).toEqual(["d1", "r1"]);
		expect(String(res?.content)).toContain("d1");
	});

	it("reports a run that finished between the read and the write as exactly that", async () => {
		// `requestCancel` matched no row. That is not a failure and it is not a stop.
		const { env } = mockEnv({ rows: [runRow()], changes: 0 });
		const res = await getRegistryTool("stop_work")?.handler({ env, instanceId: "i1", userId: "u1" } as never, {});
		expect(String(res?.content)).toMatch(/finished on its own/);
	});

	it("needs an owned instance context", async () => {
		const res = await getRegistryTool("stop_work")?.handler({ env: {} as never } as never, {});
		expect(res?.success).toBe(false);
	});
});
