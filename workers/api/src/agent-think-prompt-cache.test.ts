/**
 * The chat prompt's cacheable half stays byte-identical across turns (#768) — proved against the
 * real `runAgentThink`, with only the provider faked.
 *
 * The provider caches an identical PREFIX. Before this split the per-turn facts — retrieved
 * documents, memory, tasks, the clock — were appended between fixed paragraphs, so the prompt
 * changed a few sections in and every fixed instruction after that point was re-written to the
 * cache on every turn. The split is only worth anything while the first block really does repeat,
 * and a per-turn fact appended to `systemPrompt` by a later change would silently undo it. That is
 * what this file catches: two turns that differ in everything per-turn, one stable block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentState, AgentTask, MemoryEntry } from "./agent-types.js";
import { FENCE_TAG } from "./lib/untrusted-fence.js";
import { anthropicSystemBlocks, isSystemPromptBlocks, type SystemPromptBlock } from "./lib/user-ai.js";

const sent: Array<{ messages: { role: string; content: unknown }[] }> = [];

vi.mock("./lib/user-ai.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/user-ai.js")>()),
	runUserWorkersAi: async (_env: unknown, _userId: unknown, _model: string, body: unknown) => {
		sent.push(body as { messages: { role: string; content: unknown }[] });
		return { response: "Noted." };
	},
}));

const { runAgentThink } = await import("./agent-think.js");

/** A D1 that answers everything with "nothing here" — the prompt builders read, they do not need rows. */
const emptyRow = {
	async first() {
		return null;
	},
	async all() {
		return { results: [] };
	},
	async run() {
		return { success: true };
	},
};
const env = { DB: { prepare: () => ({ bind: () => emptyRow, ...emptyRow }) } } as never;

const doStorage = {
	get: async () => undefined,
	list: async () => new Map(),
	put: async () => undefined,
	delete: async () => false,
} as never;

const engineWith = (rag: string) =>
	({
		buildRAGContext: async () => rag,
		getUserContext: async () => ({ preferences: {}, interactionCount: 0 }),
		touchUserContext: async () => undefined,
		logEvent: async () => undefined,
	}) as never;

const state: AgentState = {
	agentId: "inst-768",
	name: "Repo Coder",
	personality: "direct",
	goal: "help with the repo",
	model: "claude-sonnet-4-6",
	status: "idle",
	systemPrompt: "You are Repo Coder, the agent for acme/web.",
	guardrails: { topicRestrictions: "", blockedTerms: [], responseStyle: "", maxResponseLength: 0, requireCitations: false },
	welcomeMessage: "",
	isPublished: true,
};

const userTurn = (content: string): AgentMessage[] => [{ id: `m-${content.length}`, role: "user", content, channel: "chat", createdAt: new Date().toISOString() }];

/** Everything per-turn differs between these two: clock, retrieval, memory, tasks, the question. */
async function systemBlocksOfTurn(turn: { at: string; rag: string; memory: MemoryEntry[]; tasks: AgentTask[]; ask: string }): Promise<SystemPromptBlock[]> {
	vi.setSystemTime(new Date(turn.at));
	sent.length = 0;
	await runAgentThink({
		state,
		engine: engineWith(turn.rag),
		messages: userTurn(turn.ask),
		memory: turn.memory,
		tasks: turn.tasks,
		userId: "u1",
		env,
		doStorage,
		broadcast: () => undefined,
	});
	const system = sent[0]?.messages.find((m) => m.role === "system")?.content;
	if (!isSystemPromptBlocks(system)) throw new Error("the chat turn did not send its system prompt as blocks");
	return system;
}

const FIRST = {
	at: "2026-09-13T01:00:00Z",
	rag: "",
	memory: [],
	tasks: [],
	ask: "What does this repo do?",
};
const SECOND = {
	at: "2026-09-13T04:37:00Z",
	rag: "deploy.md: production deploys from the main branch.",
	memory: [{ key: "deploy_target", type: "knowledge", content: "deploys from main", updatedAt: "2026-09-13T02:00:00Z", source: "user" }] satisfies MemoryEntry[],
	tasks: [{ id: "t1", title: "Fix the flaky login test", description: "fails one run in five", status: "in_progress", assignedBy: "user", createdAt: "2026-09-13T03:00:00Z", updatedAt: "2026-09-13T03:00:00Z" }] satisfies AgentTask[],
	ask: "And where does it deploy from?",
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("the chat system prompt is sent as stable → turn → closing blocks (#768)", () => {
	it("sends the three halves in that order, labelled", async () => {
		const blocks = await systemBlocksOfTurn(SECOND);
		expect(blocks.map((b) => b.label)).toEqual(["stable", "turn", "closing"]);
		expect(blocks.map((b) => Boolean(b.cache))).toEqual([true, false, true]);
	});

	it("keeps the stable block byte-identical across turns that differ in every per-turn fact", async () => {
		const [a, b] = [await systemBlocksOfTurn(FIRST), await systemBlocksOfTurn(SECOND)];
		expect(b[0].text).toBe(a[0].text);
		// …and the difference really is there, in the per-turn half — otherwise the equality above
		// would prove only that neither turn carried anything.
		expect(b[1].text).not.toBe(a[1].text);
	});

	it("puts every per-turn fact in the turn block, and none of them in the stable one", async () => {
		const [stable, turn] = await systemBlocksOfTurn(SECOND);
		for (const fact of ["production deploys from the main branch", "deploys from main", "Fix the flaky login test"]) {
			expect(turn.text, fact).toContain(fact);
			expect(stable.text, fact).not.toContain(fact);
		}
		// The retrieved text keeps its fence wherever it moves: it is attacker-writable.
		expect(turn.text).toContain(`<${FENCE_TAG}`);
		expect(stable.text).not.toContain(FENCE_TAG);
	});

	it("keeps honesty and style LAST — after retrieved documents, never before them", async () => {
		// End position carries weight; this is why the closing rules are their own block rather than
		// part of the stable one. Put them in the first block and fenced, attacker-writable text
		// becomes the last thing the model reads.
		const [stable, turn, closing] = await systemBlocksOfTurn(SECOND);
		expect(closing.text).toContain("HONESTY:");
		expect(stable.text).not.toContain("HONESTY:");
		expect(turn.text).not.toContain("HONESTY:");
		// The agent's own identity leads, as it always did.
		expect(stable.text.startsWith(state.systemPrompt)).toBe(true);
	});

	it("reaches the provider with a breakpoint after the stable block and after the closing one", async () => {
		const provider = anthropicSystemBlocks(await systemBlocksOfTurn(SECOND)) ?? [];
		expect(provider.map((b) => Boolean(b.cache_control))).toEqual([true, false, true]);
	});
});
