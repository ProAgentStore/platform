import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRegistryTool } from "./tool-registry.js";
import type { RegistryToolCtx } from "./tool-registry.js";

/**
 * The delegation context has to survive the whole path a supervisor's run takes:
 *
 *   AgentLoopWorkflow → DO /chat → runAgentThink → runRegistryTool ctx → delegate_goal
 *
 * All three fields were WRITTEN and never READ on that path — the only path an agent's own brain
 * can delegate through. So the per-tree budget bound (#184), the delegated-tool audit (#185) and
 * the multi-level trace (#183) were each inert in production while their unit tests passed,
 * because those tests hand-inject what no production caller supplied.
 */
const calls: Array<Record<string, unknown>> = [];

vi.mock("./delegate-instance.js", () => ({
	delegateToInstance: async (_env: unknown, input: Record<string, unknown>) => {
		calls.push(input);
		return { ok: true, runId: "r1", depth: 1 };
	},
}));

const tool = getRegistryTool("delegate_goal")!;

async function delegateWith(ctx: Partial<RegistryToolCtx>) {
	await tool.handler({ env: {} as never, userId: "u1", instanceId: "sup", ...ctx } as RegistryToolCtx, {
		instanceId: "sub",
		objective: "get the tests green",
	});
	return calls[calls.length - 1];
}

beforeEach(() => {
	calls.length = 0;
});

describe("delegate_goal — forwards the delegation context it is given", () => {
	it("SHARES the tree's budget rather than letting a fresh pool be opened", async () => {
		// `delegateToInstance` falls back to `openBudget(...)` when it gets no budgetId, so every
		// agent-initiated delegation opened its own pool: the tree's real ceiling became
		// allowance × (number of delegation edges) — the fanout blowup the budget exists to stop.
		expect((await delegateWith({ budgetId: "tree-pool" })).budgetId).toBe("tree-pool");
	});

	it("passes the emitting run as parentTraceId so a chain renders as one tree", async () => {
		expect((await delegateWith({ traceId: "run-42" })).parentTraceId).toBe("run-42");
	});

	it("leaves the budget absent for a ROOT delegation — a fresh pool is correct there", async () => {
		const input = await delegateWith({});
		expect(input.budgetId).toBeUndefined();
		expect(input.parentTraceId).toBeNull();
	});

	it("still routes the supervisor and subordinate it was called with", async () => {
		const input = await delegateWith({ budgetId: "tree-pool", traceId: "run-42" });
		expect(input).toMatchObject({ supervisorInstanceId: "sup", subordinateInstanceId: "sub", userId: "u1" });
	});
});
