/**
 * A failed tool call is expressible in the trace — proved against the real `runAgentThink` (#564).
 *
 * ── What was broken
 *
 * A turn's tool activity reached `agent_events` as ONE row, written by `routes/instances-chat.ts`
 * from the DO's already-flattened `toolMessage.content` and defaulted to `info` by `logEvent`. The
 * per-tool `success` boolean is gone by then — it is a `✅`/`❌` inside a joined string — so a round
 * that ran one succeeding and one failing tool produced a single `info` row that no level could
 * describe honestly. On instance bd43f4de-… `agent_trace(level:"error")` therefore returned four
 * rows all three days older than the failures that actually broke the session.
 *
 * ── Why this drives the real thinker
 *
 * The fix is one `if` at the one place `success` still exists as a boolean. A unit test of
 * `logToolFailure` proves the ROW is shaped right and proves nothing about whether anything calls
 * it — which is the half that was missing for three days. So the provider and the tool executor are
 * faked and everything between them is real, including the round loop, the allow-list, the dedup
 * and `logEvent`'s own SQL.
 *
 * ── ADR 0002 (a guard states the size of what it measured)
 *
 * Every case asserts how many tools it actually ran before asserting what was written (G1): the
 * write-count case in particular passes vacuously against a fixture whose model never called a
 * tool, which is the easiest way for this exact test to rot. Counts are printed (G2).
 *
 * G4, run 2026-08-15, in BOTH directions. Deleting the `if (!toolResult.success) await
 * logToolFailure(…)` line in `agent-think.ts` turns two of these red — the mixed round fails
 * `expected [] to have a length of 1 but got +0` and the 600-character case fails `expected
 * undefined to be defined`. Dropping the `if` instead, so every tool writes a row, turns the OTHER
 * two red — the mixed round fails `to have a length of 1 but got 2` and the all-success turn fails
 * `to have a length of +0 but got 3`. The three cases are pinned from both sides: the failure must
 * be written, and the success must not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentState } from "./agent-types.js";
import { TOOL_LOG_FAILURE_MAX_CHARS, TOOL_LOG_MAX_CHARS } from "./lib/tool-result-cap.js";

/** Scripted provider replies, shifted one per completion. */
let script: unknown[] = [];

vi.mock("./lib/user-ai.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/user-ai.js")>()),
	runUserWorkersAi: async () => {
		const next = script.shift();
		if (next === undefined) throw new Error("the fake provider ran out of scripted replies");
		return next;
	},
}));

/** Every tool the loop actually executed — the denominator each case asserts before anything else. */
const executed: Array<{ name: string; success: boolean }> = [];
/** What a failing tool returns. Long on purpose: the trace must keep 600 of it, not 200. */
const FAILURE_TEXT = `That repository is already being worked on by another session. ${"x".repeat(2000)} Run \`pags up\` on the machine that owns it, or end the other session first.`;

vi.mock("./lib/tools.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/tools.js")>()),
	executeTool: async (call: { name: string }) => {
		// One tool always fails, one always succeeds — so a "mixed round" is a property of the
		// script, not of a counter that could drift.
		const success = call.name !== "create_task";
		executed.push({ name: call.name, success });
		return { name: call.name, content: success ? "Saved. Keys now: deploy_target" : FAILURE_TEXT, success };
	},
}));

const { runAgentThink } = await import("./agent-think.js");

/** Every bound statement the turn issued, so trace writes can be counted rather than argued about. */
let statements: Array<{ sql: string; binds: unknown[] }> = [];

const emptyResult = {
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
const env = {
	DB: {
		prepare(sql: string) {
			return {
				bind: (...binds: unknown[]) => {
					statements.push({ sql, binds });
					return emptyResult;
				},
				...emptyResult,
			};
		},
	},
} as never;

const engine = {
	buildRAGContext: async () => "",
	getUserContext: async () => ({ preferences: {}, interactionCount: 0 }),
	touchUserContext: async () => undefined,
	logEvent: async () => undefined,
} as never;

const doStorage = {
	async get() {
		return undefined;
	},
	async list() {
		return new Map();
	},
	async put() {
		return undefined;
	},
	async delete() {
		return false;
	},
} as never;

const state: AgentState = {
	agentId: "inst-564",
	name: "Repo Coder",
	personality: "direct",
	goal: "help with the repo",
	model: "claude-sonnet-4-6",
	status: "idle",
	systemPrompt: "",
	guardrails: { topicRestrictions: "", blockedTerms: [], responseStyle: "", maxResponseLength: 0, requireCitations: false },
	welcomeMessage: "",
	isPublished: true,
};

const messages: AgentMessage[] = [
	{ id: "m1", role: "user", content: "Start work on the chess repo.", channel: "chat", createdAt: new Date().toISOString() },
];

/** One structured tool round. Distinct `input` per call so the cross-round dedup never swallows one. */
const call = (id: string, name: string, input: Record<string, unknown>) => ({
	contentBlocks: [{ type: "tool_use", id, name, input }],
	tool_calls: [{ id, name, arguments: input }],
});
const round = (...calls: ReturnType<typeof call>[]) => ({
	contentBlocks: calls.flatMap((c) => c.contentBlocks),
	tool_calls: calls.flatMap((c) => c.tool_calls),
});

const think = () =>
	runAgentThink({ state, engine, messages, memory: [], tasks: [], userId: "u1", env, doStorage, broadcast: () => undefined, delegation: { budgetId: null, onBehalfOf: null, traceId: "turn-1" } });

/** Trace rows this turn wrote, decoded from `logEvent`'s positional binds. */
function traceRows(): Array<{ level: string; event: string; message: string; context: Record<string, unknown>; traceId: unknown }> {
	return statements
		.filter((s) => s.sql.startsWith("INSERT INTO agent_events"))
		.map((s) => ({
			traceId: s.binds[4],
			level: String(s.binds[6]),
			event: String(s.binds[7]),
			message: String(s.binds[8] ?? ""),
			context: JSON.parse(String(s.binds[9] ?? "{}")) as Record<string, unknown>,
		}));
}

beforeEach(() => {
	executed.length = 0;
	statements = [];
	script = [];
});

describe("a failed tool call in the unified trace (#564)", () => {
	it("a mixed round writes one warn row for the failure and nothing for the success", async () => {
		script = [
			round(
				call("t1", "write_memory", { key: "deploy_target", type: "knowledge", content: "main" }),
				call("t2", "create_task", { title: "work the chess repo" }),
			),
			{ response: "Done what I could." },
		];
		await think();

		// G1 — the fixture really is mixed. Without this the assertions below pass on a turn that
		// ran nothing, which is exactly how a driven-loop test rots.
		expect(executed).toHaveLength(2);
		expect(executed.filter((e) => e.success)).toHaveLength(1);
		expect(executed.filter((e) => !e.success)).toHaveLength(1);

		const rows = traceRows().filter((r) => r.event === "tool.call");
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("warn");
		expect(rows[0].context).toMatchObject({ tool: "create_task", success: false, round: 0 });
		// Joined to the rest of the turn, so the warn row sits beside its `chat.in`/`chat.out`.
		expect(rows[0].traceId).toBe("turn-1");
		expect(rows[0].message).toContain("❌ **create_task**");
		// The successful tool is carried by the route's single `info` summary row, as before — it
		// must not get one of these.
		expect(rows.some((r) => r.message.includes("write_memory"))).toBe(false);
		console.log(`✓ mixed round: 2 tools executed (1 ok, 1 failed) → ${rows.length} tool.call trace row(s), level ${rows[0].level}`);
	});

	it("an all-success turn over three rounds writes no trace rows at all", async () => {
		// The regression this bounds. `agent_events` has no retention cron — only an opportunistic
		// 1%-of-writes 14-day prune — so a row per TOOL would multiply inserts by the tool-call rate
		// on precisely the agents that call the most tools. A row per FAILURE bounds it by the
		// failure rate, and this asserts the all-success cost is unchanged: zero.
		script = [
			round(call("t1", "write_memory", { key: "a", type: "knowledge", content: "1" })),
			round(call("t2", "write_memory", { key: "b", type: "knowledge", content: "2" })),
			round(call("t3", "write_memory", { key: "c", type: "knowledge", content: "3" })),
			{ response: "All stored." },
		];
		await think();

		// G1 — three rounds, three executions, none of them failed. A fixture that ran 0 tools would
		// satisfy "wrote 0 rows" while measuring nothing.
		expect(executed).toHaveLength(3);
		expect(executed.every((e) => e.success)).toBe(true);

		const rows = traceRows();
		expect(rows.filter((r) => r.event === "tool.call")).toHaveLength(0);
		expect(rows).toHaveLength(0);
		console.log(`✓ all-success turn: 3 rounds, ${executed.length} tools executed, ${rows.length} agent_events writes`);
	});

	it("keeps the 600 characters #517 preserved, not the 200 the summary row cuts to", async () => {
		script = [round(call("t1", "create_task", { title: "work the chess repo" })), { response: "Could not." }];
		await think();

		expect(executed).toHaveLength(1);
		expect(executed[0].success).toBe(false);
		const row = traceRows().find((r) => r.event === "tool.call");
		expect(row).toBeDefined();
		// The route's summary cuts at 200; a failure's remedy is its LAST clause, so the trace row
		// gets the failure budget instead. Bounded above too — this is a log line, not the payload.
		expect(row?.message.length).toBeGreaterThan(TOOL_LOG_FAILURE_MAX_CHARS);
		expect(row?.message.length).toBeLessThan(TOOL_LOG_FAILURE_MAX_CHARS + 200);
		expect(TOOL_LOG_FAILURE_MAX_CHARS).toBeGreaterThan(TOOL_LOG_MAX_CHARS);
		expect(FAILURE_TEXT.length).toBeGreaterThan(TOOL_LOG_FAILURE_MAX_CHARS); // G1: the input can overflow
		console.log(`✓ failure message: ${row?.message.length} chars kept of ${FAILURE_TEXT.length} (budget ${TOOL_LOG_FAILURE_MAX_CHARS})`);
	});
});
