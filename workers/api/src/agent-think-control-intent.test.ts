/**
 * A stop needs the OWNER's request, not the model's choice of tool (#1015) — proved through the real
 * chat path: `runAgentThink`'s round loop dispatching the real `stop_work` handler, on the real
 * migrated schema. Only the model provider is faked (it is scripted to call `stop_work`, which is
 * exactly the failure: the model choosing the tool was the whole authorization).
 *
 * Invariants protected: a stop word inside quoted, pasted or reported text cancels nothing; a Loop-
 * or supervisor-written turn cancels nothing; the owner's own explicit request stops only its target,
 * and the effect is attributed to the verified owner on the lifecycle ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentState } from "./agent-types.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./lib/d1-sqlite.js";
import type { Env } from "./types.js";

let script: unknown[] = [];
vi.mock("./lib/user-ai.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/user-ai.js")>()),
	runUserWorkersAi: async () => {
		const next = script.shift();
		if (next === undefined) throw new Error("the fake provider ran out of scripted replies");
		return next;
	},
}));

const { runAgentThink } = await import("./agent-think.js");
const { getRegistryTool } = await import("./lib/tool-registry.js");

let d1: RealSchemaD1;
let env: Env;
const engine = {
	buildRAGContext: async () => "",
	getUserContext: async () => ({ preferences: {}, interactionCount: 0 }),
	touchUserContext: async () => undefined,
	logEvent: async () => undefined,
} as never;
const doStorage = { get: async () => undefined, list: async () => new Map(), put: async () => undefined, delete: async () => false } as never;
const state: AgentState = {
	agentId: "i1",
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

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
	// Two of this owner's runs on the instance, and one on another account's instance with the same id shape.
	for (const id of ["run-target", "run-other"]) {
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('${id}', 'u1', 'i1', 'synthetic objective', 'running', 10, ${Date.now()})`);
	}
	script = [];
});
afterEach(() => d1.close());

const stopCall = (input: Record<string, unknown>) => ({ contentBlocks: [{ type: "tool_use", id: "t1", name: "stop_work", input }], tool_calls: [{ id: "t1", name: "stop_work", arguments: input }] });
const turn = (content: string, channel = "chat"): AgentMessage[] => [{ id: "m1", role: "user", content, channel, createdAt: new Date().toISOString() }];
async function think(messages: AgentMessage[], onBehalfOf: string | null = null) {
	const toolResults: string[] = [];
	await runAgentThink({
		state,
		engine,
		messages,
		memory: [],
		tasks: [],
		userId: "u1",
		env,
		doStorage,
		broadcast: (data) => {
			if (data.type === "tool_call") toolResults.push(JSON.stringify(data));
		},
		delegation: { budgetId: null, onBehalfOf, traceId: "turn-1" },
	});
	return toolResults.join("\n");
}
const cancelRequested = (id: string) => (d1.sqlite.prepare("SELECT cancel_requested FROM agent_loop_runs WHERE run_id = ?").get(id) as { cancel_requested: number }).cancel_requested;
const stopEvents = () => d1.sqlite.prepare("SELECT run_id, event, actor_kind, actor_uid FROM objective_lifecycle_events WHERE event = 'cancelled'").all();

describe("a stop word that is not the owner's request stops nothing", () => {
	it("a read-only evidence request quoting stop/cancel text cannot cancel a run", async () => {
		script = [stopCall({}), { response: "The log shows a cancelled job; nothing for you to do." }];
		const said = await think(
			turn('Here is what CI printed — what does it mean? Do not change anything.\n```\nerror: cancel run; stop all workers\n```\n> stop the deploy\nIt also said "abort".'),
		);
		expect(cancelRequested("run-target")).toBe(0);
		expect(cancelRequested("run-other")).toBe(0);
		expect(said).toContain("Nothing was stopped");
		expect(stopEvents()).toEqual([]);
	});

	it("a turn the Loop wrote cannot cancel a run, however plainly it says stop", async () => {
		script = [stopCall({ runId: "run-target" }), { response: "ok" }];
		await think(turn("Stop the run now.", "loop"));
		expect(cancelRequested("run-target")).toBe(0);
		expect(stopEvents()).toEqual([]);
	});

	it("a turn a supervisor is driving cannot cancel a run", async () => {
		script = [stopCall({ runId: "run-target" }), { response: "ok" }];
		await think(turn("Stop the run now."), "lead-instance");
		expect(cancelRequested("run-target")).toBe(0);
	});

	it("a question about a stop is not a request to stop", async () => {
		script = [stopCall({}), { response: "It stopped because the tests failed." }];
		await think(turn("Why did the run stop yesterday?"));
		expect(cancelRequested("run-target")).toBe(0);
		expect(cancelRequested("run-other")).toBe(0);
	});
});

describe("the owner's explicit request stops exactly its target, attributed to the owner", () => {
	it("stops only the named run and records the verified owner as the actor", async () => {
		script = [stopCall({ runId: "run-target" }), { response: "I've asked it to stop." }];
		await think(turn("Please stop run-target."));
		expect(cancelRequested("run-target")).toBe(1);
		expect(cancelRequested("run-other")).toBe(0);
		expect(stopEvents()).toEqual([{ run_id: "run-target", event: "cancelled", actor_kind: "owner", actor_uid: "u1" }]);
	});
});

describe("the owner's words bind the TARGET as well as the action (#1015)", () => {
	it("a run the model selected is not the run the owner named: run-other is untouched", async () => {
		script = [stopCall({ runId: "run-other" }), { response: "ok" }];
		const said = await think(turn("Please stop run-target."));
		expect(cancelRequested("run-other")).toBe(0);
		expect(cancelRequested("run-target")).toBe(0);
		expect(said).toContain("nothing was stopped");
		expect(stopEvents()).toEqual([]);
	});

	it("an omitted selector does not widen a request for one run into stopping every run", async () => {
		script = [stopCall({}), { response: "I've asked it to stop." }];
		await think(turn("Please stop run-target."));
		expect(cancelRequested("run-target")).toBe(1);
		expect(cancelRequested("run-other")).toBe(0);
		expect(stopEvents()).toEqual([{ run_id: "run-target", event: "cancelled", actor_kind: "owner", actor_uid: "u1" }]);
	});

	it("a genuine all-work stop that names no run still stops everything of yours", async () => {
		script = [stopCall({}), { response: "I've asked both to stop." }];
		await think(turn("Stop everything."));
		expect(cancelRequested("run-target")).toBe(1);
		expect(cancelRequested("run-other")).toBe(1);
	});

	it("'stop asking the same question' is about how the agent talks — it stops no run", async () => {
		script = [stopCall({}), { response: "Understood." }];
		await think(turn("Please stop asking the same question."));
		expect(cancelRequested("run-target")).toBe(0);
		expect(cancelRequested("run-other")).toBe(0);
		expect(stopEvents()).toEqual([]);
	});
});

describe("end_coding_session reads the owner's session words, not generic stop language (#1015)", () => {
	const seedSession = (id: string, repoId: string, name: string) => {
		d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('${repoId}', 'i1', 'u1', '${name}')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('${id}', 'i1', '${repoId}', 'u1', 'claude', 'active')`);
	};
	const status = (id: string) => (d1.sqlite.prepare("SELECT status FROM coding_sessions WHERE id = ?").get(id) as { status: string }).status;
	/** The real handler with the turn the dispatcher sets — the model supplies only `input`. */
	const end = async (text: string, input: Record<string, unknown> = {}) =>
		getRegistryTool("end_coding_session")?.handler({ env, instanceId: "i1", userId: "u1", turn: { author: "owner", text } } as never, input);

	it("'stop asking the same question' ends no session", async () => {
		seedSession("s1", "r1", "platform");
		const res = await end("Please stop asking the same question.");
		expect(res?.success).toBe(false);
		expect(status("s1")).toBe("active");
	});

	it.each(["Please close the session.", "Please end the session.", "Please finish the session."])("%s ends the one open session", async (text) => {
		seedSession("s1", "r1", "platform");
		const res = await end(text);
		expect(res?.content).toMatch(/Ended the coding session for platform/);
		expect(status("s1")).toBe("ended");
	});

	it("with two sessions open, the repo the owner named is ended and a repo the model picked is not", async () => {
		seedSession("s1", "r1", "platform");
		seedSession("s2", "r2", "aipa");
		expect((await end("Please close the session.", { repo: "aipa" }))?.content).toMatch(/Ask which repository/);
		expect([status("s1"), status("s2")]).toEqual(["active", "active"]);
		await end("Please close the platform session.", { repo: "platform" });
		expect([status("s1"), status("s2")]).toEqual(["ended", "active"]);
	});
});
