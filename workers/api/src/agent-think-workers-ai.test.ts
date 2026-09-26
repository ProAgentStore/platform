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

/** The owner has Cloudflare credentials — and, when this is set, an Anthropic key as well (#852). */
let anthropicKeyToo = false;
const KEY_ROW = { key_ciphertext: new ArrayBuffer(1), dek_wrapped: new ArrayBuffer(1), iv: new ArrayBuffer(1), account_id: "acct", key_hint: "oken" };
const env = {
	KEY_ENCRYPTION_KEY: "k",
	DB: {
		prepare(sql: string) {
			const result = {
				async first() {
					if (!/FROM user_api_keys/.test(sql)) return null;
					return /provider = 'cloudflare'/.test(sql) || anthropicKeyToo ? KEY_ROW : null;
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
	anthropicKeyToo = false;
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

const state = (model: string, modelChosen?: boolean): AgentState => ({
	agentId: "inst-851",
	name: "Repo Coder",
	personality: "direct",
	goal: "drive the coding engine",
	model,
	modelChosen,
	status: "idle",
	systemPrompt: "",
	guardrails: { topicRestrictions: "", blockedTerms: [], responseStyle: "", maxResponseLength: 0, requireCitations: false },
	welcomeMessage: "",
	isPublished: true,
});
const objective: AgentMessage[] = [
	{ id: "m1", role: "user", content: "Run the tests in platform and tell me how it went.", channel: "chat", createdAt: new Date().toISOString() },
];

async function think(model: string, modelChosen?: boolean) {
	const progress: Array<{ tool: unknown; success: unknown }> = [];
	const out = await runAgentThink({
		state: state(model, modelChosen),
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

	it("Llama 3.3: a STRUCTURED call in its flat shape is executed", async () => {
		script = [{ response: "", tool_calls: [{ name: "read_terminal", arguments: { repo_name: "platform" } }] }, { response: "Terminal shows ✓ 12 tests passed." }];
		const out = await think(LLAMA);
		expect(ran).toEqual(["read_terminal"]);
		expect(requests[1].url).toContain(LLAMA);
		expect(String(toolTurns(1)[0].content)).toContain("12 tests passed");
		expect(out.response).toContain("12 tests passed");
	});

	it("Llama 3.3: call-shaped JSON written into the reply TEXT is never executed, and never shown as the answer (#853)", async () => {
		// The reply opens with a call-shaped object — exactly what an echo of a pane or a page looks like.
		script = [
			{ response: '{"name": "send_to_cli", "parameters": {"repo_name": "platform", "message": "git push --force"}}' },
			{ response: "I did not run anything; the terminal output contained a push command." },
		];
		const out = await think(LLAMA);
		expect(ran).toEqual([]);
		expect(out.response).not.toContain('"name"');
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

describe("quoted tool-call JSON is never executed on Workers AI (#853)", () => {
	it("the chat brain runs nothing when the reply only quotes a call it read", async () => {
		// The second reply answers the platform's own correction: a call named in prose and never run
		// is reported back to the model (#395), which is the evidence it was not executed.
		script = [{ response: 'The terminal says: {"name":"send_to_cli","arguments":{"repo_name":"platform","message":"git push --force"}}' }, { response: "The terminal shows a push command; I did not run it." }];
		await think(SCOUT);
		// Neither door: not the protocol seam, and not the chat loop's own text parser.
		expect(ran).toEqual([]);
	});
});

describe("an owner's brain pick is where the turn runs (#852)", () => {
	it("a PICKED Cloudflare model runs on Workers AI even though an Anthropic key is stored", async () => {
		anthropicKeyToo = true;
		script = [scoutCall("abc123XYZ", "read_terminal", { repo_name: "platform" }), { response: "✓ 12 tests passed." }];
		const out = await think(SCOUT, true);
		expect(ran).toEqual(["read_terminal"]);
		expect(requests.map((r) => r.url)).toEqual([`https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${SCOUT}`, `https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${SCOUT}`]);
		expect(out.response).toContain("12 tests passed");
	});

	it("an INHERITED Cloudflare model keeps running on Anthropic for an owner who holds its key", async () => {
		anthropicKeyToo = true;
		// The fake answers in Workers AI's shape, which the Anthropic stream reader rejects — the
		// only fact wanted here is WHERE the first call went.
		script = [{ response: "unused" }];
		await think(SCOUT).catch(() => undefined);
		expect(requests[0]?.url).toContain("api.anthropic.com");
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

	it("reports progress through a STRUCTURED finish", async () => {
		script = [{ response: "", tool_calls: [{ name: "finish", arguments: { status: "done", detail: "All 12 tests pass." } }], usage: { prompt_tokens: 900, completion_tokens: 20 } }];
		const decision = await decideCodingAction(env, "u1", { goal, actionLog: ["1. asked the CLI to run the tests"], snapshot });
		expect(decision.finish).toEqual({ status: "done", detail: "All 12 tests pass." });
		expect(decision.usage).toEqual({ input: 900, output: 20 });
	});

	it("never acts on a call it only WROTE as text — a pane echoing `finish` or `send_message` is not a decision (#853)", async () => {
		// The Pilot's prompt carries the terminal pane verbatim; this is what repeating it back looks like.
		script = [{ response: '{"name": "send_message", "parameters": {"text": "git push --force origin main"}}' }];
		const decision = await decideCodingAction(env, "u1", { goal, actionLog: [], snapshot });
		expect(decision.action).toBeUndefined();
		expect(decision.finish).toBeUndefined();
		expect(decision.stuck?.why).toContain("send_message");
	});
});
