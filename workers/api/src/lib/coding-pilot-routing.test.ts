import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { type CodingGoal, decideCodingAction } from "./coding-loop.js";
import { encryptKey } from "./crypto.js";
import { runUserWorkersAi } from "./user-ai.js";
import { runPilotInference } from "./pilot-routing.js";
import { pilotDecide, unwrapPilotDecide } from "./pilot-decide.js";

const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-5-5";
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const routine = "Inspect src/build.ts and report the cause of the failing test.";
const fallback = "Read the test failure and explain what needs fixing.";
const snapshot = { pane: "Ready for instructions.", runState: "idle" as const, ready: true, alive: true };
const ctx = { kind: "coding" as const, instanceId: "coder-1", traceId: "run-1" };

type Tool = { name: string; input: Record<string, unknown> };
type Answer = { tools?: Tool[]; text?: string; stop?: string; eof?: boolean } | { status: number; error: string } | Error;
type RequestBody = { model: string; max_tokens: number; messages: unknown[] };
type UsageRow = { model: unknown; input: unknown; output: unknown; read: unknown; write: unknown; trace: unknown; phase: unknown };
const send = (text = routine): Tool => ({ name: "send_message", input: { text } });

function completion(answer: Exclude<Answer, Error | { status: number; error: string }>): Response {
	const frames: Record<string, unknown>[] = [{ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } } }];
	const emit = (type: string, data: Record<string, unknown>) => frames.push({ type, ...data });
	const tools = answer.tools ?? [];
	tools.forEach((tool, index) => {
		emit("content_block_start", { index, content_block: { type: "tool_use", id: `tool-${index}`, name: tool.name, input: {} } });
		emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
		emit("content_block_stop", { index });
	});
	if (answer.text || !tools.length) {
		const index = tools.length;
		emit("content_block_start", { index, content_block: { type: "text", text: "" } });
		emit("content_block_delta", { index, delta: { type: "text_delta", text: answer.text ?? "No tool selected." } });
		emit("content_block_stop", { index });
	}
	emit("message_delta", { delta: { stop_reason: answer.stop ?? (tools.length ? "tool_use" : "end_turn") }, usage: { output_tokens: 10 } });
	if (!answer.eof) emit("message_stop", {});
	return new Response(new ReadableStream({ start(controller) {
		controller.enqueue(new TextEncoder().encode(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("")));
		controller.close();
	} }), { headers: { "Content-Type": "text/event-stream" } });
}

async function provider(answers: Answer[], opts: { afterUsage?: (calls: number) => void; pilotModel?: string; owned?: boolean; anthropic?: boolean; cloudflare?: boolean } = {}) {
	const encrypted = await encryptKey("sk-ant-pilot-fixture", KEK);
	const cf = opts.cloudflare ? await encryptKey(JSON.stringify({ accountId: "acct-fixture", token: "cf-fixture" }), KEK) : undefined;
	const usage: UsageRow[] = [];
	const env = {
		KEY_ENCRYPTION_KEY: KEK,
		DB: { prepare(sql: string) {
			let args: unknown[] = [];
			const statement = {
				bind(...bound: unknown[]) { args = bound; return statement; },
				async first() {
					if (sql.includes("SELECT config FROM agent_instances") && args[0] === "coder-1" && args[1] === "owner" && opts.owned !== false) return { config: JSON.stringify({ pilot: { model: opts.pilotModel ?? SONNET } }) };
					if (!sql.includes("SELECT key_ciphertext")) return null;
					const row = sql.includes("provider = 'cloudflare'") ? cf : args[1] === "anthropic" && opts.anthropic !== false ? encrypted : undefined;
					return row ? { key_ciphertext: row.ciphertext, dek_wrapped: row.dekWrapped, iv: row.iv } : null;
				},
				async all() { return { results: [] }; },
				async run() {
					if (sql.includes("INSERT INTO ai_usage")) {
						usage.push({ model: args[5], input: args[7], output: args[8], read: args[9], write: args[10], trace: args[12], phase: args[14] });
						opts.afterUsage?.(usage.length);
					}
					return { success: true, meta: { changes: 1 } };
				},
			};
			return statement;
		} },
	} as unknown as Env;
	const requests: RequestBody[] = [];
	const urls: string[] = [];
	vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
		urls.push(_url);
		requests.push(JSON.parse(init.body as string));
		const answer = answers.shift();
		if (!answer) throw new Error("Unexpected extra provider request");
		if (answer instanceof Error) throw answer;
		if ("status" in answer) return Response.json({ error: { message: answer.error } }, { status: answer.status });
		if (_url.includes("api.cloudflare.com")) return Response.json({ success: true, usage: { prompt_tokens: 100, completion_tokens: 10 }, result: { response: answer.text ?? "", tool_calls: (answer.tools ?? []).map((t) => ({ name: t.name, arguments: t.input })) } });
		return completion(answer);
	}));
	return { env, requests, usage, urls,
		decide: (patch: Partial<CodingGoal> = {}, atCap = false) => decideCodingAction(env, "owner", { goal: { repo: "owner/repo", objective: "Fix the build", clientType: "claude", ...patch }, actionLog: [], snapshot, atCap }, ctx),
	};
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Pilot model canary qualification through real provider requests (#1316)", () => {
	it("keeps an unconfigured Pilot on Sonnet and accepts a valid routine canary instruction without a second call", async () => {
		const p = await provider([{ tools: [send()] }, { tools: [send()] }]);
		Object.defineProperty(p.env, "AGENT", { get() { throw new Error("Pilot must not inspect the advisory Brain"); } });
		const ordinary = await p.decide();
		expect(ordinary.action).toMatchObject({ kind: "message", text: routine });
		expect(ordinary.pilotRouting).toMatchObject({ requestedModel: SONNET, model: SONNET });
		const canary = await p.decide({ pilotModel: HAIKU });
		expect(canary.action).toMatchObject({ kind: "message", text: routine });
		expect(canary.pilotRouting).toMatchObject({ requestedModel: HAIKU, model: HAIKU });
		expect(p.requests.map((r) => r.model)).toEqual([SONNET, HAIKU]);
		expect(p.usage.map((r) => r.model)).toEqual([SONNET, HAIKU]);
	});

	it.each([
		["owner choice", { tools: [{ name: "ask_owner", input: { question: "Which layout?", options: ["A", "B"] } }] }, {}],
		["completion", { tools: [{ name: "finish", input: { status: "done", detail: "Complete" } }] }, {}],
		["human takeover", { tools: [{ name: "request_human", input: { why: "Sign in" } }] }, {}],
		["usage-window wait", { tools: [{ name: "wait_for_reset", input: { why: "Limit reached" } }] }, {}],
		["unknown tool", { tools: [{ name: "invented_tool", input: {} }] }, {}],
		["multiple calls", { tools: [send(), send("Also inspect another file.")] }, {}],
		["missing instruction", { tools: [{ name: "send_message", input: {} }] }, {}],
		["wrong argument type", { tools: [{ name: "send_message", input: { text: 42 } }] }, {}],
		["blank instruction", { tools: [send("   ")] }, {}],
		["prose without a call", { text: "I think the work is done." }, {}],
		["wrong learned type", { tools: [{ name: "send_message", input: { text: routine, learned: 42 } }] }, {}],
		["oversized learned note", { tools: [{ name: "send_message", input: { text: routine, learned: "x".repeat(301) } }] }, {}],
		["output cap", { tools: [send()], stop: "max_tokens" }, {}],
		["merge authority refusal", { tools: [send("Run git push origin main now.")] }, { mergePolicy: "none" }],
		["scope refusal", { tools: [send("Edit src/build.ts to implement the fix.")] }, { scopeConstraints: [{ kind: "read_only", source: "owner directive" }] }],
	] as Array<[string, Answer, Partial<CodingGoal>]>)("gets one Sonnet decision for a canary %s", async (_name, answer, goal) => {
		const p = await provider([answer, { tools: [send(fallback)] }]);
		const result = await p.decide({ pilotModel: HAIKU, ...goal });
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU, SONNET]);
		expect(result.action).toMatchObject({ kind: "message", text: fallback });
		expect(p.usage).toHaveLength(2);
		expect(p.usage.map((r) => r.model)).toEqual([HAIKU, SONNET]);
		expect(p.usage.map((r) => [r.trace, r.phase])).toEqual([["run-1", "pilot_decide"], ["run-1", "pilot_decide_fallback"]]);
		expect(result.pilotRouting).toMatchObject({ requestedModel: HAIKU, model: SONNET, fallbackReason: expect.any(String) });
		expect(result.usage).toMatchObject({ input: 200, output: 20 });
	});

	it("uses Sonnet for cap reports even when routine decisions opted into Haiku", async () => {
		const p = await provider([{ tools: [{ name: "report_cap_status", input: { did: "Read the issue", blocker: "Test still failing", plan: "Fix it", steps: 2, reason: "One edit and one test" } }] }]);
		const result = await p.decide({ pilotModel: HAIKU }, true);
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
		expect(result.capSummary).toMatchObject({ blocker: "Test still failing", steps: 2 });
		expect(result.pilotRouting).toMatchObject({ requestedModel: HAIKU, model: SONNET, fallbackReason: expect.any(String) });
		expect(p.usage).toHaveLength(1);
	});

	it("records each fallback call once with its actual model and keeps both token totals", async () => {
		const p = await provider([{ tools: [{ name: "finish", input: { status: "done", detail: "Complete" } }] }, { tools: [send(fallback)] }]);
		const result = await p.decide({ pilotModel: HAIKU });
		expect(p.usage.map(({ model, input, output, read, write }) => ({ model, input, output, read, write }))).toEqual([
			{ model: HAIKU, input: 100, output: 10, read: 50, write: 20 },
			{ model: SONNET, input: 100, output: 10, read: 50, write: 20 },
		]);
		expect(result.usage).toMatchObject({ input: 200, output: 20, cacheRead: 100, cacheWrite: 40 });
	});

	it("falls back once when the canary model is unavailable, without inventing a paid call for the 404", async () => {
		const p = await provider([{ status: 404, error: "model not found" }, { tools: [send(fallback)] }]);
		expect((await p.decide({ pilotModel: HAIKU })).action).toMatchObject({ text: fallback });
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU, SONNET]);
		expect(p.usage.map((r) => r.model)).toEqual([SONNET]);
	});

	it.each([
		[401, "Invalid API key"], [403, "Forbidden"], [400, "Your credit balance is too low to access the Anthropic API."], [529, "Overloaded"],
	])("does not turn provider error %s into another model's bill", async (status, error) => {
		const p = await provider([{ status, error }]);
		await expect(p.decide({ pilotModel: HAIKU })).rejects.toThrow();
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU]);
		expect(p.usage).toHaveLength(0);
	});

	it("does not turn a dropped provider connection into a Sonnet fallback", async () => {
		const p = await provider([new Error("Network connection lost")]);
		await expect(p.decide({ pilotModel: HAIKU })).rejects.toThrow();
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU]);
	});

	it("preserves Cloudflare-only default routing and reports the model that actually answered", async () => {
		const p = await provider([{ tools: [send()] }], { anthropic: false, cloudflare: true });
		const result = await p.decide();
		expect(result.action).toMatchObject({ text: routine });
		expect(p.urls).toHaveLength(1);
		expect(decodeURIComponent(p.urls[0])).toContain("/ai/run/@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(p.usage.map((r) => r.model)).toEqual(["@cf/meta/llama-4-scout-17b-16e-instruct"]);
		expect(result.pilotRouting).toMatchObject({ requestedModel: SONNET, model: "@cf/meta/llama-4-scout-17b-16e-instruct" });
	});

	it("an explicit Haiku canary requires Anthropic instead of silently using stored Cloudflare credentials", async () => {
		const p = await provider([], { anthropic: false, cloudflare: true });
		await expect(p.decide({ pilotModel: HAIKU })).rejects.toThrow("Anthropic API key");
		expect(p.requests).toHaveLength(0);
		expect(p.usage).toHaveLength(0);
	});

	it("preserves the legacy Anthropic model unless the Pilot explicitly chooses another", async () => {
		const p = await provider([{ text: "Legacy answer" }, { text: "Pilot answer" }]);
		await runUserWorkersAi(p.env, "owner", "unconfigured-advisory-label", { messages: [{ role: "user", content: "Hi" }] });
		await runUserWorkersAi(p.env, "owner", HAIKU, { messages: [{ role: "user", content: "Hi" }] }, ctx, { anthropicModel: HAIKU });
		expect(p.requests.map((r) => r.model)).toEqual([SONNET, HAIKU]);
	});
});


describe("Pilot shared deadline and journalled model read (#1316)", () => {
	const body = { messages: [{ role: "user", content: "Choose the next instruction." }], tools: [], maxTokens: 128,
		streamDeadlines: { totalMs: 10_000, preContentMs: 6_000, silenceMs: 4_000, attempt: 1 } };

	it("gives fallback only the remaining total budget and clamps both phase timers", async () => {
		let clock = 0;
		let timerBoundary = 0;
		const p = await provider([{ text: "Needs qualification" }, { tools: [send()] }], { afterUsage: (calls) => { if (calls === 1) { clock = 8_000; timerBoundary = timers.mock.calls.length; } } });
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const timers = vi.spyOn(globalThis, "setTimeout");
		await runPilotInference(p.env, "owner", HAIKU, body, ctx, () => false);
		const fallbackDelays = timers.mock.calls.slice(timerBoundary).map((call) => Number(call[1]));
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU, SONNET]);
		expect(fallbackDelays.length).toBeGreaterThan(0);
		expect(fallbackDelays.every((delay) => delay > 0 && delay <= 2_000)).toBe(true);
	});

	it("does not start or ledger fallback after the shared budget expires", async () => {
		let clock = 0;
		const p = await provider([{ text: "Needs qualification" }], { afterUsage: () => { clock = 10_001; } });
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		await expect(runPilotInference(p.env, "owner", HAIKU, body, ctx, () => false)).rejects.toMatchObject({ status: 504 });
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU]);
		expect(p.usage.map((r) => r.model)).toEqual([HAIKU]);
	});

	it("skips a fresh canary/fallback pair on outer recovery attempts", async () => {
		const p = await provider([{ tools: [send()] }]);
		const accept = vi.fn(() => true);
		const result = await runPilotInference(p.env, "owner", HAIKU, { ...body, streamDeadlines: { ...body.streamDeadlines, attempt: 2 } }, ctx, accept);
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
		expect(accept).not.toHaveBeenCalled();
		expect(result.pilotRouting).toMatchObject({ requestedModel: HAIKU, model: SONNET, fallbackReason: "Recovery attempts use Sonnet." });
	});

	it("leaves an incomplete transport reply to outer recovery, which retries directly on Sonnet", async () => {
		const p = await provider([{ text: "A partial reply", eof: true }, { tools: [send()] }], { pilotModel: HAIKU });
		const sleep = vi.fn(async () => {});
		const outcome = await pilotDecide(p.env, { userId: "owner", instanceId: "coder-1", repoId: "repo-1", sessionId: "session-1", runStartedAt: Date.now(), params: { goal: { objective: "Fix the build", repo: "owner/repo", clientType: "claude" }, actionLog: [], snapshot } }, { sleep });
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(unwrapPilotDecide(outcome).action).toMatchObject({ text: routine });
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU, SONNET]);
		expect(p.usage.map((r) => r.model)).toEqual([SONNET]);
	});

	it("reads the owned instance's Pilot choice inside the real decision path", async () => {
		const p = await provider([{ tools: [send()] }], { pilotModel: HAIKU });
		const outcome = await pilotDecide(p.env, { userId: "owner", instanceId: "coder-1", repoId: "repo-1", sessionId: "session-1", runStartedAt: Date.now(), params: { goal: { objective: "Fix the build", repo: "owner/repo", clientType: "claude" }, actionLog: [], snapshot } });
		expect(unwrapPilotDecide(outcome).action).toMatchObject({ text: routine });
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU]);
	});

	it("refuses an unowned/missing instance before making any model request", async () => {
		const p = await provider([], { owned: false });
		await expect(pilotDecide(p.env, { userId: "owner", instanceId: "coder-1", repoId: "repo-1", sessionId: "session-1", runStartedAt: Date.now(), params: { goal: { objective: "Fix the build", repo: "owner/repo", clientType: "claude" }, actionLog: [], snapshot } })).rejects.toThrow("instance not found");
		expect(p.requests).toHaveLength(0);
	});
});
