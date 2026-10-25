/**
 * #1359 — every durable step name the coding Workflow emits, recorded as GOLDENS.
 *
 * A Workflow journals each `step.do` / `step.sleep` / `step.waitForEvent` by name and replays by name, and a run parked on a
 * question can wait 30 days. The code deployed while it waits must therefore emit exactly the names the old code did, in the
 * same order, or its replay diverges from its journal. These snapshots were taken from `workflow-run.ts` BEFORE the retry
 * presets, the runner guard, the capture and the pause effects were moved out of it; the move had to reproduce them.
 *
 * If a snapshot here must change, the change is a replay break for every run in flight: version the names instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callRunner, decideCodingAction, relay } = vi.hoisted(() => ({ callRunner: vi.fn(), decideCodingAction: vi.fn(), relay: { downProbes: 0 } }));
vi.mock("../../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/runner-client.js")>("../../lib/runner-client.js");
	const conn = { kind: "relay", instanceId: "i1", runnerNode: "n1", relayName: "i1:node:n1" };
	// The relay is down for the next `downProbes` reads of the bound connection, then back.
	const bound = async () => {
		if (relay.downProbes > 0) {
			relay.downProbes--;
			return null;
		}
		return conn;
	};
	return { ...actual, callRunner: (...a: unknown[]) => callRunner(...a), getRunnerConnIgnoringLiveness: async () => conn, getBoundRunnerConn: bound, relayConnected: async () => true };
});
vi.mock("../../lib/coding-loop.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/coding-loop.js")>("../../lib/coding-loop.js");
	return { ...actual, decideCodingAction: (...a: unknown[]) => decideCodingAction(...a) };
});

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { runCodingSessionWorkflow } from "./workflow-run.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import type { CodingDecision, CodingGoal } from "../../lib/coding-loop.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import { recordAnswer } from "../../lib/coder-question-store.js";
import { RunnerUnreachableError } from "../../lib/runner-unreachable.js";
import type { Env } from "../../types.js";

interface Journal {
	done: Map<string, unknown>;
	order: string[];
	sleeps: { name: string; ms: number }[];
	events: { name: string; type: string }[];
	onEvent?: (name: string) => Promise<unknown>;
}

function fakeStep(journal: Journal): WorkflowStep {
	const step = {
		async do(name: string, a: unknown, b?: unknown) {
			const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
			if (journal.done.has(name)) return journal.done.get(name);
			journal.order.push(name);
			const value = await cb();
			journal.done.set(name, value);
			return value;
		},
		async sleep(name: string, ms: number) {
			journal.sleeps.push({ name, ms });
		},
		async waitForEvent(name: string, opts: { type: string }) {
			if (journal.done.has(name)) return journal.done.get(name);
			journal.events.push({ name, type: opts.type.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "<question-id>") });
			await journal.onEvent?.(name);
			const ev = { payload: {}, timestamp: new Date(), type: opts.type };
			journal.done.set(name, ev);
			return ev;
		},
	};
	return step as unknown as WorkflowStep;
}

const IDLE = { pane: "$ ", runState: "idle", ready: true, alive: true };
const IN_SYNC = { checked: true, branch: "main", upstream: "origin/main", localHead: "aaaaaaaa1", remoteHead: "aaaaaaaa1", ahead: 0, behind: 0, fetched: true };
let runner: Record<string, (body: Record<string, unknown>) => unknown>;
let decisions: CodingDecision[];
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/w/repo', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-1', 'u1', 'i1', 'make the tests pass', 'running', 10, ${Date.now()}, 's1')`);
	env = { DB: d1.DB } as unknown as Env;
	relay.downProbes = 0;
	runner = {
		"/coding/start": () => ({ ok: true, sessionId: "s1" }),
		"/coding/capture": () => IDLE,
		"/coding/act": () => IDLE,
		"/coding/git": () => ({ output: "## main...origin/main\n" }),
		"/coding/sync": () => IN_SYNC,
		"/coding/takeover-status": () => ({ resolved: false }),
	};
	callRunner.mockReset();
	callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => runner[path]?.(body) ?? {});
	decisions = [{ finish: { status: "done", detail: "all green" } }];
	decideCodingAction.mockReset();
	decideCodingAction.mockImplementation(async () => (decisions.length > 1 ? decisions.shift() : decisions[0]));
});
afterEach(() => d1.close());

function params(): CodingSessionParams {
	return { instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1", runnerNode: "n1", loopRunId: "run-1", goal: { objective: "make the tests pass", repo: "owner/repo", clientType: "claude" } as CodingGoal } as CodingSessionParams;
}

/** The ordered names the run emitted: durable steps, then sleeps and event waits, each on its own line. */
async function names(journal: Journal): Promise<string> {
	await runCodingSessionWorkflow(env, { payload: params(), instanceId: "run-1" } as WorkflowEvent<CodingSessionParams>, fakeStep(journal));
	return [...journal.order.map((n) => `do ${n}`), ...journal.sleeps.map((s) => `sleep ${s.name} ${s.ms}`), ...journal.events.map((e) => `waitForEvent ${e.name} ${e.type}`)].join("\n");
}
const fresh = (): Journal => ({ done: new Map(), order: [], sleeps: [], events: [] });

describe("the durable step names the coding Workflow emits are frozen (#1359)", () => {
	it("a plain run that finishes on its first decision", async () => {
		expect(await names(fresh())).toMatchInlineSnapshot(`
			"do run-started-at
			do merge-authority
			do repo-write-scope
			do owner-timezone
			do start
			do repo-state-start
			do repo-self-heal
			do repo-sync-gate
			do resume-note
			do tl-start
			do objective-capabilities
			do objective-unsupported-g0
			do iteration-ceiling
			do s0-snapshot
			do s1-decide
			do repo-state-end
			do repo-sync-end
			do acts-final-drain
			do end
			do notify-end
			do release-notes-plan
			do delegation-run-done
			do objective-queue-drain
			do idle-coder-wake"
		`);
	});

	it("a run that two turns in meets a runner disconnect: the guard waits for the relay, relaunches the engine and goes on", async () => {
		decisions = [{ action: { kind: "message", text: "run the tests" } }, { finish: { status: "done", detail: "ok" } }];
		let captures = 0;
		runner["/coding/capture"] = () => {
			if (++captures === 3) {
				relay.downProbes = 2;
				throw new RunnerUnreachableError("Runner disconnected", { dispatched: true });
			}
			return IDLE;
		};
		expect(await names(fresh())).toMatchInlineSnapshot(`
			"do run-started-at
			do merge-authority
			do repo-write-scope
			do owner-timezone
			do start
			do repo-state-start
			do repo-self-heal
			do repo-sync-gate
			do resume-note
			do tl-start
			do objective-capabilities
			do objective-unsupported-g0
			do iteration-ceiling
			do s0-snapshot
			do s1-decide
			do s2-event
			do s3-act-constraints
			do s3-act-intent
			do s3-act
			do s4-waitidle-c0
			do s5-snapshot
			do s5-snapshot-w0-q
			do s5-snapshot-w0-t0
			do s5-snapshot-w0-w0
			do say-s5-snapshot-w0-n
			do s5-snapshot-w0-k0
			do s5-snapshot-w0-q0
			do s5-snapshot-w0-k1
			do s5-snapshot-w0-q1
			do s5-snapshot-w0-w1
			do say-s5-snapshot-w0-back
			do restart-s5-snapshot-rc0
			do objective-capabilities-s5-snapshot-rc0
			do objective-unsupported-g1
			do s5-snapshot-r1
			do s6-decide
			do repo-state-end
			do repo-sync-end
			do acts-final-drain
			do end
			do notify-end
			do release-notes-plan
			do delegation-run-done
			do objective-queue-drain
			do idle-coder-wake
			sleep s4-waitidle-z0 1500
			sleep s5-snapshot-w0-p0 15 seconds
			sleep s5-snapshot-w0-p1 15 seconds"
		`);
	});

	it("a run that asks the owner a question parks on it, and the answer resumes the same run", async () => {
		decisions = [{ needsInput: { field: "Keep the old API or drop it?", why: "breaking change", options: ["keep it", "drop it"] } }, { finish: { status: "done", detail: "ok" } }];
		const journal = fresh();
		journal.onEvent = async () => {
			await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "drop it", via: "console" });
		};
		expect(await names(journal)).toMatchInlineSnapshot(`
			"do run-started-at
			do merge-authority
			do repo-write-scope
			do owner-timezone
			do start
			do repo-state-start
			do repo-self-heal
			do repo-sync-gate
			do resume-note
			do tl-start
			do objective-capabilities
			do objective-unsupported-g0
			do iteration-ceiling
			do s0-snapshot
			do s1-decide
			do handoff-0
			do ask-0
			do notify-coding-handoff:needs_input:0-0
			do park-0
			do hstatus-0-2
			do unpark-0-0
			do applied-0
			do resume-0
			do s3-snapshot
			do s4-decide
			do repo-state-end
			do repo-sync-end
			do acts-final-drain
			do end
			do notify-end
			do release-notes-plan
			do delegation-run-done
			do objective-queue-drain
			do idle-coder-wake
			waitForEvent answer-0-0 answer-<question-id>"
		`);
	});
});
