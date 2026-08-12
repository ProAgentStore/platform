/**
 * The stored round is CONSUMED — proved against the real `runAgentThink` (#518, criterion 6).
 *
 * #442's own tests all prove a round is BUILT correctly: the right fields, the right shape, the
 * right refusals. Not one of them proves anything ever reads one back. That gap is the whole of
 * #518: the storage half worked in production and the retrieval half sat behind byte equality with
 * a re-spoken sentence, so the mechanism was correct, live, and unreachable — and no test noticed,
 * because "construction" and "consumption" look identical from the outside until a user needs the
 * second one.
 *
 * So this drives the real thinker twice, through the real dedup, with only the provider and the
 * tool executor faked:
 *
 *   attempt 1  round 0 runs a WRITE, round 1's completion fails → the error carries the round
 *   attempt 2  resumes from it, the model re-issues the identical write → it does NOT run again
 *
 * The second assertion is the one that matters. `executeStorageTool` is a spy with a call count, so
 * "not re-run and not re-billed" is a number rather than an argument.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentState } from "./agent-types.js";
import { stripCommentsAndLiterals } from "./lib/source-guard.js";
import { autoResumableRoundOf, type ResumableRound, resumableRoundOf, thinkWithAutoResume } from "./lib/resumable-round.js";

/** Every completion the fake provider was asked for, so the replayed round can be inspected. */
const sent: Array<{ messages: { role: string; content: unknown }[] }> = [];
/** Scripted replies/throws, shifted one per completion. */
let script: Array<unknown | (() => never)> = [];

vi.mock("./lib/user-ai.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/user-ai.js")>()),
	runUserWorkersAi: async (_env: unknown, _userId: unknown, _model: string, body: unknown) => {
		sent.push(body as { messages: { role: string; content: unknown }[] });
		const next = script.shift();
		if (typeof next === "function") (next as () => never)();
		if (next === undefined) throw new Error("the fake provider ran out of scripted replies");
		return next;
	},
}));

/** Executions of the tool — the thing that must happen exactly once across both attempts. */
const executed: Array<{ name: string; input: unknown }> = [];

vi.mock("./lib/tools.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/tools.js")>()),
	executeTool: async (call: { name: string; input: unknown }) => {
		executed.push({ name: call.name, input: call.input });
		return { name: call.name, content: "Saved. Keys now: deploy_target", success: true };
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
const env = {
	DB: {
		prepare() {
			return { bind: () => emptyRow, ...emptyRow };
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
	agentId: "inst-518",
	name: "Repo Coder",
	personality: "direct",
	goal: "help with the repo",
	// Tool-capable, and the model almost every chat actually runs on.
	model: "claude-sonnet-4-6",
	status: "idle",
	systemPrompt: "",
	guardrails: { topicRestrictions: "", blockedTerms: [], responseStyle: "", maxResponseLength: 0, requireCitations: false },
	welcomeMessage: "",
	isPublished: true,
};

const messages: AgentMessage[] = [
	{
		id: "m1",
		role: "user",
		content: "Remember that we deploy from main, then tell me what you stored.",
		channel: "chat",
		createdAt: new Date().toISOString(),
	},
];

/** One `write_memory` call, in the structured protocol — the shape that makes a round resumable. */
const WRITE_CALL = { key: "deploy_target", type: "knowledge", content: "deploys from main" };
const writeRound = () => ({
	contentBlocks: [{ type: "tool_use", id: "toolu_1", name: "write_memory", input: WRITE_CALL }],
	tool_calls: [{ id: "toolu_1", name: "write_memory", arguments: WRITE_CALL }],
});

const think = (resume?: ResumableRound) =>
	runAgentThink({ state, engine, messages, memory: [], tasks: [], userId: "u1", env, doStorage, broadcast: () => undefined, resume });

beforeEach(() => {
	sent.length = 0;
	executed.length = 0;
	script = [];
});

describe("a failed turn's round, then the retry that continues from it (#518)", () => {
	it("stores what ran, then RESUMES it — the write executes once across both attempts", async () => {
		// ── Attempt 1: the write lands, the next completion dies mid-stream.
		script = [
			writeRound(),
			() => {
				throw Object.assign(new Error("The AI provider stopped sending mid-reply"), { status: 504, retryable: true });
			},
		];
		const failure = await think().then(
			() => null,
			(e) => e,
		);
		expect(executed).toHaveLength(1);
		const round = resumableRoundOf(failure);
		expect(round?.executedTools).toEqual(["write_memory"]);
		expect(round?.prompt).toBe(messages[0].content);
		// The provider's verdict rides on the same error, which is what lets the DO retry without
		// re-deciding whether this failure was transient.
		expect(autoResumableRoundOf(failure)).toBe(round);

		// ── Attempt 2: resumed. The model, seeing the same question, asks for the same write again.
		sent.length = 0;
		script = [writeRound(), { response: "Stored it — we deploy from main." }];
		const result = await think(round!);

		expect(result.response).toContain("deploy from main");
		// THE assertion. One execution, over two attempts, for one question — the duplicate side
		// effect #442 exists to prevent, reached through the door only a resumed turn opens.
		expect(executed).toHaveLength(1);

		// And the reason it did not re-run: the failed attempt's results were replayed as results,
		// so the model was answering with them in hand rather than being asked to fetch them again.
		const firstPrompt = JSON.stringify(sent[0].messages);
		expect(firstPrompt).toContain("toolu_1");
		expect(firstPrompt).toContain("tool_result");
		expect(firstPrompt).toContain("Saved. Keys now: deploy_target");
		// The prose shape #398 removed must not come back in through the resume path.
		expect(firstPrompt).not.toContain("I called tools:");

		// The repeat was refused with a reason the model can act on, not silently dropped.
		expect(JSON.stringify(sent[1].messages)).toContain("Already executed this exact call this turn");

		// The transcript still credits the work the FIRST attempt paid for.
		expect(result.toolCalls.join("\n")).toContain("write_memory");
	});

	it("recovers the whole turn automatically — the user is never told to send it again", async () => {
		// The same failure, driven through the wiring the DO uses. Nothing here re-types the
		// question: `thinkWithAutoResume` replays the round the failure carried, which is the point
		// for an owner who speaks his messages and cannot reproduce one byte for byte.
		script = [
			writeRound(),
			() => {
				throw Object.assign(new Error("The AI provider stopped sending mid-reply"), { status: 504, retryable: true });
			},
			writeRound(),
			{ response: "Stored it — we deploy from main." },
		];
		const result = await thinkWithAutoResume(think);
		expect(result.response).toContain("deploy from main");
		expect(executed).toHaveLength(1);
	});

	it("does not auto-retry the deterministic failure, and leaves the round for the user", async () => {
		// A `total` deadline: the reply was too long to finish, and the platform's own message says
		// a retry fails the same way. Retrying would spend the user's credit reproducing it.
		script = [
			writeRound(),
			() => {
				throw Object.assign(new Error("The reply was still being written after 180s"), { status: 504 });
			},
		];
		const failure = await thinkWithAutoResume(think).then(
			() => null,
			(e) => e,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(executed).toHaveLength(1);
		// One completion for the round, one that failed — no third.
		expect(sent).toHaveLength(2);
		// Still resumable BY HAND, at the composer, from the exact text the console restores.
		expect(resumableRoundOf(failure)?.executedTools).toEqual(["write_memory"]);
	});
});

describe("the Durable Object is wired to it, not merely able to be (#518)", () => {
	/**
	 * The failure this whole issue is about is a correct mechanism nothing reaches. A pure test of
	 * `thinkWithAutoResume` proves the mechanism; only this proves the DO goes through it. If a
	 * later edit calls `this.think` directly again, the retry silently stops happening in
	 * production while every test above stays green — the exact shape of #442's defect.
	 */
	it("`runTurn` reaches the thinker ONLY through the auto-resume wrapper", () => {
		const code = stripCommentsAndLiterals(readFileSync(new URL("./agent-do.ts", import.meta.url).pathname, "utf-8"));
		expect(code).toContain("thinkWithAutoResume(");
		expect([...code.matchAll(/this\.think\(/g)]).toHaveLength(1);
		// The one call site is the wrapper's argument, so the DO cannot think without it.
		expect(code).toMatch(/thinkWithAutoResume\(\s*\(r\) => this\.think\(/);
	});
});
