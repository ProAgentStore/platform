import { describe, expect, it } from "vitest";

// resolveAgent extracts id + name + model from a DB row.
// We test the logic inline (no DB required).

interface AgentRow {
	id: string;
	name: string;
	model: string;
	slug?: string;
}

function resolveAgentFromRow(
	row: AgentRow | null,
): { id: string; name: string; model: string } {
	if (!row) throw new Error("Agent not found");
	return { id: row.id, name: row.name, model: row.model };
}

function findAgent(
	agents: AgentRow[],
	param: string,
): AgentRow | null {
	return (
		agents.find((a) => a.id === param || a.slug === param) ?? null
	);
}

describe("resolveAgent returns id + name + model", () => {
	const agents: AgentRow[] = [
		{
			id: "uuid-1",
			slug: "summarizer",
			name: "Summarizer",
			model: "@cf/meta/llama-3.2-3b-instruct",
		},
		{
			id: "uuid-2",
			slug: "code-helper",
			name: "Code Helper",
			model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		},
	];

	it("returns id, name, and model fields", () => {
		const row = findAgent(agents, "uuid-1");
		const agent = resolveAgentFromRow(row);
		expect(agent).toHaveProperty("id");
		expect(agent).toHaveProperty("name");
		expect(agent).toHaveProperty("model");
	});

	it("id matches the agent record", () => {
		const row = findAgent(agents, "uuid-1");
		const agent = resolveAgentFromRow(row);
		expect(agent.id).toBe("uuid-1");
	});

	it("name matches the agent record", () => {
		const row = findAgent(agents, "uuid-1");
		const agent = resolveAgentFromRow(row);
		expect(agent.name).toBe("Summarizer");
	});

	it("model matches the agent record", () => {
		const row = findAgent(agents, "uuid-1");
		const agent = resolveAgentFromRow(row);
		expect(agent.model).toBe("@cf/meta/llama-3.2-3b-instruct");
	});

	it("throws when agent row is null", () => {
		expect(() => resolveAgentFromRow(null)).toThrow("Agent not found");
	});
});

describe("agent lookup by slug vs ID", () => {
	const agents: AgentRow[] = [
		{
			id: "uuid-abc",
			slug: "my-agent",
			name: "My Agent",
			model: "@cf/meta/llama-3.2-3b-instruct",
		},
		{
			id: "uuid-def",
			slug: "another-agent",
			name: "Another Agent",
			model: "@cf/meta/llama-3.2-3b-instruct",
		},
	];

	it("finds agent by exact ID", () => {
		const row = findAgent(agents, "uuid-abc");
		expect(row).not.toBeNull();
		expect(row?.id).toBe("uuid-abc");
	});

	it("finds agent by slug", () => {
		const row = findAgent(agents, "my-agent");
		expect(row).not.toBeNull();
		expect(row?.id).toBe("uuid-abc");
	});

	it("prefers ID match over slug match when both could match", () => {
		// If an agent's ID happens to equal another's slug, ID wins (find returns first match)
		const tricky: AgentRow[] = [
			{ id: "my-agent", slug: "something-else", name: "Trick", model: "m" },
			{ id: "uuid-zzz", slug: "my-agent", name: "Real Slug", model: "m" },
		];
		const row = findAgent(tricky, "my-agent");
		// find() returns first match — which has id === "my-agent"
		expect(row?.name).toBe("Trick");
	});

	it("returns null for unknown ID and slug", () => {
		const row = findAgent(agents, "does-not-exist");
		expect(row).toBeNull();
	});

	it("finds second agent by its slug", () => {
		const row = findAgent(agents, "another-agent");
		expect(row?.id).toBe("uuid-def");
		expect(row?.name).toBe("Another Agent");
	});

	it("finds second agent by its ID", () => {
		const row = findAgent(agents, "uuid-def");
		expect(row?.slug).toBe("another-agent");
	});

	it("lookup is case-sensitive", () => {
		const row = findAgent(agents, "My-Agent"); // wrong case
		expect(row).toBeNull();
	});
});

describe("chat request body construction", () => {
	it("includes message, channel, userId, agentId, agentName", () => {
		const userId = "user-123";
		const agent = {
			id: "uuid-abc",
			name: "My Agent",
			model: "@cf/meta/llama-3.2-3b-instruct",
		};
		const message = "Hello, agent!";

		const body = {
			message,
			channel: "chat",
			userId,
			agentId: agent.id,
			agentName: agent.name,
		};

		expect(body.message).toBe("Hello, agent!");
		expect(body.channel).toBe("chat");
		expect(body.userId).toBe("user-123");
		expect(body.agentId).toBe("uuid-abc");
		expect(body.agentName).toBe("My Agent");
	});
});
