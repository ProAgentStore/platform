/**
 * #1388 — the start-of-run sync gate, against a runner that MISSES PONGS.
 *
 * The incident: three queued objectives were dequeued in turn and each failed at iteration 0 with "stopped before it started because the
 * base it would build on could not be confirmed (#801) … Runner relay is connected but not responding [runner-unreachable:UNRESPONSIVE@/coding/sync]".
 * The relay socket existed; the runner had only missed the 1.5 s pong. `readRepoSync` folds that into an `unverified` verdict, and the gate
 * treats an unverified verdict as a reason to stop the run — so a stall that heals on its own ended the run, and its end drained the next
 * entry into the same stall.
 *
 * The REAL `runCodingSessionWorkflow` runs here over the real schema. Faked: the machine (a runner whose `/coding/sync` answers UNRESPONSIVE a
 * set number of times, exactly as `callRunner` raises it, tag and all), the BYOK brain, and the Workflows step journal.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { callRunner, decideCodingAction } = vi.hoisted(() => ({ callRunner: vi.fn(), decideCodingAction: vi.fn() }));
vi.mock("../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/runner-client.js")>("../lib/runner-client.js");
	const conn = { kind: "relay", instanceId: "i1", runnerNode: "n1", relayName: "i1:node:n1" };
	return {
		...actual,
		callRunner: (...a: unknown[]) => callRunner(...a),
		getRunnerConn: async () => conn,
		getRunnerConnIgnoringLiveness: async () => conn,
		getBoundRunnerConn: async () => conn,
		relayConnected: async () => true,
	};
});
vi.mock("../lib/coding-loop.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/coding-loop.js")>("../lib/coding-loop.js");
	return { ...actual, decideCodingAction: (...a: unknown[]) => decideCodingAction(...a) };
});

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getLoopRun } from "../lib/agent-loop-store.js";
import type { CodingDecision } from "../lib/coding-loop.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { RunnerUnreachableError, runnerErrorTag } from "../lib/runner-unreachable.js";
import { runCodingSessionWorkflow } from "../workflows/coding-session/workflow-run.js";
import type { CodingSessionParams } from "../workflows/coding-session-params.js";
import type { Env } from "../types.js";

const IDLE = { pane: "$ ", runState: "idle", ready: true, alive: true };
const IN_SYNC = { checked: true, branch: "main", upstream: "origin/main", localHead: "aaaaaaaa1", remoteHead: "aaaaaaaa1", ahead: 0, behind: 0, fetched: true };
/** What `callRunner` raises when the relay's ping went unanswered — the class, the message and the tag it really builds. */
const MISSED_PONG = () =>
	new RunnerUnreachableError(
		`Runner relay is connected but not responding — its socket is up, but the runner did not answer the relay's ping in time. A busy or reconnecting machine usually recovers on its own.${runnerErrorTag("UNRESPONSIVE", true, "/coding/sync")}`,
		{ code: "UNRESPONSIVE", dispatched: false, path: "/coding/sync" },
	);

let d1: RealSchemaD1;
let env: Env;
let decisions: CodingDecision[];
/** How many `/coding/sync` calls still miss their pong, then it answers. */
let missedPongs: number;
let syncCalls: number;
let sleeps: string[];

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/w/repo', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-1', 'u1', 'i1', 'ship #508', 'running', 10, ${Date.now()}, 's1')`);
	env = { DB: d1.DB, CODING_SESSION: { get: async () => ({ status: async () => ({ status: "running" }), sendEvent: async () => undefined }) } } as unknown as Env;
	missedPongs = 0;
	syncCalls = 0;
	sleeps = [];
	decisions = [{ finish: { status: "done", detail: "objective complete" } }];
	callRunner.mockReset();
	callRunner.mockImplementation(async (_conn: unknown, path: string) => {
		if (path === "/coding/sync") {
			syncCalls++;
			if (missedPongs > 0) {
				missedPongs--;
				throw MISSED_PONG();
			}
			return IN_SYNC;
		}
		if (path === "/coding/git") return { output: "## main...origin/main\n" };
		if (path === "/coding/start") return { ok: true, sessionId: "s1" };
		return IDLE;
	});
	decideCodingAction.mockReset();
	decideCodingAction.mockImplementation(async () => (decisions.length > 1 ? decisions.shift() : decisions[0]));
});
afterEach(() => d1.close());

/** The step journal: a step runs once, `sleep` is recorded and returns at once (a flap of minutes costs the test no time). */
function step(): WorkflowStep {
	const done = new Map<string, unknown>();
	return {
		async do(name: string, a: unknown, b?: unknown) {
			const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
			if (done.has(name)) return done.get(name);
			const v = await cb();
			done.set(name, v);
			return v;
		},
		async sleep(name: string) {
			sleeps.push(name);
		},
		async waitForEvent(_name: string, opts: { type: string }) {
			return { payload: {}, timestamp: new Date(), type: opts.type };
		},
	} as unknown as WorkflowStep;
}

const params = (): CodingSessionParams =>
	({ instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1", runnerNode: "n1", loopRunId: "run-1", goal: { objective: "ship #508", repo: "owner/repo", clientType: "claude" } }) as CodingSessionParams;

const run = () => runCodingSessionWorkflow(env, { payload: params(), instanceId: "wf-run-1" } as unknown as WorkflowEvent<CodingSessionParams>, step());

describe("the sync gate rides out a runner that misses its pong (#1388)", () => {
	it("a runner that answers the sync check: the run starts and finishes, the gate never blocks (unchanged)", async () => {
		const result = await run();
		expect(result).toMatchObject({ outcome: "done" });
		expect(syncCalls).toBe(2); // the start-of-run read, and the advisory one at the run's end
		expect(sleeps.filter((n) => /repo-state-start/.test(n))).toEqual([]);
	});

	it("a runner that misses the pong on the sync check is WAITED FOR, then the same run proceeds — it is not failed at iteration 0", async () => {
		missedPongs = 2;
		const result = await run();
		// The incident's outcome was `failed`, 0 steps, "could not be confirmed". Now the guard waited out the stall and read again.
		expect(result).toMatchObject({ outcome: "done" });
		expect(result).not.toMatchObject({ outcome: "failed" });
		expect(syncCalls).toBe(4); // two missed pongs, the answer, and the advisory read at the run's end
		// …and the wait is the guard's own, named for the step it protects — recorded in the journal, not an invented new step.
		expect(sleeps.some((n) => n.startsWith("repo-state-start-w"))).toBe(true);
		const row = await getLoopRun(env, "u1", "run-1");
		expect(row).toMatchObject({ status: "completed" });
		expect(String(row?.detail ?? "")).not.toMatch(/could not be confirmed|sync check itself failed/);
	});

	it("a structural sync failure still blocks the run at once: a checkout that is not a git repository is not waited for", async () => {
		callRunner.mockImplementation(async (_conn: unknown, path: string) => {
			if (path === "/coding/sync") return { error: "not inside a git working tree" };
			if (path === "/coding/git") return { output: "## main...origin/main\n" };
			return IDLE;
		});
		const result = await run();
		expect(result).toMatchObject({ outcome: "failed" });
		expect(String((result as { detail?: string }).detail)).toMatch(/could not be (checked|confirmed)|up to date/i);
		expect(sleeps.filter((n) => /repo-state-start/.test(n))).toEqual([]); // no wait: nothing about a runner
	});
});
