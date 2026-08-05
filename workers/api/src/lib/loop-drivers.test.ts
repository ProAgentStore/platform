import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LOOP_DRIVER, loopDriverFor, LOOP_DRIVER_IDS } from "./loop-drivers.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { Env } from "../types.js";

const caps = (workflow: string | null): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow, tools: undefined } as unknown as AgentCapabilities);

describe("loopDriverFor — the ONE Loop dispatches on what the agent DECLARES (#210)", () => {
	it("defaults to looping the chat", () => {
		// The right driver for any agent whose work happens through its own tools — a pipeline
		// agent, a doc agent, a connector agent.
		expect(loopDriverFor(caps(null)).id).toBe("chat");
		expect(loopDriverFor(undefined).id).toBe("chat");
		expect(loopDriverFor({} as AgentCapabilities).id).toBe("chat");
	});

	it("routes a coding agent to the engine, not to its own chat", () => {
		// The bug this replaces: the owner's Loop button hardcoded AGENT_LOOP, so on a Repo Coder
		// — whose chat declares drive:false and therefore has NO write tools — it read the repo in
		// a circle and never touched the engine. The supervisor path dispatched correctly; the
		// human's did not.
		expect(loopDriverFor(caps("CODING_SESSION")).id).toBe("coding");
	});

	it("falls back to the chat loop for a workflow with no driver, rather than refusing", () => {
		// JOB_APPLY and BROWSER_TASK need a URL, not an objective, so they have no entry yet.
		// "This agent cannot be looped" would be strictly worse than looping its tools.
		expect(loopDriverFor(caps("JOB_APPLY")).id).toBe(DEFAULT_LOOP_DRIVER.id);
		expect(loopDriverFor(caps("SOMETHING_NEW")).id).toBe(DEFAULT_LOOP_DRIVER.id);
	});

	it("every driver id is distinct — a duplicate would silently shadow one", () => {
		expect(new Set(LOOP_DRIVER_IDS).size).toBe(LOOP_DRIVER_IDS.length);
	});
});

/** Env stub recording the writes + which Workflow binding was created. */
function stubEnv(opts: { repos?: unknown[]; session?: unknown } = {}) {
	const sql: string[] = [];
	const created: Array<{ binding: string; params: Record<string, unknown> }> = [];
	const wf = (binding: string) => ({ create: vi.fn(async (a: { params: Record<string, unknown> }) => { created.push({ binding, params: a.params }); return { id: "wf" }; }) });
	const env = {
		DB: {
			prepare(q: string) {
				sql.push(q);
				return {
					bind() {
						return {
							async run() { return { meta: { changes: 1 } }; },
							async all() { return { results: opts.repos ?? [] }; },
							async first() { return opts.session ?? null; },
						};
					},
				};
			},
		},
		AGENT_LOOP: wf("AGENT_LOOP"),
		CODING_SESSION: wf("CODING_SESSION"),
	} as unknown as Env;
	return { env, sql, created };
}

const base = { objective: "get the suite green", budgetId: "b1", depth: 0, instanceId: "i1", userId: "u1" };

describe("every driver opens an agent_loop_runs row — the fact that makes ONE button possible", () => {
	it("the chat driver does", async () => {
		// `check_delegation`, `subordinate_status` and the console's /loop/:runId poll all read
		// that table. If a driver skipped it, the UI would start a run it could never show, and a
		// supervisor would be handed a run id that resolves to nothing.
		const { env, sql, created } = stubEnv();
		const out = await loopDriverFor(caps(null)).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(sql.some((q) => q.includes("INSERT INTO agent_loop_runs"))).toBe(true);
		expect(created[0].binding).toBe("AGENT_LOOP");
	});

	it("the coding driver does, and threads the SAME run id into the Pilot", async () => {
		const { env, sql, created } = stubEnv({
			repos: [{ id: "r1", name: "fws/platform", instance_id: "i1", user_id: "u1", clone_status: "ready" }],
			session: { id: "s1", client_type: "claude", status: "active" },
		});
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(sql.some((q) => q.includes("INSERT INTO agent_loop_runs"))).toBe(true);
		expect(created[0].binding).toBe("CODING_SESSION");
		// Same id, or the Pilot closes a different row than the one the caller is watching.
		if (out.ok) expect(created[0].params.loopRunId).toBe(out.runId);
	});
});

describe("the coding driver's preconditions are refusals, not crashes", () => {
	it("says what to do when the agent has no repo", async () => {
		const { env } = stubEnv({ repos: [] });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out).toMatchObject({ ok: false, status: 409 });
		if (!out.ok) expect(out.error).toMatch(/no repository/i);
	});

	it("says what to do when nothing is running", async () => {
		const { env } = stubEnv({ repos: [{ id: "r1", name: "fws/platform" }], session: null });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out).toMatchObject({ ok: false, status: 409 });
		if (!out.ok) expect(out.error).toMatch(/pags up/);
	});
});

describe('the "Delegated:" board card belongs to a supervisor, not to the owner', () => {
	const codingEnv = () => stubEnv({
		repos: [{ id: "r1", name: "fws/platform" }],
		session: { id: "s1", client_type: "claude" },
	});

	it("an owner pressing Loop gets NO delegation card — nobody delegated to them", async () => {
		// Their run is already visible as its coding-session card (#206). A card reading
		// "Overseer delegated on your behalf" for work they started themselves would be a lie.
		const { env, sql, created } = codingEnv();
		await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(sql.some((q) => q.includes("'delegation'"))).toBe(false);
		expect(created[0].params.boardTaskId).toBeUndefined();
	});

	it("a supervisor's delegation does get one", async () => {
		const { env, sql, created } = codingEnv();
		await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base, delegated: true });
		expect(sql.some((q) => q.includes("'delegation'"))).toBe(true);
		expect(String(created[0].params.boardTaskId)).toMatch(/^deleg-/);
	});
});
