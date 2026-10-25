/**
 * #1242 — a parked run resumes on the machine it parked on, and nowhere else.
 *
 * Run d12e99fa parked on pink-laptop; its Workflow woke a day later, re-resolved the machine from the
 * instance pin (Mac.modem), and asked a checkout that had never had the commit to put it back. These
 * drive the real resume over the real schema; only the relay is faked, and it records WHICH machine
 * each runner command was addressed to — the whole question.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { getLoopRun } from "./agent-loop-store.js";
import { recordAnswer } from "./coder-question-store.js";
import { PARK_WAKE_BACKSTOP_MS, putBackWork, recordParkMachine, resumeFromPark, runDueParkWakes, wakeRunsParkedOnMachine } from "./coding-park.js";
import type { RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

const DAY = 86_400_000;
const PINK = "e4fdf96a-0ebc-4dd6-bbd1-1f3a4b69599e";
const RL = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
const SNAP = "7cf586197ba4f9be0ab07e3196cb4eae18687970";
let d1: RealSchemaD1;
let env: Env;
let live: Set<string>;
let commands: Array<{ relay: string; path: string; body: Record<string, unknown> }>;
let restoreAnswer: Record<string, unknown>;
let sent: string[];

const relayName = (node: string) => `i1:node:${node}`;
const conn = (node: string): RunnerConn => ({ env, instanceId: "i1", relayName: relayName(node), runnerNode: node }) as unknown as RunnerConn;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir) VALUES ('r1', 'i1', 'u1', 'proappstore-online/tradeport', '~/dev/stores/pas/apps/tradeport')`);
	const reg = (node: string, machine: string, seen: string) =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, machine_id, last_seen_at) VALUES ('i1', 'u1', '${node}', 'relay://', 'tok', '${machine}', ${seen})`);
	reg("pink-laptop", PINK, "datetime('now')");
	reg("Mac.modem", RL, "datetime('now')");
	live = new Set();
	commands = [];
	restoreAnswer = { restored: true };
	sent = [];
	const RELAY = {
		idFromName: (n: string) => n,
		get: (name: string) => ({
			fetch: async (req: Request) => {
				const url = new URL(req.url);
				if (url.pathname === "/status") return Response.json({ connected: live.has(name) });
				const cmd = (await req.json()) as { path: string; body: Record<string, unknown> };
				commands.push({ relay: name, path: cmd.path, body: cmd.body ?? {} });
				if (!live.has(name)) return new Response("no socket", { status: 503 });
				if (cmd.path === "/coding/park-restore") return Response.json(restoreAnswer);
				if (cmd.path === "/coding/start") return Response.json({ sessionId: "s1", resumed: true });
				return Response.json({});
			},
		}),
	};
	const CODING_SESSION = { get: async (wf: string) => ({ status: async () => ({ status: "waiting" }), sendEvent: async () => void sent.push(wf) }) };
	env = { DB: d1.DB, RELAY, CODING_SESSION } as unknown as Env;
	// Run d12e99fa's shape: parked on a question, its checkout released and its work set aside.
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, runner_node) VALUES ('s1', 'i1', 'r1', 'u1', 'suspended', 'claude', 'pink-laptop')`);
	const at = Date.now() - 3 * DAY;
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, waiting_reason, parked_since, workflow_instance_id, checkout_released_at, checkout_snapshot)
	  VALUES ('run-1', 'u1', 'i1', 'x', 'running', 15, ${at}, 's1', 'decision', ${at}, 'wf-1', ${at}, '${SNAP}')`);
	d1.exec(`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, question, state, asked_at, expires_at) VALUES ('q1', 'i1', 'u1', 's1', 'run-1', 'csess-s1', 'E2E_SESSION_TOKEN?', 'waiting_human', ${at}, ${at + 60_000})`);
});
afterEach(() => d1.close());

const scope = { runId: "run-1", instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1" };
const resumeInput = { ...scope, repoName: "proappstore-online/tradeport", parkedForMs: 3 * DAY, clientType: "claude" };
const runRow = () => d1.sqlite.prepare("SELECT parked_machine_id, parked_node, parked_workdir, checkout_released_at, checkout_snapshot FROM agent_loop_runs WHERE run_id = 'run-1'").get() as Record<string, unknown>;
const sessionRow = () => d1.sqlite.prepare("SELECT status, runner_node FROM coding_sessions WHERE id = 's1'").get() as { status: string; runner_node: string };

describe("recording where a run parked (#1242)", () => {
	it("records the machine's stable id, the hostname it answered to, and the checkout", async () => {
		await recordParkMachine(env, scope, conn("pink-laptop"));
		expect(runRow()).toMatchObject({ parked_machine_id: PINK, parked_node: "pink-laptop", parked_workdir: "~/dev/stores/pas/apps/tradeport" });
	});
});

describe("park on X, resume on Y (#1242)", () => {
	beforeEach(async () => {
		await recordParkMachine(env, scope, conn("pink-laptop"));
	});

	it("woken on Mac.modem while pink-laptop is away: it WAITS for pink-laptop — nothing taken back, nothing asked of either machine", async () => {
		live.add(relayName("Mac.modem"));
		const r = await resumeFromPark(env, conn("Mac.modem"), resumeInput);
		expect(r).toEqual({ busy: expect.stringMatching(/the machine it parked on \(pink-laptop\) is not connected — it resumes there, and only there/) });
		expect(commands).toEqual([]);
		expect(runRow()).toMatchObject({ checkout_snapshot: SNAP });
		expect(sessionRow().status).toBe("suspended");
	});

	it("with pink-laptop back, every runner command of the resume goes to pink-laptop — never to the machine the Workflow re-resolved", async () => {
		live.add(relayName("Mac.modem"));
		live.add(relayName("pink-laptop"));
		await resumeFromPark(env, conn("Mac.modem"), resumeInput);
		expect(commands.length).toBeGreaterThan(0);
		expect(new Set(commands.map((c) => c.relay))).toEqual(new Set([relayName("pink-laptop")]));
		expect(sessionRow().runner_node).toBe("pink-laptop");
	});

	it("a hostname change is the same machine: the resume finds pink-laptop under its new name", async () => {
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, machine_id, last_seen_at) VALUES ('i1', 'u1', 'pink-laptop.modem', 'relay://', 'tok', '${PINK}', datetime('now'))`);
		live.add(relayName("pink-laptop.modem"));
		await resumeFromPark(env, conn("Mac.modem"), resumeInput);
		expect(new Set(commands.map((c) => c.relay))).toEqual(new Set([relayName("pink-laptop.modem")]));
	});
});

describe("runner restart, a multi-day park, an answer while busy (#1242)", () => {
	beforeEach(async () => {
		await recordParkMachine(env, scope, conn("pink-laptop"));
	});

	it("runner restart: the parking machine reconnects and its registration wakes the answered run", async () => {
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "Commit the spec as is", via: "mcp" });
		expect(await wakeRunsParkedOnMachine(env, "u1", RL)).toBe(0); // another machine coming back wakes nothing
		expect(await wakeRunsParkedOnMachine(env, "u1", PINK)).toBe(1);
		live.add(relayName("pink-laptop"));
		// The put-back half of the resume (its re-sync onto upstream is #1078's, covered in workflow-run.test.ts).
		expect(await putBackWork(env, conn("pink-laptop"), scope, SNAP)).toEqual({ ok: true });
		expect(commands.find((c) => c.path === "/coding/park-restore")).toMatchObject({ relay: relayName("pink-laptop"), body: { runId: "run-1", snapshot: SNAP } });
		expect(runRow()).toMatchObject({ checkout_snapshot: null, checkout_released_at: null });
		expect(commands.find((c) => c.path === "/coding/park-restore")?.body.fetch).toBeUndefined(); // on its own machine, origin is never asked
	});

	it("multi-day park: while its machine is quiet the minute backstop leaves it alone; once it heartbeats again, it is woken", async () => {
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "go", via: "mcp", now: Date.now() - 2 * PARK_WAKE_BACKSTOP_MS });
		d1.exec("UPDATE instance_runtime_nodes SET last_seen_at = datetime('now', '-3 days') WHERE machine_id = '" + PINK + "'");
		expect(await runDueParkWakes(env)).toBe(0);
		d1.exec("UPDATE instance_runtime_nodes SET last_seen_at = datetime('now') WHERE machine_id = '" + PINK + "'");
		expect(await runDueParkWakes(env)).toBe(1);
	});

	it("answer while the repo is busy: it waits for the holder, on its own machine, and restores nothing yet", async () => {
		live.add(relayName("pink-laptop"));
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s2', 'i1', 'r1', 'u1', 'active', 'claude')");
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-2', 'u1', 'i1', 'y', 'running', 10, ${Date.now()}, 's2')`);
		const r = await resumeFromPark(env, conn("pink-laptop"), resumeInput);
		expect(r).toMatchObject({ busy: expect.stringMatching(/(being worked by run|being driven on session|open \w+ session|held by a direct)/) });
		expect(commands.some((c) => c.path === "/coding/park-restore")).toBe(false);
		expect(runRow()).toMatchObject({ checkout_snapshot: SNAP });
	});
});

describe("never 'still set aside' without the object (#1242)", () => {
	it("work missing from the checkout is reported as where it WAS set aside, and whether origin has a copy", async () => {
		await recordParkMachine(env, scope, conn("pink-laptop"));
		d1.exec("UPDATE agent_loop_runs SET parked_pushed = 1 WHERE run_id = 'run-1'");
		live.add(relayName("Mac.modem"));
		restoreAnswer = { restored: false, missing: true, refused: `the saved work (${SNAP}) is not in this machine's checkout` };
		const r = await putBackWork(env, conn("Mac.modem"), scope, SNAP);
		expect("blocked" in r && r.blocked).toMatch(new RegExp(`set aside as ${SNAP} on pink-laptop, and a copy is on origin as \`refs/pags/parked/run-1\``));
		expect("blocked" in r && r.blocked).not.toMatch(/still set aside/);
		expect(runRow()).toMatchObject({ checkout_snapshot: SNAP }); // kept for the continue that moves it
	});

	it("coding_loop_status says where the parked work is: machine, hostname, checkout, commit, and whether origin has it", async () => {
		await recordParkMachine(env, scope, conn("pink-laptop"));
		d1.exec("UPDATE agent_loop_runs SET parked_pushed = 0 WHERE run_id = 'run-1'");
		expect((await getLoopRun(env, "u1", "run-1"))?.parked).toEqual({ machineId: PINK, node: "pink-laptop", workdir: "~/dev/stores/pas/apps/tradeport", snapshot: SNAP, ref: "refs/pags/parked/run-1", pushedToOrigin: false });
	});
});
