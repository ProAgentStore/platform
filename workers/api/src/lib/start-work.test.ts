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
