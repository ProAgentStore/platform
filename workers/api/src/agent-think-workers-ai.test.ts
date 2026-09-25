/**
 * End to end on Cloudflare Workers AI (#851): objective in → tool calls out → terminal read →
 * progress reported, for both brains — the chat brain (`runAgentThink`) and the Pilot
 * (`decideCodingAction`).
 *
 * Only the two edges are faked: Cloudflare's REST endpoint (`fetch`, answering in each model's
 * published output shape) and the runner behind `read_terminal`/`send_to_cli`. Everything between
 * them is real — the credential lookup that picks Workers AI over Anthropic, `runCloudflareAi`, the
 * protocol mapping, the round loop, the allow-list and the dedup — so what is asserted is the body
 * Cloudflare would receive and what the owner would read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentState } from "./agent-types.js";
import { CHAT_MAX_TOKENS } from "./lib/reply-truncation.js";

vi.mock("./lib/crypto.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/crypto.js")>()),
	decryptKey: async () => JSON.stringify({ accountId: "acct", token: "cf-token" }),
}));

/** The machine behind the coding tools: what the owner's terminal shows after the instruction. */
const PANE = "$ pnpm test\n✓ 12 tests passed";
const ran: string[] = [];
vi.mock("./lib/storage-tools.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/storage-tools.js")>()),
	executeStorageTool: async (call: { name: string }) => {
		ran.push(call.name);
		if (call.name === "read_terminal") return { name: call.name, content: `[live · idle]\n${PANE}`, success: true };
		if (call.name === "send_to_cli") return { name: call.name, content: "Sent to the Engine.", success: true };
		return { name: call.name, content: "ok", success: true };
	},
}));

const { runAgentThink } = await import("./agent-think.js");
const { decideCodingAction } = await import("./lib/coding-loop.js");

/** Cloudflare's REST endpoint: one scripted `result` per call, and every request kept. */
let script: unknown[] = [];
let requests: Array<{ url: string; body: { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools?: unknown[]; max_tokens?: number } & Record<string, unknown> }> = [];

/** The owner has Cloudflare credentials and no Anthropic key — the path this issue is about. */
const env = {
	KEY_ENCRYPTION_KEY: "k",
	DB: {
		prepare(sql: string) {
			const result = {
				async first() {
					return /FROM user_api_keys/.test(sql) && /provider = 'cloudflare'/.test(sql)
						? { key_ciphertext: new ArrayBuffer(1), dek_wrapped: new ArrayBuffer(1), iv: new ArrayBuffer(1), account_id: "acct", key_hint: "oken" }
						: null;
				},
				async all() {
					return { results: [] };
				},
				async run() {
					return { success: true };
				},
			};
			return { bind: () => result, ...result };
		},
	},
} as never;

beforeEach(() => {
	ran.length = 0;
	requests = [];
	script = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		requests.push({ url: decodeURIComponent(String(url)), body: JSON.parse(String(init?.body ?? "{}")) });
		const next = script.shift();
		if (next === undefined) throw new Error("the fake Workers AI ran out of scripted replies");
		return new Response(JSON.stringify({ success: true, result: next }), { status: 200, headers: { "content-type": "application/json" } });
	});
});
afterEach(() => vi.unstubAllGlobals());

const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const QWEN = "@cf/qwen/qwen2.5-coder-32b-instruct";
const scoutCall = (id: string, name: string, args: Record<string, unknown>) => ({ response: "", tool_calls: [{ id, type: "function", function: { name, arguments: args } }] });

const state = (model: string): AgentState => ({
	agentId: "inst-851",
	name: "Repo Coder",
	personality: "direct",
	goal: "drive the coding engine",
	model,
	status: "idle",
	systemPrompt: "",
	guardrails: { topicRestrictions: "", blockedTerms: [], responseStyle: "", maxResponseLength: 0, requireCitations: false },
	welcomeMessage: "",
	isPublished: true,
});
const objective: AgentMessage[] = [
	{ id: "m1", role: "user", content: "Run the tests in platform and tell me how it went.", channel: "chat", createdAt: new Date().toISOString() },
];

async function think(model: string) {
	const progress: Array<{ tool: unknown; success: unknown }> = [];
	const out = await runAgentThink({
		state: state(model),
		engine: {
			buildRAGContext: async () => "",
			getUserContext: async () => ({ preferences: {}, interactionCount: 0 }),
			touchUserContext: async () => undefined,
			logEvent: async () => undefined,
		} as never,
		messages: objective,
		memory: [],
		tasks: [],
		userId: "u1",
		env,
		doStorage: { get: async () => undefined, list: async () => new Map(), put: async () => undefined, delete: async () => false } as never,
		broadcast: (d) => {
			if (d.type === "tool_call") progress.push({ tool: d.tool, success: (d.result as { success?: unknown }).success });
		},
	});
	return { ...out, progress };
}

const toolTurns = (i: number) => requests[i].body.messages.filter((m) => m.role === "tool");
const narrated = () => requests.some((r) => r.body.messages.some((m) => m.role === "assistant" && String(m.content).startsWith("I called tools")));

describe("the chat brain on Workers AI (#851)", () => {
	it("Scout: objective in → send_to_cli → read_terminal → progress reported, results in the tool role", async () => {
		script = [
			scoutCall("abc123XYZ", "send_to_cli", { repo_name: "platform", message: "run the tests" }),
			scoutCall("def456UVW", "read_terminal", { repo_name: "platform" }),
			{ response: "The tests ran: ✓ 12 tests passed." },
		];
		const out = await think(SCOUT);

		// G1: the tools really ran, in order — nothing below means anything on a turn that ran none.
		expect(ran).toEqual(["send_to_cli", "read_terminal"]);
		expect(requests).toHaveLength(3);
		expect(requests.every((r) => r.url.endsWith(`/accounts/acct/ai/run/${SCOUT}`))).toBe(true);

		// The request Workers AI validates: tools offered, a real output cap, only schema fields.
		expect(requests[0].body.tools?.length).toBeGreaterThan(0);
		expect(requests[0].body.max_tokens).toBe(CHAT_MAX_TOKENS);
		expect(requests[0].body).not.toHaveProperty("maxTokens");
		expect(requests.every((r) => r.body.messages.every((m) => typeof m.content === "string"))).toBe(true);

		// Results in the platform's role, answering the call by id — never narrated as the model's prose.
		expect(toolTurns(1)).toEqual([{ role: "tool", content: "[send_to_cli]: Sent to the Engine.", tool_call_id: "abc123XYZ" }]);
		expect(toolTurns(2).at(-1)).toMatchObject({ tool_call_id: "def456UVW" });
		expect(String(toolTurns(2).at(-1)?.content)).toContain("12 tests passed");
		expect(narrated()).toBe(false);

		// Progress: the owner's live tool feed and the turn's tool log, as on the Anthropic path.
		expect(out.progress).toEqual([
			{ tool: "send_to_cli", success: true },
			{ tool: "read_terminal", success: true },
		]);
		expect(out.toolCalls.join("\n")).toMatch(/send_to_cli[\s\S]*read_terminal/);
		expect(out.response).toContain("12 tests passed");
		console.log(`✓ Scout: ${ran.length} tools executed over ${requests.length} Workers AI calls, ${out.progress.length} progress events`);
	});

	it("Llama 3.3: a call written into the reply text is executed, not shown", async () => {
		script = [{ response: '{"name": "read_terminal", "parameters": {"repo_name": "platform"}}' }, { response: "Terminal shows ✓ 12 tests passed." }];
		const out = await think(LLAMA);
		expect(ran).toEqual(["read_terminal"]);
		expect(requests[1].url).toContain(LLAMA);
		expect(String(toolTurns(1)[0].content)).toContain("12 tests passed");
		expect(out.response).not.toContain('"name"');
		expect(out.response).toContain("12 tests passed");
	});

	it("Qwen: announcing an action is not taking it — asked once, then it calls the tool", async () => {
		script = [
			{ response: "Let me check the terminal for you." },
			{ response: "", tool_calls: [{ name: "read_terminal", arguments: { repo_name: "platform" } }] },
			{ response: "✓ 12 tests passed." },
		];
		const out = await think(QWEN);
		expect(ran).toEqual(["read_terminal"]);
		const asked = requests[1].body.messages.at(-1);
		expect(asked?.role).toBe("user");
		expect(String(asked?.content)).toMatch(/call it now/);
		expect(out.response).toContain("12 tests passed");
	});
});

describe("the Pilot on Workers AI (#851)", () => {
	const goal = { objective: "Run the tests and fix any failure.", repo: "platform", clientType: "claude" as const };
	const snapshot = { pane: PANE, runState: "idle" as const, ready: true, alive: true };

	it("reads the terminal it is given and answers with Scout's nested call as a real decision", async () => {
		script = [scoutCall("abc123XYZ", "send_message", { text: "Fix the failing test", learned: "12 tests passed before the fix" })];
		const decision = await decideCodingAction(env, "u1", { goal, actionLog: [], snapshot });

		// The Pilot names Sonnet; on this path that becomes the tool-capable Workers AI default.
		expect(requests[0].url).toContain(`/ai/run/${SCOUT}`);
		expect(typeof requests[0].body.max_tokens).toBe("number");
		expect(String(requests[0].body.messages.at(-1)?.content)).toContain("12 tests passed");
		expect(decision.action).toEqual({ kind: "message", text: "Fix the failing test", author: "pilot" });
		expect(decision.learned).toBe("12 tests passed before the fix");
		expect(decision.stuck).toBeUndefined();
	});

	it("reports progress through finish when the model writes the call as text", async () => {
		script = [{ response: '{"name": "finish", "parameters": {"status": "done", "detail": "All 12 tests pass."}}', usage: { prompt_tokens: 900, completion_tokens: 20 } }];
		const decision = await decideCodingAction(env, "u1", { goal, actionLog: ["1. asked the CLI to run the tests"], snapshot });
		expect(decision.finish).toEqual({ status: "done", detail: "All 12 tests pass." });
		expect(decision.usage).toEqual({ input: 900, output: 20 });
	});
});
