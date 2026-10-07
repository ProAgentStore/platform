/**
 * #960 — the Pilot's decision verb, end to end below the route: `ask_owner` → a `needs_input`
 * result carrying options → the pause publishes the question on the run's card and parks the run on
 * `decision` → every reader (wait note, fleet, run view) says what is being asked and how to answer
 * → the answer comes back to the Pilot as an answer to THAT question. The `/input` routing half is
 * `routes/coding-answer-input.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { getLoopRun, recordIteration, recordLiveness, type WaitingAsk } from "./agent-loop-store.js";
import { codingCardId } from "./coding-board.js";
import { ASK_OPTION_CHARS, ASK_OPTIONS_MAX, ASK_QUESTION_MAX, askOptions, CODING_TOOLS, runCodingLoop, systemPrompt, toDecision, type CodingDeps, type CodingPaneSnapshot } from "./coding-loop.js";
import { askCardId, resolvePause, type PauseDeps } from "./coding-pause.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { deriveFleetStatus, type FleetFacts } from "./fleet-snapshot.js";
import { askClause, waitClause } from "./work-report.js";
import type { Env } from "../types.js";

const ASK: WaitingAsk = { question: "Keep the old API or drop it?", options: ["keep it", "drop it"], why: "breaking change", field: "Keep the old API or drop it?", taskId: "csess-csess_s1" };

describe("ask_owner is a verb the Pilot has, and a choice it does not make (#960)", () => {
	it("is offered, and maps to a needs_input that carries the options", () => {
		expect(CODING_TOOLS.map((t) => t.name)).toContain("ask_owner");
		const d = toDecision({ name: "ask_owner", arguments: { question: "  Keep the old API or drop it?  ", options: ["keep it", "drop it"], why: "breaking change" } });
		expect(d).toEqual({ needsInput: { field: "Keep the old API or drop it?", why: "breaking change", options: ["keep it", "drop it"] } });
	});

	it("a question with no question is a handoff, not a blank prompt for the owner", () => {
		expect(toDecision({ name: "ask_owner", arguments: { question: "   ", options: ["a", "b"] } }).stuck?.why).toMatch(/did not say what it was/);
	});

	it("caps the question at a phone-sized length, and says it was cut", () => {
		const field = toDecision({ name: "ask_owner", arguments: { question: "q".repeat(ASK_QUESTION_MAX + 40), options: ["a", "b"] } }).needsInput?.field ?? "";
		expect(field.length).toBeLessThanOrEqual(ASK_QUESTION_MAX);
		expect(field).toMatch(/\[cut: showing the first \d+ of 340 characters\]$/);
	});

	it("cleans options: strings only, trimmed, de-duplicated, short, at most six", () => {
		expect(askOptions([" yes ", "yes", 3, null, "no", "x".repeat(ASK_OPTION_CHARS + 1)])).toEqual(["yes", "no"]);
		expect(askOptions(["1", "2", "3", "4", "5", "6", "7", "8"])).toHaveLength(ASK_OPTIONS_MAX);
	});

	it("turns a comma into a semicolon so the console's `from: a, b` list cannot split one option in two", () => {
		expect(askOptions(["keep it, deprecate later", "drop it"])).toEqual(["keep it; deprecate later", "drop it"]);
	});

	it("fewer than two options is a free-form question, not a one-button choice", () => {
		expect(askOptions(["only"])).toEqual([]);
		expect(askOptions("yes, no")).toEqual([]);
	});

	it("the loop ends needs_input with the options on the result and in the transcript", async () => {
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async () => idle,
			decide: async () => toDecision({ name: "ask_owner", arguments: { question: "Which DB?", options: ["D1", "KV"], why: "schema" } }),
		};
		const r = await runCodingLoop(deps, { objective: "x", repo: "demo", clientType: "claude" });
		expect(r).toMatchObject({ outcome: "needs_input", fieldNeeded: "Which DB?", detail: "schema", options: ["D1", "KV"] });
		expect(r.transcript?.at(-1)).toBe("needs_input: Which DB? [D1 | KV]");
	});

	it("the prompt tells the three asks apart, and sends an owner's y/n to ask_owner", () => {
		const p = systemPrompt({ objective: "x", repo: "demo", clientType: "claude" });
		expect(p).toMatch(/when the choice is the OWNER's to make, call ask_owner/);
		expect(p).toMatch(/call ask_owner with one short question and 2–6 options — do NOT decide it yourself and do NOT use request_human/);
	});
});

function pauseDeps(over: Partial<PauseDeps> = {}): PauseDeps & { asks: unknown[]; notes: Array<{ title: string; body: string; url?: string }>; said: string[] } {
	const asks: unknown[] = [];
	const notes: Array<{ title: string; body: string; url?: string }> = [];
	const said: string[] = [];
	return {
		asks,
		notes,
		said,
		repo: "demo",
		instanceId: "i1",
		sessionId: "csess_s1",
		takeover: vi.fn(async () => undefined),
		takeoverStatus: vi.fn(async () => ({ resolved: true, value: "drop it" })),
		endTakeover: vi.fn(async () => undefined),
		sleep: vi.fn(async () => undefined),
		notify: vi.fn(async (title: string, body: string, _k: string, _a: boolean, url?: string) => {
			notes.push({ title, body, url });
		}),
		announce: vi.fn(async (m: string) => {
			said.push(m);
		}),
		card: vi.fn(async () => undefined),
		tick: vi.fn(async () => true),
		reauthCompletedSince: vi.fn(async () => false),
		restartEngine: vi.fn(async () => undefined),
		now: () => 1_000_000,
		ask: async (a) => {
			asks.push(a);
		},
		...over,
	};
}

const asked = { outcome: "needs_input" as const, fieldNeeded: "Keep the old API or drop it?", detail: "breaking change", options: ["keep it", "drop it"], steps: 2 };

describe("the pause publishes a question as a question (#960)", () => {
	it("answers on the delegation card when there is one, else the session's own card", () => {
		expect(askCardId({ taskId: "deleg-1", sessionId: "csess_s1" })).toBe("deleg-1");
		expect(askCardId({ sessionId: "csess_s1" })).toBe(codingCardId("csess_s1"));
		expect(askCardId({})).toBeNull();
	});

	it("hands the ask to the publisher, links the push to that card, and feeds the answer back as an answer", async () => {
		const d = pauseDeps();
		const v = await resolvePause(d, { round: 3, result: asked, state: { waits: 0, spentMs: 0 } });
		expect(d.asks).toEqual([{ question: "Keep the old API or drop it?", options: ["keep it", "drop it"], why: "breaking change", field: "Keep the old API or drop it?", taskId: "csess-csess_s1" }]);
		expect(d.notes[0].title).toBe("❓ Coder has a question");
		expect(d.notes[0].body).toContain("Options: keep it | drop it.");
		expect(d.notes[0].url).toContain("csess-csess_s1");
		expect(d.said[0]).toMatch(/answer_instance_input — no need to take the session over/);
		expect(v).toMatchObject({ resume: true, userHint: 'The owner answered your question "Keep the old API or drop it?": drop it' });
	});

	it("a free-form value keeps its old `field: value` hint", async () => {
		const d = pauseDeps({ takeoverStatus: vi.fn(async () => ({ resolved: true, value: "eu-west-1" })) });
		const v = await resolvePause(d, { round: 0, result: { outcome: "needs_input", fieldNeeded: "AWS region", steps: 1 }, state: { waits: 0, spentMs: 0 } });
		expect(v).toMatchObject({ userHint: "AWS region: eu-west-1" });
		expect((d.asks[0] as { options: string[] }).options).toEqual([]);
	});

	it("a stuck handoff is not a question — nothing is published as one", async () => {
		const d = pauseDeps();
		await resolvePause(d, { round: 0, result: { outcome: "stuck", detail: "captcha", steps: 1 }, state: { waits: 0, spentMs: 0 } });
		expect(d.asks).toEqual([]);
		expect(d.notes[0].title).toBe("🙋 Coder needs you");
	});

	it("a publisher that throws does not fail the pause", async () => {
		const d = pauseDeps({ ask: async () => Promise.reject(new Error("D1 down")) });
		const v = await resolvePause(d, { round: 0, result: asked, state: { waits: 0, spentMs: 0 } });
		expect(v).toMatchObject({ resume: true });
	});
});

describe("every reader says what is being asked (#960)", () => {
	const NOW = 10_000_000;
	it("the wait note quotes the question, the options and how to answer", () => {
		const note = waitClause({ status: "running", waitingReason: "decision", waitingUntil: NOW + 600_000, waitingAsk: ASK, lastAliveAt: NOW, startedAt: 0 }, NOW) ?? "";
		expect(note).toContain('waiting for YOUR ANSWER to a question: "Keep the old API or drop it?"');
		expect(note).toContain("Options: keep it | drop it.");
		expect(note).toContain("answer_instance_input (task_id csess-csess_s1)");
	});

	it("without the stored ask it still says where to look", () => {
		expect(askClause(null)).toBe(" (open the run's card to see it)");
	});

	it("the fleet calls a decision park decision_blocked, not hard_blocked", () => {
		const facts: FleetFacts = { health: "waiting", waitingReason: "decision", queueDepth: 0, decisions: 0, ownerSecrets: 0, issues: null, runQuestion: { question: ASK.question, taskId: ASK.taskId } };
		expect(deriveFleetStatus(facts)).toEqual({ status: "decision_blocked", reason: expect.stringContaining('"Keep the old API or drop it?"') });
		expect(deriveFleetStatus({ ...facts, waitingReason: "human" }).status).toBe("hard_blocked");
	});
});

describe("the ask is stored on the run and cleared with the park (#960, real schema)", () => {
	function setup() {
		const db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at) VALUES ('r1','u1','i1','x','running',1,10,1)");
		return { db, env: { DB: db.DB } as unknown as Env };
	}

	it("a decision park round-trips its question into the run view", async () => {
		const { env } = setup();
		await recordLiveness(env, "r1", 2_000, { reason: "decision", ask: ASK });
		const run = await getLoopRun(env, "u1", "r1");
		expect(run).toMatchObject({ waitingReason: "decision", waitingAsk: ASK, parkedSince: 2_000 });
	});

	it("only a decision park stores an ask", async () => {
		const { db, env } = setup();
		await recordLiveness(env, "r1", 2_000, { reason: "human", ask: ASK });
		expect((await db.DB.prepare("SELECT waiting_ask FROM agent_loop_runs WHERE run_id='r1'").first<{ waiting_ask: string | null }>())?.waiting_ask).toBeNull();
		expect((await getLoopRun(env, "u1", "r1"))?.waitingAsk).toBeNull();
	});

	it("clearing the park — by heartbeat or by progress — clears the question", async () => {
		const { env } = setup();
		await recordLiveness(env, "r1", 2_000, { reason: "decision", ask: ASK });
		await recordLiveness(env, "r1", 3_000, null);
		expect((await getLoopRun(env, "u1", "r1"))?.waitingAsk).toBeNull();
		await recordLiveness(env, "r1", 4_000, { reason: "decision", ask: ASK });
		await recordIteration(env, "r1", 2);
		expect(await getLoopRun(env, "u1", "r1")).toMatchObject({ waitingReason: null, waitingAsk: null });
	});
});
