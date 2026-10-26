/**
 * #1244 — the MCP agent eval harness. Deterministic: a scripted driver replays the careful call and each recorded mistake through the
 * real server over a real client, with the platform API stubbed per task. What this pins is the harness (scoring, drivers, task
 * integrity) and what the SERVER does with each of the audit's offender shapes today. How often a MODEL makes a mistake is the live run
 * (`node scripts/mcp-agent-eval.mjs --driver live`, on demand — docs/mcp-tool-audit.md §9).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));

const { PagsMcp } = await import("../index.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
import { anthropicDriver, EVAL_SYSTEM_PROMPT, ScriptedDriver } from "./driver.js";
import { type CorpusReport, openSession, runCorpus, runLive } from "./harness.js";
import { classify, effectHappened, emptyTotals, rate, scoreCall, summarize } from "./scorer.js";
import { TASKS } from "./tasks.js";

const host = { PagsMcp, Client, InMemoryTransport };

describe("scorer (pure)", () => {
	const exp = { tool: "coding_loop_stop", effect: { method: "POST", path: /\/cancel$/ } };
	const call = { name: "coding_loop_stop", args: {} };
	const ok = { isError: false, texts: ['{"success":true}'], requests: [{ method: "POST", path: "/v1/instances/i/loop/r/cancel", body: null }] };

	it("a right tool, no error, no note, the request made → first-call success", () => {
		const s = scoreCall(exp, call, ok);
		expect(s).toMatchObject({ toolMatches: true, effective: true, firstCallSuccess: true, notes: 0, deprecated: false });
		expect(classify(s)).toBe("clean");
	});

	it("any #1241 note means the caller was misled: effective, but NOT a first-call success", () => {
		const s = scoreCall(exp, call, { ...ok, texts: ['{"success":true}', "Note:\n- `instanceId` was read as `instance_id` — argument names are snake_case.\n- `runId` was read as `run_id` — argument names are snake_case."] });
		expect(s).toMatchObject({ effective: true, firstCallSuccess: false, notes: 2 });
		expect(s.noteText[0]).toMatch(/instanceId/);
		expect(classify(s)).toBe("recovered");
	});

	it("a deprecated-alias reply is flagged and is not a success even though it worked", () => {
		const s = scoreCall(exp, { name: "stop_instance_loop", args: {} }, { ...ok, texts: ['{"success":true}', "⚠️ This tool name is deprecated — use `coding_loop_stop` instead."] });
		expect(s).toMatchObject({ deprecated: true, toolMatches: false, effective: true, firstCallSuccess: false });
		expect(classify(s)).toBe("deprecated");
	});

	it("invalid_input and unknown-tool replies are counted, in the newer and the older framing", () => {
		const bad = (text: string) => scoreCall(exp, call, { isError: true, texts: [text], requests: [] });
		expect(bad("Input validation error: Invalid arguments for tool x.\n\nWhat is wrong:").invalidInput).toBe(true);
		expect(bad("MCP error -32602: Input validation error: Invalid arguments for tool x: [...]").invalidInput).toBe(true);
		expect(bad("Tool renameInstance not found. Did you mean `rename_instance`?").unknownTool).toBe(true);
		expect(classify(bad("Tool nope not found."))).toBe("unknown_tool");
		expect(classify(bad("Input validation error"))).toBe("invalid_input");
	});

	it("the right tool refused by the API is 'refused', and a wrong tool is 'wrong_tool', whatever else happened", () => {
		expect(classify(scoreCall(exp, call, { isError: false, texts: ['{"error":"busy"}'], requests: [] }))).toBe("refused");
		expect(classify(scoreCall(exp, { name: "other", args: {} }, ok))).toBe("wrong_tool");
		expect(scoreCall(exp, null, null)).toMatchObject({ tool: "(no call)", firstCallSuccess: false, isError: true });
	});

	it("an effect needs the method, the path and every named body key to match; null means no API call is required", () => {
		const reqs = [{ method: "POST", path: "/v1/x", body: '{"a":1,"b":{"c":2}}' }];
		expect(effectHappened({ method: "POST", path: /\/x$/, body: { a: 1, b: { c: 2 } } }, reqs)).toBe(true);
		expect(effectHappened({ method: "POST", path: /\/x$/, body: { a: 2 } }, reqs)).toBe(false);
		expect(effectHappened({ method: "GET", path: /\/x$/ }, reqs)).toBe(false);
		expect(effectHappened({ method: "POST", path: /\/y$/ }, reqs)).toBe(false);
		expect(effectHappened({ method: "POST", path: /\/x$/, body: { a: 1 } }, [{ method: "POST", path: "/v1/x", body: "not json" }])).toBe(false);
		expect(effectHappened(null, [])).toBe(true);
	});

	it("summarize counts each measure, and rate is a rounded fraction", () => {
		const s = [scoreCall(exp, call, ok), scoreCall(exp, { name: "other", args: {} }, ok), scoreCall(exp, call, { isError: true, texts: ["Input validation error"], requests: [] })];
		expect(summarize(s)).toEqual({ ...emptyTotals(), calls: 3, firstCallSuccess: 1, effective: 2, invalidInput: 1, wrongTool: 1 });
		expect(rate(1, 3)).toBe(0.333);
		expect(rate(0, 0)).toBe(0);
	});
});

describe("drivers", () => {
	it("a scripted driver replays its calls in order and refuses to run past the end", async () => {
		const d = new ScriptedDriver([{ name: "a", args: {} }, { name: "b", args: { x: 1 } }]);
		expect(await d.chooseToolCall("p", [])).toEqual({ name: "a", args: {} });
		expect(await d.chooseToolCall("p", [])).toEqual({ name: "b", args: { x: 1 } });
		await expect(d.chooseToolCall("p", [])).rejects.toThrow(/no more calls/);
	});

	it("the model driver asks for one forced tool call at temperature 0 with the server's own tool list, and reads the call back", async () => {
		const sent: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
			return Response.json({ content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "my_instances", input: {} }] });
		}) as unknown as typeof fetch;
		const d = anthropicDriver({ apiKey: "k", model: "m-1", fetchImpl });
		expect(d.label).toBe("anthropic:m-1");
		const call = await d.chooseToolCall("show my instances", [{ name: "my_instances", description: "List mine.", inputSchema: { type: "object" } }]);
		expect(call).toEqual({ name: "my_instances", args: {} });
		expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages");
		expect(sent[0].headers.get("x-api-key")).toBe("k");
		expect(sent[0].body).toMatchObject({ model: "m-1", temperature: 0, tool_choice: { type: "any" }, system: EVAL_SYSTEM_PROMPT, messages: [{ role: "user", content: "show my instances" }], tools: [{ name: "my_instances", description: "List mine.", input_schema: { type: "object" } }] });
	});

	it("no tool call from the model is a null call (scored as a miss), and an API failure is loud", async () => {
		const none = anthropicDriver({ apiKey: "k", model: "m", fetchImpl: (async () => Response.json({ content: [{ type: "text", text: "I can't" }] })) as unknown as typeof fetch });
		expect(await none.chooseToolCall("p", [])).toBeNull();
		const down = anthropicDriver({ apiKey: "k", model: "m", fetchImpl: (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch });
		await expect(down.chooseToolCall("p", [])).rejects.toThrow(/529/);
	});
});

describe("the task set", () => {
	it("covers every one of the audit's top-20 offender rows, and the issue's required tasks", () => {
		const covered = new Set(TASKS.flatMap((t) => t.offenders));
		for (let n = 1; n <= 20; n++) expect(covered.has(n), `offender #${n}`).toBe(true);
		const ids = TASKS.map((t) => t.id);
		for (const required of ["queue-on-busy-instance", "github-connector-tool", "remove-repo", "stop-run", "check-run", "read-diagnostics", "add-instance-knowledge", "query-instance-records"]) expect(ids).toContain(required);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("is owner-shaped: no prompt names the tool it expects", () => {
		for (const t of TASKS) expect(t.prompt.includes(t.expectedTool), t.id).toBe(false);
	});

	it("each task's careful call is for its expected tool, and each mistake has a unique label and a stated expectation", () => {
		for (const t of TASKS) {
			expect(t.clean.name, t.id).toBe(t.expectedTool);
			expect(t.sloppy.length, t.id).toBeGreaterThan(0);
			expect(new Set(t.sloppy.map((v) => v.label)).size, t.id).toBe(t.sloppy.length);
			expect(t.notes.length, t.id).toBeGreaterThan(20);
		}
	});
});

describe("against the real server, over a real client", () => {
	let report: CorpusReport;
	let tools: Set<string>;
	const realFetch = globalThis.fetch;
	beforeAll(async () => {
		report = await runCorpus(host, TASKS, (calls) => new ScriptedDriver(calls));
		const s = await openSession(host);
		tools = new Set(s.tools.map((t) => t.name));
		s.close();
	});
	afterAll(() => {
		globalThis.fetch = realFetch;
	});

	it("every task's expected tool, and every mistake that is not meant to be unknown, is registered on the current surface", () => {
		for (const t of TASKS) {
			expect(tools.has(t.expectedTool), `${t.id}: ${t.expectedTool}`).toBe(true);
			for (const v of t.sloppy) if (v.expect !== "unknown_tool") expect(tools.has(v.call.name), `${t.id}/${v.label}: ${v.call.name}`).toBe(true);
			for (const v of t.sloppy) if (v.expect === "unknown_tool") expect(tools.has(v.call.name), `${t.id}/${v.label} must stay unknown`).toBe(false);
		}
	});

	it("the careful call for every task is a first-call success: right tool, no note, the API request made", () => {
		const bad = report.results.filter((r) => r.variant === "clean" && !r.score.firstCallSuccess).map((r) => `${r.taskId}: ${r.texts[0]?.slice(0, 80)}`);
		expect(bad).toEqual([]);
		expect(report.clean).toMatchObject({ calls: TASKS.length, firstCallSuccess: TASKS.length, effective: TASKS.length, noted: 0 });
	});

	it("every recorded mistake comes to what it is expected to come to today", () => {
		for (const t of TASKS) {
			for (const v of t.sloppy) {
				const r = report.results.find((x) => x.taskId === t.id && x.variant === v.label);
				expect(r && classify(r.score), `${t.id}/${v.label}`).toBe(v.expect);
			}
		}
	});

	it("an alias, a camelCase key, a stringified boolean or number and a dropped argument are named in the reply — not silent", () => {
		const note = (task: string, variant: string) => report.results.find((r) => r.taskId === task && r.variant === variant)?.score.noteText.join(" ") ?? "";
		expect(note("queue-on-busy-instance", "camelcase-key")).toMatch(/`instanceId` was read as `instance_id`.*`queueIfBusy` was read as `queue_if_busy`/);
		expect(note("queue-on-busy-instance", "boolean-as-string")).toMatch(/takes a boolean; "true" was read as true/);
		expect(note("query-instance-records", "number-as-string")).toMatch(/takes a number|was read as/);
		expect(report.results.filter((r) => r.score.deprecated).map((r) => r.taskId).sort()).toEqual(["check-run", "read-diagnostics", "start-run", "stop-run"]);
	});

	it("a refused call and a bad call tell the caller what to do next", () => {
		const text = (task: string, variant: string) => report.results.find((r) => r.taskId === task && r.variant === variant)?.texts.join("\n") ?? "";
		expect(text("invalid-input-message", "wrong-type-id")).toMatch(/Corrected example: \{"instance_id":"<instance_id>","name":"Alpha"\}/);
		// `list_disabled_instances` (#1383) shares both words of the invented name and so ranks first; the right tool must still be offered.
		expect(text("unknown-tool-name", "invented-name")).toMatch(/Did you mean[^?]*`my_instances`/);
		expect(text("insert-instance-record", "object-for-json-string")).toMatch(/`data` expected string, received object/);
	});

	it("the corpus totals are pinned, so a surface change that moves them is a decision", () => {
		expect(report.sloppy).toEqual({ calls: 24, firstCallSuccess: 0, effective: 11, noted: 5, deprecated: 4, invalidInput: 2, unknownTool: 2, wrongTool: 16 });
	});

	it("restores the real fetch when a session closes", async () => {
		const before = globalThis.fetch;
		const s = await openSession(host);
		expect(globalThis.fetch).not.toBe(before);
		s.close();
		expect(globalThis.fetch).toBe(before);
	});

	it("a live run asks the driver once per task and reports under variant 'live'", async () => {
		const seen: string[] = [];
		const driver = { label: "fake-model", chooseToolCall: async (prompt: string) => {
				seen.push(prompt);
				return TASKS.find((t) => t.prompt === prompt)?.clean ?? null;
			},
		};
		const live = await runLive(host, TASKS, driver);
		expect(seen).toHaveLength(TASKS.length);
		expect(live.all.calls).toBe(TASKS.length);
		expect(live.all.firstCallSuccess).toBe(TASKS.length);
		expect(live.sloppy.calls).toBe(0);
		expect(live.results[0]).toMatchObject({ variant: "live", driver: "fake-model" });
	});
});

describe("the stored baselines (docs/mcp-eval)", () => {
	const load = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../docs/mcp-eval", name), "utf8")) as { meta: { revision: string; sha: string; driver: string }; clean: { calls: number; firstCallSuccess: number }; sloppy: Record<string, number>; results: Array<{ taskId: string; variant: string }> };

	it("the pre-eb57ef71 baseline is the parent revision, the same tasks and variants as now, and a scripted run", () => {
		const before = load("baseline-pre-eb57ef71.json");
		const now = load("baseline-current.json");
		expect(before.meta).toMatchObject({ revision: "bc9541f6", driver: "scripted" });
		expect(now.meta.driver).toBe("scripted");
		expect(before.results.map((r) => `${r.taskId}/${r.variant}`)).toEqual(now.results.map((r) => `${r.taskId}/${r.variant}`));
		expect(now.results.length).toBe(TASKS.reduce((n, t) => n + 1 + t.sloppy.length, 0));
	});

	it("the numbers in docs/mcp-tool-audit.md section 9.4 are the stored ones", () => {
		const before = load("baseline-pre-eb57ef71.json");
		const now = load("baseline-current.json");
		expect([before.clean.firstCallSuccess, now.clean.firstCallSuccess]).toEqual([19, 19]);
		expect([before.sloppy.effective, now.sloppy.effective]).toEqual([7, 11]);
		expect([before.sloppy.noted, now.sloppy.noted]).toEqual([0, 5]);
		expect([before.sloppy.deprecated, now.sloppy.deprecated]).toEqual([0, 4]);
		expect([before.sloppy.invalidInput, now.sloppy.invalidInput]).toEqual([5, 2]);
		expect([before.sloppy.unknownTool, now.sloppy.unknownTool]).toEqual([2, 2]);
		expect([before.sloppy.wrongTool, now.sloppy.wrongTool]).toEqual([16, 16]);
	});
});
