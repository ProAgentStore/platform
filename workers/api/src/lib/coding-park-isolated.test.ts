/**
 * #1717 — the park-resume relaunch makes the same isolation check a fresh open makes (#1714).
 *
 * An isolated repository whose runner brings the engine back WITHOUT a worktree (an older runner ignores `strategy`) must not resume in
 * the shared checkout: the engine is ended and the resume is blocked, in words. A repository with no stored strategy resumes as always.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { resumeFromPark } from "./coding-park.js";
import type { RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
let commands: Array<{ path: string; body: Record<string, unknown> }>;
let startAnswer: Record<string, unknown>;

const connFor = (): RunnerConn => ({ env, instanceId: "i1", relayName: "i1:node:laptop", runnerNode: "laptop" }) as unknown as RunnerConn;
const scope = { runId: "run-1", instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1" };
const input = { ...scope, repoName: "acme/app", parkedForMs: 60_000, clientType: "claude" };

function setup(strategy: string | null) {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, branch, strategy) VALUES ('r1', 'i1', 'u1', 'acme/app', '~/dev/app', 'main', ${strategy ? `'${strategy}'` : "NULL"})`);
	commands = [];
	const RELAY = {
		idFromName: (n: string) => n,
		get: () => ({
			fetch: async (req: Request) => {
				const url = new URL(req.url);
				if (url.pathname === "/status") return Response.json({ connected: true });
				const cmd = (await req.json()) as { path: string; body: Record<string, unknown> };
				commands.push({ path: cmd.path, body: cmd.body ?? {} });
				if (cmd.path === "/coding/start") return Response.json(startAnswer);
				return Response.json({});
			},
		}),
	};
	env = { DB: d1.DB, RELAY, CODING_SESSION: { get: async () => ({ status: async () => ({ status: "waiting" }), sendEvent: async () => undefined }) } } as unknown as Env;
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, runner_node) VALUES ('s1', 'i1', 'r1', 'u1', 'suspended', 'claude', 'laptop')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, waiting_reason, parked_since, workflow_instance_id, checkout_released_at)
	  VALUES ('run-1', 'u1', 'i1', 'x', 'running', 15, ${Date.now()}, 's1', 'decision', ${Date.now()}, 'wf-1', ${Date.now()})`);
}

afterEach(() => d1.close());

describe("resume of an isolated repository (#1717)", () => {
	beforeEach(() => {
		startAnswer = { sessionId: "s1", resumed: true };
	});

	it("a runner that did not isolate: the resume is blocked, the engine is ended, nothing else is asked", async () => {
		setup("isolated-pr");
		const r = await resumeFromPark(env, connFor(), input);
		expect(r).toEqual({ blocked: expect.stringMatching(/set to isolated-pr, but the runner on laptop did not report an isolated worktree/) });
		expect(commands.map((c) => c.path)).toContain("/coding/end");
		expect(commands.map((c) => c.path)).not.toContain("/coding/park-restore");
	});

	it("a runner that isolated: the resume goes ahead", async () => {
		setup("isolated-direct");
		startAnswer = { sessionId: "s1", resumed: true, checkout: { mode: "worktree", path: "/w/run" } };
		const r = await resumeFromPark(env, connFor(), input);
		expect(JSON.stringify(r)).not.toMatch(/isolated worktree/); // past the isolation check (the later re-sync gate has no runner answers here)
		expect(commands.map((c) => c.path)).not.toContain("/coding/end");
	});

	it("no stored strategy: resumes exactly as today, whatever the runner answers", async () => {
		setup(null);
		const r = await resumeFromPark(env, connFor(), input);
		expect(JSON.stringify(r)).not.toMatch(/isolated worktree/); // past the isolation check (the later re-sync gate has no runner answers here)
		expect(commands.map((c) => c.path)).not.toContain("/coding/end");
	});
});
