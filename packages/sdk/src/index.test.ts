import { describe, expect, it } from "vitest";
import { initPro } from "./pro.js";

describe("@proagentstore/sdk", () => {
	it("initPro returns an agent instance with all modules", () => {
		const agent = initPro({ agentId: "test", token: "test-token" });
		expect(agent.agentId).toBe("test");
		expect(agent.ai).toBeDefined();
		expect(agent.db).toBeDefined();
		expect(agent.storage).toBeDefined();
		expect(agent.subscription).toBeDefined();
		expect(agent.usage).toBeDefined();
		expect(agent.chat).toBeTypeOf("function");
		expect(agent.messages).toBeTypeOf("function");
		expect(agent.memory.list).toBeTypeOf("function");
		expect(agent.memory.set).toBeTypeOf("function");
		expect(agent.memory.delete).toBeTypeOf("function");
		expect(agent.tasks.list).toBeTypeOf("function");
		expect(agent.tasks.create).toBeTypeOf("function");
		expect(agent.tasks.update).toBeTypeOf("function");
	});

	it("uses custom API base", () => {
		const agent = initPro({
			agentId: "x",
			token: "t",
			apiBase: "http://localhost:8787",
		});
		expect(agent.agentId).toBe("x");
	});
});
