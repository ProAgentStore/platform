/**
 * A lost engine turn after a runner restart is resumed exactly once or ends the run `turn_lost` (#1053).
 *
 * Drives the real `runCodingSessionWorkflow` — real `runCodingLoop`, real `sendAct`, real runner guard, real
 * D1 schema — with only its two edges faked, as `scope-evidence.test.ts` does: the machine (`runner-client`)
 * and the BYOK brain (`decideCodingAction`). The machine below keeps an input ledger the way the runner does
 * (browser-runner coding/input-ledger.ts): a RESTART replaces the ledger and forgets the session; a relaunch of
 * a dead engine process keeps the ledger and bumps its epoch; a completed turn records what it read.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callRunner, decideCodingAction } = vi.hoisted(() => ({ callRunner: vi.fn(), decideCodingAction: vi.fn() }));
vi.mock("../../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/runner-client.js")>("../../lib/runner-client.js");
	const conn = { kind: "relay", instanceId: "i1", runnerNode: "n1", relayName: "i1:node:n1" };
	return {
		...actual,
		callRunner: (...a: unknown[]) => callRunner(...a),
		getRunnerConnIgnoringLiveness: async () => conn,
		getBoundRunnerConn: async () => conn,
		relayConnected: async () => true,
	};
});
vi.mock("../../lib/coding-loop.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/coding-loop.js")>("../../lib/coding-loop.js");
	return { ...actual, decideCodingAction: (...a: unknown[]) => decideCodingAction(...a) };
});

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { runCodingSessionWorkflow } from "./workflow-run.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import type { CodingDecision, CodingGoal } from "../../lib/coding-loop.js";
import { RunnerUnreachableError } from "../../lib/runner-unreachable.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import type { Env } from "../../types.js";

type Journal = Map<string, unknown>;
function fakeStep(journal: Journal): WorkflowStep {
	return {
		async do(name: string, a: unknown, b?: unknown) {
			const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
			if (journal.has(name)) return journal.get(name);
			const value = await cb();
			journal.set(name, value);
			return value;
		},
		async sleep() {},
	} as unknown as WorkflowStep;
}

const IN_SYNC = { checked: true, branch: "main", upstream: "origin/main", localHead: "aaaaaaaa1", remoteHead: "aaaaaaaa1", ahead: 0, behind: 0, fetched: true };
const ABSENT = new Error('Runner /coding/capture → 500: {"error":"No coding session: s1"}');

let d1: RealSchemaD1;
let env: Env;
let decisions: CodingDecision[];

/**
 * The machine. `executed` is what ran on ANY engine, in order — the evidence that nothing ran twice.
 * `restartDuringTurn`: the next capture while a turn is in flight restarts the runner, answering as `how` says.
 */
let m: {
	ledger: string;
	epoch: number;
	accepted: Array<[string, string, number]>;
	reads: Array<[string, number]>;
	session: boolean;
	alive: boolean;
	pending: string | null;
	starts: number;
	restarts: number;
	executed: Array<{ id: string; text: string }>;
	restartDuringTurn: Array<"disconnect" | "absent" | "process">;
	afterRestart: () => void;
	finishTurns: boolean;
};

/** The runner's content digest (input-ledger.ts `actDigest`), re-derived from the contract as scope-evidence.test.ts does. */
const digestOf = (a: { text?: unknown; author?: unknown; objective?: { runId?: unknown; text?: unknown; origin?: { kind?: unknown; by?: unknown }; constraints?: unknown[] } }) => {
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	const o = a.objective;
	const objective = o ? [str(o.runId), str(o.text), str(o.origin?.kind), str(o.origin?.by), (o.constraints ?? []).filter((c) => typeof c === "string")] : null;
	return createHash("sha256").update(JSON.stringify([str(a.text), str(a.author), objective])).digest("hex");
};
const engine = () => ({ ledger: m.ledger, epoch: m.epoch, accepted: m.accepted.slice(-16), consumed: m.reads.slice(-16) });
const pane = () => ({ pane: "$ ", runState: m.pending ? "thinking" : "idle", ready: !m.pending, alive: m.alive, acceptedInputs: m.accepted.map(([id]) => id), consumedInputs: m.reads.map(([id]) => id), engine: engine() });

function restart(how: "disconnect" | "absent" | "process") {
	m.restarts++;
	m.pending = null;
	if (how === "process") {
		m.alive = false; // the engine process died; the runner and its ledger survive
	} else {
		m.ledger = `L${m.restarts + 1}`;
		m.epoch = 0;
		m.accepted = [];
		m.reads = [];
		m.session = false;
	}
	m.afterRestart();
}

function machine() {
	return {
		"/coding/start": () => {
			m.starts++;
			if (!m.session) m.session = true;
			else if (!m.alive) m.epoch++; // a relaunched process: same ledger, new epoch
			m.alive = true;
			return { ok: true, sessionId: "s1", ...pane() };
		},
		"/coding/capture": () => {
			if (!m.session) throw ABSENT;
			if (m.pending && m.restartDuringTurn.length) {
				const how = m.restartDuringTurn.shift() as "disconnect" | "absent" | "process";
				restart(how);
				// A died engine process is noticed when the relay drops with it; the reconnect relaunches it.
				if (how === "disconnect" || how === "process") throw new RunnerUnreachableError("No runner connected", { dispatched: true });
				if (how === "absent") throw ABSENT;
			}
			if (m.pending && m.finishTurns) {
				m.reads.push([m.pending, m.epoch]);
				m.pending = null;
			}
			return pane();
		},
		"/coding/act": (body: Record<string, unknown>) => {
			if (!m.session) throw new Error('Runner /coding/act → 500: {"error":"No coding session: s1"}');
			const a = body.action as { text: string; inputId?: string };
			const id = a.inputId ?? "";
			if (m.accepted.some(([x]) => x === id)) return { ...pane(), duplicateInput: id };
			m.accepted.push([id, digestOf(a), m.epoch]);
			m.executed.push({ id, text: a.text });
			m.pending = id;
			return pane();
		},
		"/coding/git": () => ({ output: "## main...origin/main\n" }),
		"/coding/sync": () => IN_SYNC,
		"/coding/end": () => ({ ok: true }),
	} as Record<string, (body: Record<string, unknown>) => unknown>;
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'acme/widget', '/w/widget', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-1', 'u1', 'i1', 'ship it', 'running', 10, ${Date.now()}, 's1')`);
	env = { DB: d1.DB } as unknown as Env;
	m = { ledger: "L1", epoch: 0, accepted: [], reads: [], session: false, alive: true, pending: null, starts: 0, restarts: 0, executed: [], restartDuringTurn: [], afterRestart: () => {}, finishTurns: true };
	const routes = machine();
	callRunner.mockReset();
	callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => routes[path]?.(body) ?? {});
	decideCodingAction.mockReset();
	decideCodingAction.mockImplementation(async () => (decisions.length > 1 ? decisions.shift() : decisions[0]));
});
afterEach(() => d1.close());

const params = (goal: Partial<CodingGoal> = {}): CodingSessionParams =>
	({ instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1", runnerNode: "n1", loopRunId: "run-1", goal: { objective: "ship the export feature", repo: "acme/widget", clientType: "claude", ...goal } }) as CodingSessionParams;
const run = (journal: Journal = new Map()) => runCodingSessionWorkflow(env, { payload: params() } as WorkflowEvent<CodingSessionParams>, fakeStep(journal));
const SEND = (text: string): CodingDecision => ({ action: { kind: "message", text } });
const FINISH = (detail: string): CodingDecision => ({ finish: { status: "done", detail } });
const recoveries = () =>
	(d1.sqlite.prepare("SELECT message, context FROM agent_events WHERE event = 'coding.run.turn_recovery' ORDER BY rowid").all() as Array<{ message: string; context: string }>).map((r) => ({ message: r.message, ...(JSON.parse(r.context) as Record<string, unknown>) }) as Record<string, unknown> & { message: string });
const loopRun = () => d1.sqlite.prepare("SELECT status, stop_reason AS stopReason, detail, finished_at AS finishedAt FROM agent_loop_runs WHERE run_id = 'run-1'").get() as { status: string; stopReason: string | null; detail: string | null; finishedAt: number | null };
const timeline = () => (d1.sqlite.prepare("SELECT content FROM coding_timeline WHERE session_id = 's1' ORDER BY seq").all() as Array<{ content: string }>).map((r) => r.content).join("\n");

describe("a runner restart during an in-flight turn", () => {
	it.each(["disconnect", "absent"] as const)("resumes the lost turn exactly once on the relaunched engine (restart seen as %s)", async (how) => {
		m.restartDuringTurn = [how];
		decisions = [SEND("implement the exporter"), FINISH("exporter shipped")];
		const result = await run();
		// The instruction ran once on the lost engine, and once more only as the recovery — under its own id.
		expect(m.executed.map((e) => e.id)).toEqual([expect.stringMatching(/^act:.*-act$/), expect.stringMatching(/^act:.*-act:recover$/)]);
		// The recovery asks what took effect; it never carries the command again.
		expect(m.executed[1].text).toMatch(/previous turn \(act:.*-act\) was cut off[\s\S]*Do not redo it/);
		expect(m.executed[1].text).not.toContain("implement the exporter");
		expect(m.restarts).toBe(1);
		expect(result.outcome).toBe("done");
		const [r] = recoveries();
		expect(recoveries()).toHaveLength(1);
		expect(r).toMatchObject({
			runId: "run-1",
			sessionId: "s1",
			turnInputId: m.executed[0].id,
			recoveryInputId: m.executed[1].id,
			decision: "resume",
			reason: "engine_replaced",
			restarted: true,
			before: { ledger: "L1", epoch: 0, node: "n1" },
			after: { ledger: "L2", epoch: 0, node: "n1", alive: true },
			sentAt: expect.any(String),
			detectedAt: expect.any(String),
			safeAction: expect.stringMatching(/ONE recovery turn/),
		});
		expect(timeline()).toMatch(/Lost engine turn recovered/);
		expect(loopRun()).toMatchObject({ status: "completed", stopReason: "done" });
	});

	it("restart during the in-flight /coding/act call itself: the act is not re-sent, the turn is recovered once", async () => {
		// The act reaches the old engine, then the runner restarts before replying.
		const routes = machine();
		const act = routes["/coding/act"];
		let first = true;
		routes["/coding/act"] = (body) => {
			const out = act(body);
			if (first) {
				first = false;
				restart("disconnect");
				throw new RunnerUnreachableError("Runner disconnected", { dispatched: true });
			}
			return out;
		};
		callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => routes[path]?.(body) ?? {});
		decisions = [SEND("migrate the schema"), FINISH("migrated")];
		const result = await run();
		// Never the same instruction twice under its own id: the lost reply is `unknown`, and only the recovery follows.
		expect(m.executed.map((e) => e.text.startsWith("[platform]") ? "recovery" : e.text)).toEqual(["migrate the schema", "recovery"]);
		expect(recoveries().map((r) => [r.decision, r.receipt])).toEqual([["resume", "unknown"]]);
		expect(result.outcome).toBe("done");
	});

	it("the engine survives and only the controller lost sight of the turn: nothing is resent and nothing is recorded", async () => {
		// The relay drops mid-turn but the runner process — and its ledger and engine — live on.
		const routes = machine();
		const capture = routes["/coding/capture"];
		let dropped = false;
		routes["/coding/capture"] = (body) => {
			if (m.pending && !dropped) {
				dropped = true;
				throw new RunnerUnreachableError("No runner connected", { dispatched: true });
			}
			return capture(body);
		};
		callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => routes[path]?.(body) ?? {});
		decisions = [SEND("write the docs"), FINISH("docs written")];
		const result = await run();
		expect(m.executed.map((e) => e.text)).toEqual(["write the docs"]);
		expect(recoveries()).toEqual([]);
		expect(result.outcome).toBe("done");
	});

	it("the engine process died with the relay and was relaunched on the same runner: a new epoch of the same ledger is also a lost turn", async () => {
		m.restartDuringTurn = ["process"];
		decisions = [SEND("refactor the parser"), FINISH("refactored")];
		await run();
		expect(m.executed).toHaveLength(2);
		expect(recoveries()).toMatchObject([{ decision: "resume", restarted: false, before: { ledger: "L1", epoch: 0 }, after: { ledger: "L1", epoch: 1 } }]);
	});
});

describe("a lost turn that cannot be resumed ends the run turn_lost and releases its lock", () => {
	it("absent engine: the relaunch brings no engine up — nothing is re-sent, the run is blocked on the owner", async () => {
		m.restartDuringTurn = ["absent"];
		m.afterRestart = () => {
			// The relaunch recreates the session, but its engine never comes up.
			const start = machine()["/coding/start"];
			callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => {
				if (path === "/coding/start") {
					start(body);
					m.alive = false;
					return { ok: true, sessionId: "s1", ...pane() };
				}
				return machine()[path]?.(body) ?? {};
			});
		};
		decisions = [SEND("bump the version"), FINISH("never reached")];
		const result = await run();
		expect(m.executed.map((e) => e.text)).toEqual(["bump the version"]);
		expect(recoveries().map((r) => [r.decision, r.reason])).toEqual([["block", "engine_absent"]]);
		expect(result.outcome).toBe("failed");
		const row = loopRun();
		expect(row).toMatchObject({ status: "needs_human", stopReason: "turn_lost" });
		expect(row.finishedAt).toBeTruthy(); // closed: the repo's run lock is released
		expect(row.detail).toMatch(/Lost engine turn[\s\S]*engine absent[\s\S]*Next: Bring the runner back/);
	});

	it("the recovery turn is lost too: never a second resume", async () => {
		m.restartDuringTurn = ["disconnect", "disconnect"];
		decisions = [SEND("deploy the worker"), FINISH("never reached")];
		const result = await run();
		expect(m.executed).toHaveLength(2); // the turn, and its one recovery — nothing more
		expect(recoveries().map((r) => [r.decision, r.reason])).toEqual([
			["resume", "engine_replaced"],
			["block", "recovery_lost"],
		]);
		expect(result.outcome).toBe("failed");
		expect(loopRun()).toMatchObject({ status: "needs_human", stopReason: "turn_lost" });
	});

	it("never relaunches a session the owner ended: the runner's 'no such session' is a genuine failure then", async () => {
		m.restartDuringTurn = ["absent"];
		m.afterRestart = () => d1.exec("UPDATE coding_sessions SET status = 'ended' WHERE id = 's1'");
		decisions = [SEND("clean up"), FINISH("never reached")];
		await run();
		expect(m.starts).toBe(1); // the run's own start only
		expect(m.executed).toHaveLength(1);
		expect(recoveries()).toEqual([]);
	});
});

describe("retry and replay", () => {
	it("a replay of the whole run from its journal sends nothing again and records nothing again", async () => {
		m.restartDuringTurn = ["disconnect"];
		decisions = [SEND("implement the exporter"), FINISH("exporter shipped")];
		const journal: Journal = new Map();
		await run(journal);
		const sent = m.executed.length;
		decisions = [SEND("implement the exporter"), FINISH("exporter shipped")];
		await run(journal);
		expect(m.executed).toHaveLength(sent);
		expect(recoveries()).toHaveLength(1);
	});

	it("a recovery whose reply is lost is reconciled from the ledger, not run twice", async () => {
		m.restartDuringTurn = ["disconnect"];
		const routes = machine();
		const act = routes["/coding/act"];
		let recoveryReplyLost = false;
		routes["/coding/act"] = (body) => {
			const out = act(body);
			const id = String((body.action as { inputId?: string }).inputId);
			if (id.endsWith(":recover") && !recoveryReplyLost) {
				recoveryReplyLost = true;
				throw new RunnerUnreachableError("Runner disconnected", { dispatched: true });
			}
			return out;
		};
		callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => routes[path]?.(body) ?? {});
		decisions = [SEND("implement the exporter"), FINISH("exporter shipped")];
		const result = await run();
		expect(m.executed.filter((e) => e.id.endsWith(":recover"))).toHaveLength(1);
		expect(result.outcome).toBe("done");
	});
});
