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

describe("Haiku never drives coding, including obsolete selections (#1316)", () => {
	it.each([SONNET, HAIKU, "haiku", "claude-haiku-4-5", "invalid-model"])("routes an in-memory selection %s through the coding policy exactly once", async (pilotModel) => {
		const p = await provider([{ tools: [send()] }]);
		Object.defineProperty(p.env, "AGENT", { get() { throw new Error("Pilot must not inspect the advisory Brain"); } });
		// Simulate a goal journalled by an older worker, before Haiku was removed from the contract.
		const goal = JSON.parse(JSON.stringify({ pilotModel })) as Partial<CodingGoal>;
		const result = await p.decide(goal);
		expect(result.action).toMatchObject({ kind: "message", text: routine });
		expect(result.pilotRouting).toMatchObject({ requestedModel: SONNET, model: SONNET });
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
		expect(p.usage.map((r) => r.model)).toEqual([SONNET]);
		expect(p.usage.map((r) => r.phase)).toEqual(["pilot_decide"]);
	});

	it("uses one Sonnet request for owner decisions, without a canary or fallback bill", async () => {
		const p = await provider([{ tools: [{ name: "ask_owner", input: { question: "Choose the layout?", options: ["A", "B"] } }] }]);
		await p.decide();
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
		expect(p.usage).toHaveLength(1);
	});

	it("uses Sonnet for cap reports even with an obsolete journalled Haiku selection", async () => {
		const p = await provider([{ tools: [{ name: "report_cap_status", input: { did: "Read the issue", blocker: "Test still failing", plan: "Fix it", steps: 2, reason: "One edit and one test" } }] }]);
		const result = await p.decide(JSON.parse(JSON.stringify({ pilotModel: HAIKU })), true);
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
		expect(result.capSummary).toMatchObject({ blocker: "Test still failing", steps: 2 });
		expect(result.pilotRouting).toMatchObject({ requestedModel: SONNET, model: SONNET });
		expect(p.usage).toHaveLength(1);
	});

	it.each([[401, "Invalid API key"], [403, "Forbidden"], [404, "model unavailable"], [400, "Your credit balance is too low"], [529, "Overloaded"]])("does not multiply provider error %s into another paid model call", async (status, error) => {
		const p = await provider([{ status: Number(status), error: String(error) }]);
		await expect(p.decide()).rejects.toThrow();
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
		expect(p.usage).toHaveLength(0);
	});

	it("leaves transport recovery to the existing outer policy", async () => {
		const p = await provider([new Error("Network connection lost")]);
		await expect(p.decide()).rejects.toThrow();
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
	});

	it.each([undefined, HAIKU])("preserves Cloudflare-only routing for legacy selection %s without using Haiku", async (pilotModel) => {
		const p = await provider([{ tools: [send()] }], { anthropic: false, cloudflare: true });
		const result = await p.decide(JSON.parse(JSON.stringify({ pilotModel })));
		expect(result.action).toMatchObject({ text: routine });
		expect(p.urls).toHaveLength(1);
		expect(decodeURIComponent(p.urls[0])).toContain("/ai/run/@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(p.usage.map((r) => r.model)).toEqual(["@cf/meta/llama-4-scout-17b-16e-instruct"]);
		expect(result.pilotRouting).toMatchObject({ requestedModel: SONNET, model: "@cf/meta/llama-4-scout-17b-16e-instruct" });
	});

	it("refuses explicit Haiku in coding transport before provider or ledger writes", async () => {
		const p = await provider([]);
		await expect(runUserWorkersAi(p.env, "owner", HAIKU, { messages: [] }, ctx, { anthropicModel: HAIKU })).rejects.toThrow("Haiku is not permitted for coding");
		expect(p.requests).toHaveLength(0);
		expect(p.usage).toHaveLength(0);
	});

	it("leaves explicit Haiku transport available for non-coding ticket work", async () => {
		const p = await provider([{ text: "Ticket summary" }]);
		await runUserWorkersAi(p.env, "owner", HAIKU, { messages: [{ role: "user", content: "Summarize this ticket." }] }, undefined, { anthropicModel: HAIKU });
		expect(p.requests.map((r) => r.model)).toEqual([HAIKU]);
	});
});

describe("Coding deadline and journalled policy read (#1316)", () => {
	const body = { messages: [{ role: "user", content: "Choose the next instruction." }], tools: [], maxTokens: 128,
		streamDeadlines: { totalMs: 1000, preContentMs: 900, silenceMs: 800 } };

	it("refuses an expired decision before sending any provider request", async () => {
		const p = await provider([]);
		await expect(runPilotInference(p.env, "owner", HAIKU, { ...body, streamDeadlines: { ...body.streamDeadlines, totalMs: 0 } }, ctx)).rejects.toMatchObject({ status: 504 });
		expect(p.requests).toHaveLength(0);
	});

	it("uses one Sonnet request on outer recovery attempts", async () => {
		const p = await provider([{ tools: [send()] }]);
		await runPilotInference(p.env, "owner", HAIKU, { ...body, streamDeadlines: { ...body.streamDeadlines, attempt: 2 } }, ctx);
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
	});

	it("retries an incomplete transport reply on Sonnet even when the stored selection is Haiku", async () => {
		const p = await provider([{ text: "A partial reply", eof: true }, { tools: [send()] }], { pilotModel: HAIKU });
		const sleep = vi.fn(async () => {});
		const outcome = await pilotDecide(p.env, { userId: "owner", instanceId: "coder-1", repoId: "repo-1", sessionId: "session-1", runStartedAt: Date.now(), params: { goal: { objective: "Fix the build", repo: "owner/repo", clientType: "claude" }, actionLog: [], snapshot } }, { sleep });
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(unwrapPilotDecide(outcome).action).toMatchObject({ text: routine });
		expect(p.requests.map((r) => r.model)).toEqual([SONNET, SONNET]);
		expect(p.usage.map((r) => r.model)).toEqual([SONNET]);
	});

	it("normalizes the owned instance's saved Haiku selection before a real decision", async () => {
		const p = await provider([{ tools: [send()] }], { pilotModel: HAIKU });
		const outcome = await pilotDecide(p.env, { userId: "owner", instanceId: "coder-1", repoId: "repo-1", sessionId: "session-1", runStartedAt: Date.now(), params: { goal: { objective: "Fix the build", repo: "owner/repo", clientType: "claude" }, actionLog: [], snapshot } });
		expect(unwrapPilotDecide(outcome).action).toMatchObject({ text: routine });
		expect(p.requests.map((r) => r.model)).toEqual([SONNET]);
	});

	it("refuses an unowned instance before making any model request", async () => {
		const p = await provider([], { owned: false });
		await expect(pilotDecide(p.env, { userId: "owner", instanceId: "coder-1", repoId: "repo-1", sessionId: "session-1", runStartedAt: Date.now(), params: { goal: { objective: "Fix the build", repo: "owner/repo", clientType: "claude" }, actionLog: [], snapshot } })).rejects.toThrow("instance not found");
		expect(p.requests).toHaveLength(0);
	});
});
