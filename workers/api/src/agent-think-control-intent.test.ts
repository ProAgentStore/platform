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

describe("negated run targets (#1015 slice 2)", () => {
	it("'stop run-target, not run-other' never authorizes run-other, even when the model picks it", async () => {
		script = [stopCall({ runId: "run-other" }), { response: "ok" }];
		const said = await think(turn("Please stop run-target, not run-other."));
		expect(said).toContain("said not to stop run-other");
		expect([cancelRequested("run-target"), cancelRequested("run-other")]).toEqual([0, 0]);
		expect(stopEvents()).toEqual([]);
	});

	it("the positive target of the same sentence still stops — picked, or with the selector omitted", async () => {
		script = [stopCall({ runId: "run-target" }), { response: "I've asked it to stop." }];
		await think(turn("Please stop run-target, not run-other."));
		expect([cancelRequested("run-target"), cancelRequested("run-other")]).toEqual([1, 0]);
		d1.exec("UPDATE agent_loop_runs SET cancel_requested = 0");
		script = [stopCall({}), { response: "I've asked it to stop." }];
		await think(turn("Please stop run-target, not run-other."));
		expect([cancelRequested("run-target"), cancelRequested("run-other")]).toEqual([1, 0]);
	});

	it("'stop everything except run-other' leaves run-other running", async () => {
		script = [stopCall({}), { response: "I've asked it to stop." }];
		await think(turn("Stop everything except run-other."));
		expect([cancelRequested("run-target"), cancelRequested("run-other")]).toEqual([1, 0]);
		expect(stopEvents()).toEqual([{ run_id: "run-target", event: "cancelled", actor_kind: "owner", actor_uid: "u1" }]);
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

	// ── negated and unresolved targets (#1015 slice 2) ──
	it("a repo the owner excluded is never ended, even when the model picks it", async () => {
		seedSession("s1", "r1", "platform");
		seedSession("s2", "r2", "aipa");
		const res = await end("Please close the platform session, not aipa.", { repo: "aipa" });
		expect(res?.content).toMatch(/said not to end the aipa session/);
		expect([status("s1"), status("s2")]).toEqual(["active", "active"]);
	});

	it("the repo the owner named is ended beside an excluded one — whether the model picks it or omits the repo", async () => {
		seedSession("s1", "r1", "platform");
		seedSession("s2", "r2", "aipa");
		await end("Please close the platform session, not aipa.", { repo: "platform" });
		expect([status("s1"), status("s2")]).toEqual(["ended", "active"]);
		d1.exec("UPDATE coding_sessions SET status = 'active' WHERE id = 's1'");
		await end("Please close the platform session, not aipa.");
		expect([status("s1"), status("s2")]).toEqual(["ended", "active"]);
	});

	it("a repo the owner named with no open session ends nothing — never the one unrelated open session", async () => {
		seedSession("s2", "r2", "aipa");
		d1.exec("INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'platform')");
		for (const input of [{ repo: "aipa" }, {}]) {
			const res = await end("Please close the platform session.", input);
			expect(res?.content, JSON.stringify(input)).toMatch(/No open coding session for "platform"/);
			expect(status("s2")).toBe("active");
		}
	});

	it("the only open session is not the fallback when the owner excluded it", async () => {
		seedSession("s2", "r2", "aipa");
		const res = await end("Please close the session, not aipa.");
		expect(res?.content).toMatch(/said not to end/);
		expect(status("s2")).toBe("active");
	});
});

// ── The target-resolution invariant (#1015): a target the owner gave stays a target ──────────────
//
// Writer calls are counted directly: `cancel_requested` on every run (what `stop_work` writes) and
// every session's `status` (what `end_coding_session` writes). An empty, conflicting, absent or
// colliding target fails closed — it never widens into "all work" or the one unrelated session.

describe("run targets that the owner's words leave empty, conflicting or colliding stop nothing extra (#1015)", () => {
	const RUN_UUID = "3f2a9c1e-7b4d-4e2a-9f10-5c6d7e8f9a0b";
	beforeEach(() => {
		for (const id of ["run-third", RUN_UUID]) {
			d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('${id}', 'u1', 'i1', 'synthetic objective', 'running', 10, ${Date.now()})`);
		}
	});
	const all = () => ["run-target", "run-other", "run-third", RUN_UUID].map(cancelRequested);

	it.each([[{}], [{ runId: "run-target" }]])("'Not run-other: please stop run-target.' stops run-target only (selector %j)", async (input) => {
		script = [stopCall(input), { response: "ok" }];
		await think(turn("Not run-other: please stop run-target."));
		expect(all()).toEqual([1, 0, 0, 0]);
	});

	it("'Not run-other: please stop run-target.' with the model picking an unrelated run stops nothing", async () => {
		script = [stopCall({ runId: "run-third" }), { response: "ok" }];
		const said = await think(turn("Not run-other: please stop run-target."));
		expect(all()).toEqual([0, 0, 0, 0]);
		expect(said).toContain("nothing was stopped");
	});

	it.each([[{}], [{ runId: "run-third" }], [{ runId: "run-target" }]])("a contradictory 'stop run-target, not run-target' stops nothing (selector %j)", async (input) => {
		script = [stopCall(input), { response: "ok" }];
		const said = await think(turn("Please stop run-target, not run-target."));
		expect(all()).toEqual([0, 0, 0, 0]);
		expect(said).toContain("nothing was stopped");
		expect(stopEvents()).toEqual([]);
	});

	it.each([[{}], [{ runId: "run-third" }]])("exclusions that swallow every named run do not fall back to all work (selector %j)", async (input) => {
		script = [stopCall(input), { response: "ok" }];
		await think(turn("Not run-other, please stop run-target."));
		expect(all()).toEqual([0, 0, 0, 0]);
	});

	it.each([[{}], [{ runId: RUN_UUID }]])("a real run id followed by '-extra' is not that run (selector %j)", async (input) => {
		script = [stopCall(input), { response: "ok" }];
		await think(turn(`Please stop ${RUN_UUID}-extra.`));
		expect(all()).toEqual([0, 0, 0, 0]);
	});

	// ── controls ──
	it("the exact run id still stops exactly that run", async () => {
		script = [stopCall({}), { response: "ok" }];
		await think(turn(`Please stop ${RUN_UUID}.`));
		expect(all()).toEqual([0, 0, 0, 1]);
	});

	it("an unknown well-formed run id with the selector omitted stops nothing", async () => {
		script = [stopCall({}), { response: "ok" }];
		await think(turn("Please stop 00000000-0000-4000-8000-000000000000."));
		expect(all()).toEqual([0, 0, 0, 0]);
	});

	it("a negation-first sentence still stops its positive target", async () => {
		script = [stopCall({}), { response: "ok" }];
		await think(turn("Don't stop run-other. Stop run-target."));
		expect(all()).toEqual([1, 0, 0, 0]);
	});

	it("a genuine 'everything except' still stops all the rest", async () => {
		script = [stopCall({}), { response: "ok" }];
		await think(turn("Stop everything except run-other."));
		expect(all()).toEqual([1, 0, 1, 1]);
	});
});

describe("session targets the owner gave are resolved exactly or fail closed (#1015)", () => {
	const seedRepo = (repoId: string, name: string) => d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('${repoId}', 'i1', 'u1', '${name}')`);
	const seedSession = (id: string, repoId: string, name: string) => {
		seedRepo(repoId, name);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('${id}', 'i1', '${repoId}', 'u1', 'claude', 'active')`);
	};
	const statuses = () => (d1.sqlite.prepare("SELECT id, status FROM coding_sessions ORDER BY id").all() as Array<{ id: string; status: string }>).map((r) => `${r.id}:${r.status}`);
	const end = async (text: string, input: Record<string, unknown> = {}) =>
		getRegistryTool("end_coding_session")?.handler({ env, instanceId: "i1", userId: "u1", turn: { author: "owner", text } } as never, input);

	// ── absent from the catalog ──
	it.each([[{}], [{ repo: "aipa" }]])("'close the platform session' with no platform repo ends nothing, not the one aipa session (input %j)", async (input) => {
		seedSession("s2", "r2", "aipa");
		const res = await end("Please close the platform session.", input);
		expect(statuses()).toEqual(["s2:active"]);
		expect(res?.content).toMatch(/no repository called "platform"/);
	});

	it.each([[{}], [{ repo: "aipa" }]])("'close the ghost session, not platform' ends nothing (input %j)", async (input) => {
		seedSession("s2", "r2", "aipa");
		await end("Please close the ghost session, not platform.", input);
		expect(statuses()).toEqual(["s2:active"]);
	});

	it.each([[{}], [{ repo: "aipa" }]])("a failed repository lookup ends nothing — not the generic fallback (input %j)", async (input) => {
		seedSession("s2", "r2", "aipa");
		d1.exec("ALTER TABLE coding_repos RENAME TO coding_repos_unavailable");
		const res = await end("Please close the session.", input);
		expect(statuses()).toEqual(["s2:active"]);
		expect(res?.content).toMatch(/could not read this agent's repositories/i);
	});

	// ── quoted target ──
	it.each([[{}], [{ repo: "aipa" }]])("an inline-code target is still the owner's target: 'close the `platform` session' (input %j)", async (input) => {
		seedRepo("r1", "platform");
		seedSession("s2", "r2", "aipa");
		await end("Please close the `platform` session.", input);
		expect(statuses()).toEqual(["s2:active"]);
		seedSession("s1", "r1", "platform");
		await end("Please close the `platform` session.", input);
		expect(statuses()).toEqual(["s1:ended", "s2:active"]);
	});

	// ── conflicting exclusion ──
	it.each([[{}], [{ repo: "aipa" }], [{ repo: "platform" }]])("'close the platform session, not platform' ends nothing (input %j)", async (input) => {
		seedRepo("r1", "platform");
		seedSession("s1", "r1", "platform");
		seedSession("s2", "r2", "aipa");
		await end("Please close the platform session, not platform.", input);
		expect(statuses()).toEqual(["s1:active", "s2:active"]);
		d1.exec("UPDATE coding_sessions SET status = 'ended' WHERE id = 's1'");
		await end("Please close the platform session, not platform.", input);
		expect(statuses()).toEqual(["s1:ended", "s2:active"]);
	});

	// ── exact prefix collision ──
	it.each([[{}], [{ repo: "platform" }]])("'close the platform-extra session' does not fall back to the sole platform session (input %j)", async (input) => {
		seedSession("s1", "r1", "platform");
		await end("Please close the platform-extra session.", input);
		expect(statuses()).toEqual(["s1:active"]);
	});

	it("a qualified 'owner/repo' target resolves to that repository", async () => {
		seedSession("s1", "r1", "ProAgentStore/platform");
		seedSession("s2", "r2", "aipa");
		await end("Please close the ProAgentStore/platform session.");
		expect(statuses()).toEqual(["s1:ended", "s2:active"]);
	});

	// ── controls ──
	it("a generic 'close the coding session' still ends the one open session", async () => {
		seedSession("s1", "r1", "platform");
		await end("Please close the coding session.");
		expect(statuses()).toEqual(["s1:ended"]);
	});

	it("a genuine 'close every session except aipa' ends the rest", async () => {
		seedSession("s1", "r1", "platform");
		seedSession("s2", "r2", "aipa");
		await end("Close every session except aipa.");
		expect(statuses()).toEqual(["s1:ended", "s2:active"]);
	});
});

// ── #1015 external audit of 374cc0f8: token boundaries, negation leads, named sessions, qualified repos ──
//
// One fail-closed model: a token that only CONTAINS a real id is not that id, every negation lead
// excludes, "the session named/for X" names X (sentence punctuation is not part of it), and a short
// repo name shared by two qualified repos is ambiguous — never the model's pick.

describe("run ids are exact whole tokens, and every negation lead excludes (#1015 audit)", () => {
	const A = "11111111-1111-4111-8111-111111111111";
	const B = "22222222-2222-4222-8222-222222222222";
	const C = "33333333-3333-4333-8333-333333333333";
	beforeEach(() => {
		for (const id of [A, B, C]) {
			d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('${id}', 'u1', 'i1', 'synthetic objective', 'running', 10, ${Date.now()})`);
		}
	});
	/** [A, B, C, run-target, run-other] — every writer the stop could reach. */
	const all = () => [A, B, C, "run-target", "run-other"].map(cancelRequested);

	it.each([
		["extra-A", `Please stop extra-${A}.`],
		["xA", `Please stop x${A}.`],
		["_A", `Please stop _${A}.`],
		["A-extra", `Please stop ${A}-extra.`],
	])("'%s' is not run A: nothing stops with the selector omitted, and the model's B is refused", async (_name, text) => {
		script = [stopCall({}), { response: "ok" }];
		await think(turn(text));
		expect(all()).toEqual([0, 0, 0, 0, 0]);
		script = [stopCall({ runId: B }), { response: "ok" }];
		await think(turn(text));
		expect(all()).toEqual([0, 0, 0, 0, 0]);
	});

	it.each([`Never stop ${A}. Stop ${B}.`, `No need to stop ${A}. Stop ${B}.`, `Don't stop ${A}. Stop ${B}.`, `Do not stop ${A}. Stop ${B}.`])("%s never stops A — omitted selector stops B only, the model's A is refused", async (text) => {
		script = [stopCall({}), { response: "ok" }];
		await think(turn(text));
		expect(all()).toEqual([0, 1, 0, 0, 0]);
		d1.exec("UPDATE agent_loop_runs SET cancel_requested = 0");
		script = [stopCall({ runId: A }), { response: "ok" }];
		await think(turn(text));
		expect(all()).toEqual([0, 0, 0, 0, 0]);
	});

	// ── controls ──
	it("the exact id: omitted and correct selectors stop A only; a mismatched selector stops nothing", async () => {
		for (const [input, expected] of [[{}, [1, 0, 0, 0, 0]], [{ runId: A }, [1, 0, 0, 0, 0]], [{ runId: B }, [0, 0, 0, 0, 0]]] as const) {
			d1.exec("UPDATE agent_loop_runs SET cancel_requested = 0");
			script = [stopCall(input), { response: "ok" }];
			await think(turn(`Please stop ${A}.`));
			expect(all(), JSON.stringify(input)).toEqual(expected);
		}
	});

	it("'never mind' is not a negation of what follows", async () => {
		script = [stopCall({}), { response: "ok" }];
		await think(turn(`Never mind, stop ${B}.`));
		expect(all()).toEqual([0, 1, 0, 0, 0]);
	});

	it("a global stop still stops everything, and 'everything except A' everything else", async () => {
		script = [stopCall({}), { response: "ok" }];
		await think(turn("Stop everything."));
		expect(all()).toEqual([1, 1, 1, 1, 1]);
		d1.exec("UPDATE agent_loop_runs SET cancel_requested = 0");
		script = [stopCall({}), { response: "ok" }];
		await think(turn(`Stop everything except ${A}.`));
		expect(all()).toEqual([0, 1, 1, 1, 1]);
	});
});

describe("session targets: negation leads, named sessions, sentence punctuation and qualified repos (#1015 audit)", () => {
	const seedSession = (id: string, repoId: string, name: string) => {
		d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('${repoId}', 'i1', 'u1', '${name}')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('${id}', 'i1', '${repoId}', 'u1', 'claude', 'active')`);
	};
	const statuses = () => (d1.sqlite.prepare("SELECT id, status FROM coding_sessions ORDER BY id").all() as Array<{ id: string; status: string }>).map((r) => `${r.id}:${r.status}`);
	const reset = () => d1.exec("UPDATE coding_sessions SET status = 'active'");
	const end = async (text: string, input: Record<string, unknown> = {}) =>
		getRegistryTool("end_coding_session")?.handler({ env, instanceId: "i1", userId: "u1", turn: { author: "owner", text } } as never, input);

	it("'Never close the platform session. Close the aipa session.' never closes platform, even when the model picks it", async () => {
		seedSession("s1", "r1", "platform");
		seedSession("s2", "r2", "aipa");
		const text = "Never close the platform session. Close the aipa session.";
		await end(text, { repo: "platform" });
		expect(statuses()).toEqual(["s1:active", "s2:active"]);
		for (const input of [{}, { repo: "aipa" }]) {
			reset();
			await end(text, input);
			expect(statuses(), JSON.stringify(input)).toEqual(["s1:active", "s2:ended"]);
		}
	});

	it.each([[{}], [{ repo: "aipa" }]])("'Please close the session named ghost.' with only aipa open ends nothing (input %j)", async (input) => {
		seedSession("s2", "r2", "aipa");
		await end("Please close the session named ghost.", input);
		expect(statuses()).toEqual(["s2:active"]);
	});

	it("'Please close the session for platform.' — the period is the sentence's: omitted and correct selectors end platform, a mismatched one cannot end aipa", async () => {
		seedSession("s1", "r1", "platform");
		seedSession("s2", "r2", "aipa");
		for (const input of [{}, { repo: "platform" }, { repo: "aipa" }]) {
			reset();
			await end("Please close the session for platform.", input);
			expect(statuses(), JSON.stringify(input)).toEqual(["s1:ended", "s2:active"]);
		}
	});

	it("with owner1/platform and owner2/platform, the owner's owner1/platform never authorizes the model's owner2/platform", async () => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "owner2/platform");
		for (const input of [{ repo: "owner2/platform" }, {}, { repo: "owner1/platform" }]) {
			reset();
			await end("Please close the owner1/platform session.", input);
			expect(statuses(), JSON.stringify(input)).toEqual(["s1:ended", "s2:active"]);
		}
	});

	it.each([[{}], [{ repo: "owner2/platform" }], [{ repo: "owner1/platform" }]])("a bare 'platform' shared by two repositories is ambiguous: nothing ends (input %j)", async (input) => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "owner2/platform");
		await end("Please close the platform session.", input);
		expect(statuses()).toEqual(["s1:active", "s2:active"]);
	});

	it("controls: a generic close ends the one open session; a unique short name still resolves its qualified repo", async () => {
		seedSession("s1", "r1", "acme/widget");
		await end("Please close the session.");
		expect(statuses()).toEqual(["s1:ended"]);
		reset();
		await end("Please close the widget session.", { repo: "acme/widget" });
		expect(statuses()).toEqual(["s1:ended"]);
	});
});

// ── #1015 follow-up: identity-bearing suffixes, ambiguous exclusions, post-session labels ──────────────
//
// Writer-level: every session row's status is read after each call. "Zero writes" means every row is
// exactly as seeded. Each case below names whether the previous source wrote to the wrong target.

describe("session identity is exact: suffixes, shared names in exclusions, and labels after 'session' (#1015)", () => {
	const seedRepo = (repoId: string, name: string) => d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('${repoId}', 'i1', 'u1', '${name}')`);
	const seedSession = (id: string, repoId: string, name: string) => {
		seedRepo(repoId, name);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('${id}', 'i1', '${repoId}', 'u1', 'claude', 'active')`);
	};
	const statuses = () => (d1.sqlite.prepare("SELECT id, status FROM coding_sessions ORDER BY id").all() as Array<{ id: string; status: string }>).map((r) => `${r.id}:${r.status}`);
	const end = async (text: string, input: Record<string, unknown> = {}) =>
		getRegistryTool("end_coding_session")?.handler({ env, instanceId: "i1", userId: "u1", turn: { author: "owner", text } } as never, input);

	// ── 1. A trailing "-", "/" or ".." is part of the name. Previously stripped → the name read as a known
	//       repo, nothing matched, and the request fell back to the one open session: WRONG-TARGET WRITES. ──
	const SUFFIXED = ["platform-", "platform/", "owner1/platform-", "owner1/platform/"];
	const QUOTES: Array<[string, (x: string) => string]> = [
		["plain", (x) => x],
		["backtick", (x) => `\`${x}\``],
		["double-quoted", (x) => `"${x}"`],
	];
	const POSITIONS: Array<[string, (x: string) => string]> = [
		["X session", (x) => `Please close the ${x} session.`],
		["session for X", (x) => `Please close the session for ${x}.`],
		["session named X", (x) => `Please close the session named ${x}.`],
	];
	const SELECTORS: Array<Record<string, unknown>> = [{}, { repo: "aipa" }];
	const suffixCases = SUFFIXED.flatMap((name) => QUOTES.flatMap(([q, quote]) => POSITIONS.flatMap(([p, phrase]) => SELECTORS.map((sel) => [`${phrase(quote(name))} [${q}, ${p}, selector ${JSON.stringify(sel)}]`, phrase(quote(name)), sel] as const))));
	it.each(suffixCases)("%s — zero writes", async (_label, text, sel) => {
		seedRepo("r1", "platform");
		seedRepo("r3", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end(text, sel);
		expect(statuses()).toEqual(["s2:active"]);
	});

	// ── 2. A short name two repositories share, in an EXCLUSION, excludes both. Previously it excluded
	//       neither, so the one open platform session was ended: WRONG-TARGET WRITES (A, B, C). ──
	it.each([
		["A: only owner1/platform open", ["owner1"], "Close every session except platform."],
		["B: only owner1/platform open", ["owner1"], "Please close the session, not platform."],
		["C: only owner2/platform open", ["owner2"], "Close every session except platform."],
		["D: both open", ["owner1", "owner2"], "Close every session except platform."],
	])("%s — '%s' — zero writes", async (_label, open, text) => {
		seedRepo("r1", "owner1/platform");
		seedRepo("r2", "owner2/platform");
		if (open.includes("owner1")) seedSession("s1", "r1", "owner1/platform");
		if (open.includes("owner2")) seedSession("s2", "r2", "owner2/platform");
		const before = statuses();
		await end(text as string);
		expect(statuses()).toEqual(before);
	});

	// ── 3. A label directly after "session" is a target. Previously the bare form was invisible and the
	//       one open session was ended: WRONG-TARGET WRITES for the two unquoted "session ghost" cases. ──
	it.each([
		["Please close the session ghost.", {}],
		["Please close the session ghost.", { repo: "aipa" }],
		["Please close the session `ghost`.", {}],
		["Please close the session `ghost`.", { repo: "aipa" }],
		["Please close the session other/platform.", {}],
		["Please close the session other/platform.", { repo: "aipa" }],
		["Please close session `ghost`.", {}],
		["Please close session `ghost`.", { repo: "aipa" }],
	])("'%s' (selector %j) — zero writes", async (text, sel) => {
		seedRepo("r3", "other/platform");
		seedSession("s2", "r2", "aipa");
		await end(text, sel);
		expect(statuses()).toEqual(["s2:active"]);
	});

	// ── controls ──
	it("a generic close still ends the one open session", async () => {
		seedSession("s2", "r2", "aipa");
		await end("Please close the session.");
		expect(statuses()).toEqual(["s2:ended"]);
	});

	it("'close the session for aipa.' — the sentence's period — ends aipa", async () => {
		seedSession("s2", "r2", "aipa");
		await end("Please close the session for aipa.");
		expect(statuses()).toEqual(["s2:ended"]);
	});

	it("'close the session aipa.' — a known label directly after 'session' — ends aipa", async () => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end("Please close the session aipa.");
		expect(statuses()).toEqual(["s1:active", "s2:ended"]);
	});

	it("'Close every session except aipa.' with aipa and owner1/platform open ends owner1/platform only", async () => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end("Close every session except aipa.");
		expect(statuses()).toEqual(["s1:ended", "s2:active"]);
	});
});
