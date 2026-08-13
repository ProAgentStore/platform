import { describe, expect, it } from "vitest";
import { toolNamesFor } from "../agent-do-tools.js";
import { getRegistryTool, registryToolNameSet } from "./tool-registry.js";
import { endAgentCodingSession, pickSessionToEnd } from "./end-coding-session-tool.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

const caps = (over: Partial<AgentCapabilities> = {}) =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

describe("end_coding_session — the SECOND object of one gap (#540)", () => {
	it("is registered, and is not the same thing as stop_work", () => {
		// A run and a session have different lifecycles: `stop_work` stops the run and deliberately
		// leaves the session open (it is a cache, #408, and its engine conversation is worth keeping).
		// Collapsing them would make "stop" destroy a conversation the owner wanted kept.
		expect(registryToolNameSet().has("end_coding_session")).toBe(true);
		expect(getRegistryTool("end_coding_session")?.description).toMatch(/stop_work/);
	});

	it("is granted to a coding agent — including a Repo Coder with drive:false", () => {
		// The agent in #540. `drive:false` correctly withholds the tools that TYPE into the engine;
		// ending a session is not typing into it, so gating this on `drive` would have withheld the
		// stop from the exact instance whose owner asked five times.
		const repoCoder = caps({
			surfaces: ["coding"],
			runtime: "coding",
			workflow: "CODING_SESSION",
			tools: ["repo_git"],
			surfaceOptions: { coding: { repos: "single", drive: false, copilot: false } },
		} as Partial<AgentCapabilities>);
		expect(toolNamesFor(repoCoder).has("end_coding_session")).toBe(true);
		expect(toolNamesFor(caps({ surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" })).has("end_coding_session")).toBe(true);
	});

	it("is NOT granted to an agent with no coding surface", () => {
		// The leak class the capability registry closes: a doc-chat agent that has never had a session
		// does not need a tool for ending one. `FULL` is the generic default, so the tool is
		// deliberately outside it.
		expect(toolNamesFor(caps()).has("end_coding_session")).toBe(false);
		expect(toolNamesFor(caps({ surfaces: ["repo"] })).has("end_coding_session")).toBe(false);
		expect(toolNamesFor(caps({ surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" })).has("end_coding_session")).toBe(false);
	});
});

describe("pickSessionToEnd — it refuses to guess", () => {
	const names = new Map([
		["repo-a", "aipa"],
		["repo-b", "platform"],
	]);
	const s = (id: string, repoId: string) => ({ id, repoId });

	it("with one session open, that is the one", () => {
		const picked = pickSessionToEnd([s("csess-1", "repo-a")], names);
		expect(picked.ok && picked.session.id).toBe("csess-1");
	});

	it("with several open and no repo named, it asks instead of picking", () => {
		// The same rule `pickLoopRepo` states: ending the wrong session kills the engine holding
		// another repository, and that is not recoverable by asking again afterwards.
		const picked = pickSessionToEnd([s("csess-1", "repo-a"), s("csess-2", "repo-b")], names);
		expect(picked.ok).toBe(false);
		if (!picked.ok) {
			expect(picked.content).toContain("aipa");
			expect(picked.content).toContain("platform");
			expect(picked.content).toMatch(/Do not pick one yourself/);
		}
	});

	it("matches on repo name, id or session id", () => {
		const list = [s("csess-1", "repo-a"), s("csess-2", "repo-b")];
		expect(pickSessionToEnd(list, names, "platform").ok).toBe(true);
		expect(pickSessionToEnd(list, names, "AIPA").ok).toBe(true);
		expect(pickSessionToEnd(list, names, "csess-2").ok).toBe(true);
	});

	it("names the open sessions when the requested repo has none", () => {
		const picked = pickSessionToEnd([s("csess-1", "repo-a")], names, "nonesuch");
		expect(picked.ok).toBe(false);
		if (!picked.ok) expect(picked.content).toMatch(/No open coding session for "nonesuch"/);
	});

	it("with nothing open, says so and points at stop_work for a run", () => {
		const picked = pickSessionToEnd([], names);
		expect(picked.ok).toBe(false);
		if (!picked.ok) expect(picked.content).toContain("stop_work");
	});
});

describe("endAgentCodingSession — what it does, and what it refuses to claim", () => {
	/**
	 * D1 + relay mock. `RELAY` is absent, so `getRunnerConn` resolves nothing and the engine cannot
	 * be told to stop — the three-valued `engineStopped: null` case, which is the one an offline
	 * machine actually produces and the one it would be wrong to report as a clean stop.
	 */
	function mockEnv(opts: { sessions?: unknown[]; repos?: unknown[]; runs?: unknown[]; endChanges?: number } = {}) {
		const writes: { sql: string; args: unknown[] }[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						if (sql.trim().startsWith("UPDATE")) writes.push({ sql, args });
						return {
							async all() {
								if (sql.includes("coding_sessions")) return { results: opts.sessions ?? [] };
								if (sql.includes("coding_repos")) return { results: opts.repos ?? [] };
								if (sql.includes("agent_loop_runs")) return { results: opts.runs ?? [] };
								return { results: [] };
							},
							async first() {
								if (sql.includes("coding_sessions")) return (opts.sessions ?? [])[0] ?? null;
								return null;
							},
							async run() {
								return { meta: { changes: sql.includes("coding_sessions") ? (opts.endChanges ?? 1) : 1 } };
							},
						};
					},
				};
			},
		};
		return { env: { DB } as never, writes };
	}

	const session = (over: Record<string, unknown> = {}) => ({
		id: "csess-1",
		instance_id: "i1",
		repo_id: "repo-a",
		user_id: "u1",
		client_type: "claude",
		status: "active",
		tmux_session: "claude:1",
		runner_node: "mac-mini",
		launch_command: "claude",
		issue_number: null,
		issue_title: null,
		started_at: "2026-08-13 00:00:00",
		ended_at: null,
		updated_at: "2026-08-13 00:00:00",
		...over,
	});

	const loopRun = (over: Record<string, unknown> = {}) => ({
		run_id: "r1",
		user_id: "u1",
		instance_id: "i1",
		objective: "fix the build",
		status: "running",
		stop_reason: null,
		detail: null,
		iteration: 2,
		max_iterations: 10,
		cancel_requested: 0,
		budget_id: null,
		started_at: Date.now(),
		finished_at: null,
		last_progress_at: Date.now(),
		session_id: "csess-1",
		...over,
	});

	it("ends the one open session and does not claim the engine stopped when nobody could be asked", async () => {
		const { env } = mockEnv({ sessions: [session()] });
		const res = await endAgentCodingSession(env, "i1", "u1");
		expect(res.success).toBe(true);
		expect(res.content).toMatch(/Ended the coding session/);
		// "The machine is not connected" is not "the engine stopped" — it is the state in which
		// nobody can say, and reporting it as a clean stop is the false-success class.
		expect(res.content).toMatch(/not connected/);
	});

	it("asks the run driving that session to stop, and says it was ASKED", async () => {
		// Ending the session alone already stops the Pilot (`pilotStopSignal` treats an `ended`
		// session as a stop) — but with no reason recorded, so the run reads afterwards as having
		// simply died. With the flag set it records "Stopped by you.", which is the true sentence.
		const { env, writes } = mockEnv({ sessions: [session()], runs: [loopRun()] });
		const res = await endAgentCodingSession(env, "i1", "u1");
		expect(writes.some((w) => w.sql.includes("cancel_requested = 1") && w.args.includes("r1"))).toBe(true);
		expect(res.content).toMatch(/has been asked to stop/);
		// And the report is told, in the same sentence, which of the two claims it may make.
		expect(res.content).toMatch(/rather than that it has stopped/);
	});

	it("does not claim to have ended a session that was already closed", async () => {
		// The row did not move, so something else closed it between the read and the write.
		const { env } = mockEnv({ sessions: [session()], endChanges: 0 });
		const res = await endAgentCodingSession(env, "i1", "u1");
		expect(res.content).toMatch(/already closed/);
		expect(res.content).toMatch(/Do not claim you ended it/);
	});

	it("with nothing open, it is an answer rather than a failure", async () => {
		const { env } = mockEnv({ sessions: [] });
		const res = await endAgentCodingSession(env, "i1", "u1");
		expect(res.success).toBe(true);
		expect(res.content).toMatch(/no coding session open/);
	});
});
