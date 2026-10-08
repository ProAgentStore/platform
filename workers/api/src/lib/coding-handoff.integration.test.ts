/**
 * The #984 incident, reconstructed on the real schema and refused.
 *
 * ── What is real here
 *
 * The migrated tables (runs, sessions, repos, the objective queue, the board cards), the run
 * sweeper, the objective-queue drain and the coding driver's whole admission path. The only fakes
 * are the two things a test cannot have: the machine on the other end of the relay (a recorded
 * command log, so what was asked of it is assertable — and so is what was NOT) and the Pilot
 * workflow binding.
 *
 * ── The scenario, as it happened
 *
 * A Pilot working issue #978 stops heartbeating. The sweeper closes its run. Its coding session is
 * still `active`, its engine is still executing "finish the Board work, run the gates, commit, push
 * and close #978", and eight of its files are uncommitted. #982 is next in the queue.
 *
 * Before this: the queue drained, #982 got a run row on that session, and the durable record said
 * #982 while the CLI was doing #978. Every test below is one way back to that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { loopDriverFor } from "./loop-drivers.js";
import { tryDequeueAndStart } from "./objective-queue-start.js";
import { sweepStaleRuns } from "./run-sweeper.js";
import { STALE_DRIVER_MS } from "./coding-store.js";
import { storedHandoff } from "./coding-handoff-store.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { Env } from "../types.js";

const CODING = { surfaces: [], runtime: "pags", workflow: "CODING_SESSION", tools: undefined } as unknown as AgentCapabilities;
const HOUR = 60 * 60_000;

let d1: RealSchemaD1;
let env: Env;
/** Every command the cloud sent to the machine, in order. */
let commands: Array<{ path?: string; body?: Record<string, unknown> }>;
/** Every Pilot workflow the driver created — the proof a run did or did not begin. */
let pilots: Array<Record<string, unknown>>;
let machine: { alive: boolean; gitStatus: string | null };

function makeEnv() {
	return {
		DB: d1.DB,
		RELAY: {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					if (new URL(req.url).pathname === "/status") return new Response(JSON.stringify({ connected: true }));
					const cmd = (await req.json().catch(() => ({}))) as { path?: string; body?: Record<string, unknown> };
					commands.push({ path: cmd.path, body: cmd.body });
					if (cmd.path === "/coding/capture") return new Response(JSON.stringify({ sessionId: cmd.body?.sessionId, alive: machine.alive, runState: machine.alive ? "thinking" : "idle", pane: "" }));
					if (cmd.path === "/coding/git") {
						return machine.gitStatus === null
							? new Response("git unavailable", { status: 500 })
							: new Response(JSON.stringify({ output: machine.gitStatus }));
					}
					if (cmd.path === "/coding/engine-check") return new Response(JSON.stringify({ checked: true, state: "signed-in" }));
					if (cmd.path === "/coding/repo-check") return new Response(JSON.stringify({ checked: true, path: "/w/platform", exists: true, isDirectory: true, entryCount: 9, insideWorkTree: true }));
					return new Response(JSON.stringify({ ok: true }));
				},
			}),
		},
		CODING_SESSION: { create: vi.fn(async (o: { params: Record<string, unknown> }) => { pilots.push(o.params); return { id: "wf" }; }) },
		AGENT_LOOP: { create: vi.fn(async () => ({ id: "wf" })) },
	} as unknown as Env;
}

/** A coder with one repo, one active session on issue #978, and a machine connected. */
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	// A DECLARED coding agent (`lib/agent-capabilities.ts`), because the drain resolves the driver
	// from the row rather than being told which one to use — so a seed without this exercises the
	// chat loop and never reaches the gate at all.
	d1.exec(`UPDATE agents SET config = '{"capabilities":{"surfaces":["coding"],"runtime":"pags_browser_runtime","workflow":"CODING_SESSION"}}' WHERE id = 'agent-1'`);
	commands = [];
	pilots = [];
	machine = { alive: false, gitStatus: "## main...origin/main\n" };
	d1.exec(
		`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, default_client, workdir, clone_status)
		 VALUES ('r1', 'coder', 'u1', 'ProAgentStore/platform', 'ProAgentStore/platform', 'claude', '/w/platform', 'ready')`,
	);
	d1.exec(
		`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, token_plaintext, runner_version, status, last_seen_at)
		 VALUES ('coder', 'u1', 'https://runner.local', 't', '0.4.32', 'registered', datetime('now'))`,
	);
	env = makeEnv();
});

afterEach(() => d1.close());

/** The #978 run and the session it drives, with an orchestrator that stopped reporting `agoMs` ago. */
function interruptedRun(agoMs: number, over: { driverAtAgo?: number } = {}) {
	const now = Date.now();
	d1.exec(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, issue_number, issue_title, driver_id, driver_at, last_activity_at)
		 VALUES ('csess-A', 'coder', 'r1', 'u1', 'claude', 'active', 978, 'Board cards', 'pilot-978', ${now - (over.driverAtAgo ?? agoMs)}, ${now - agoMs})`,
	);
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status, iteration, session_id, last_alive_at)
		 VALUES ('run-978', 'u1', 'coder', 'Implement #978: application execution runs on the Board', 12, ${now - agoMs}, 'running', 4, 'csess-A', ${now - agoMs})`,
	);
}

const queue982 = () =>
	d1.exec(
		`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at)
		 VALUES ('objq-982', 'coder', 'r1', 'u1', 'Implement #982: deterministic checkpoint auto-continue', 'pending', ${Date.now()})`,
	);

const rows = async (sql: string) => ((await d1.DB.prepare(sql).all<Record<string, unknown>>()).results ?? []);
const runs = () => rows("SELECT run_id, objective, status, stop_reason, session_id FROM agent_loop_runs ORDER BY started_at");
const claim = () =>
	d1.DB.prepare(
		"SELECT recovery_run_id, recovery_issue, recovery_reason, recovery_state, recovered_by_run_id, recovery_released_at, issue_number FROM coding_sessions WHERE id = 'csess-A'",
	).first<Record<string, unknown>>();
const entry = () => d1.DB.prepare("SELECT status, stop_reason FROM instance_objective_queue WHERE id = 'objq-982'").first<Record<string, unknown>>();
const cards = () => rows("SELECT id, type, status, payload FROM instance_runtime_tasks");
/** Did anything we sent the machine CHANGE the repository? */
const wroteToRepo = () =>
	commands.filter(
		(c) => c.path === "/coding/act" || c.path === "/coding/message" || (c.path === "/coding/git" && String(c.body?.cmd ?? "status") !== "status"),
	);

const start = (objective: string, extra: Record<string, unknown> = {}) =>
	loopDriverFor(CODING).start({ env, instanceId: "coder", userId: "u1", objective, budgetId: "b1", depth: 0, repoId: "r1", ...extra });

describe("a live engine whose orchestrator died does not get handed the next issue (#984)", () => {
	it("the queue does NOT drain into it, and nothing says #982 is running", async () => {
		interruptedRun(4 * HOUR);
		queue982();
		machine.alive = true;
		machine.gitStatus = "## main...origin/main\n M workers/api/src/lib/board.ts\n?? store/console/src/components/ApplicationRunFace.tsx\n";

		// The sweeper gets there first, exactly as it did: 4h of silence closes the run row.
		await sweepStaleRuns(env);
		expect(await claim()).toMatchObject({ recovery_run_id: "run-978", recovery_issue: 978, recovery_reason: "stalled" });

		const drained = await tryDequeueAndStart(env, "coder", "r1", "u1");

		// No Pilot was created, so no engine was ever told about #982.
		expect(pilots).toHaveLength(0);
		// And no run row claims to be working: the ONLY run on this instance is the closed #978 one.
		const all = await runs();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ run_id: "run-978" });
		// The session still names the issue its engine is actually working on.
		expect(await claim()).toMatchObject({ issue_number: 978 });
		// The entry KEEPS ITS PLACE and says what it is waiting for.
		expect(drained).toMatchObject({ drained: true, started: false, requeued: true });
		const e = await entry();
		expect(e).toMatchObject({ status: "pending" });
		expect(String(e?.stop_reason)).toMatch(/STILL RUNNING/);
		expect(String(e?.stop_reason)).toContain("run run-978 (issue #978)");
		// Read-only throughout: the uncommitted work is still there, untouched.
		expect(wroteToRepo()).toEqual([]);
	});

	it("the same refusal protects a run started by HAND, not just the queue", async () => {
		// The queue is one door of several (`start_work`, the Loop button, `delegate_goal`, a ticket).
		// The gate is in the driver for that reason.
		interruptedRun(4 * HOUR);
		machine.alive = true;
		await sweepStaleRuns(env);
		const out = await start("Implement #982: deterministic checkpoint auto-continue", { issue: 982 });
		expect(out).toMatchObject({ ok: false, status: 409, reason: "recovery_required" });
		expect(pilots).toHaveLength(0);
	});

	it("BEFORE any sweep: a stale heartbeat on a still-`running` run blocks the steal that would share its CLI", async () => {
		// The 2h45m window `coding-store.ts` documents: `claimSessionDriver` finds a claim older than
		// STALE_DRIVER_MS takeable long before the sweeper calls the run dead. Nothing raised a claim
		// here — the run still says `running` — so this is the live-owner path, not the stored one.
		interruptedRun(20 * 60_000, { driverAtAgo: STALE_DRIVER_MS + 60_000 });
		machine.alive = true;
		const out = await start("Implement #982: checkpoint auto-continue", { issue: 982 });
		expect(out).toMatchObject({ ok: false, reason: "recovery_required" });
		if (!out.ok) expect(out.error).toContain("run-978");
		expect(pilots).toHaveLength(0);
		// The displaced-run retire never happened, because the claim was never taken.
		expect((await runs())[0]).toMatchObject({ run_id: "run-978", status: "running" });
	});
});

describe("a dirty interrupted checkout is attributed, and recovered deliberately (#984)", () => {
	beforeEach(async () => {
		interruptedRun(4 * HOUR);
		machine.alive = false; // the engine died with its orchestrator
		machine.gitStatus =
			"## main...origin/main\n M workers/api/src/lib/board.ts\n M workers/api/src/lib/work-card.ts\n?? workers/api/src/lib/applications/application-board.ts\n";
		await sweepStaleRuns(env);
	});

	it("a DIFFERENT issue is refused, and the owner is told whose work is in the way", async () => {
		queue982();
		const drained = await tryDequeueAndStart(env, "coder", "r1", "u1");
		expect(drained).toMatchObject({ started: false, requeued: true });
		expect(pilots).toHaveLength(0);

		const e = await entry();
		expect(e).toMatchObject({ status: "pending" });
		expect(String(e?.stop_reason)).toContain("3 uncommitted files");
		expect(String(e?.stop_reason)).toContain("issue #978");

		// On the BOARD, where a person looks, as something that needs them.
		const card = (await cards()).find((c) => c.type === "coding.recovery");
		expect(card).toMatchObject({ status: "needs_human" });
		expect(String(card?.payload)).toContain("issue #978");
		expect(String(card?.payload)).toContain("run-978");

		// And on the queue read (#984's Queue/MCP requirement).
		expect(await storedHandoff(env, "coder", "u1", "r1")).toMatchObject({ state: "interrupted_awaiting_recovery", runId: "run-978", issue: 978 });
		expect(wroteToRepo()).toEqual([]);
	});

	it("a run for the SAME issue is admitted as a recovery, and the handover is recorded", async () => {
		const out = await start("Finish #978: the Board card work left uncommitted", { issue: 978 });
		expect(out.ok).toBe(true);
		expect(pilots).toHaveLength(1);
		// It runs in the SAME session — that is the point of a recovery — and the claim now names
		// the run that took it over, so the checkout's owner and the active run agree.
		const c = await claim();
		expect(c).toMatchObject({ recovery_run_id: "run-978", recovery_issue: 978 });
		expect(c?.recovered_by_run_id).toBe(out.ok ? out.runId : "");
		expect(c?.recovery_released_at).toBeTruthy();
		expect(String(c?.recovery_state)).toBe("interrupted_awaiting_recovery");
		// Nothing was reset, stashed or committed to make room for it.
		expect(wroteToRepo()).toEqual([]);
	});

	it("a REPAIR run is admitted — its whole brief is to put the checkout right without discarding", async () => {
		const out = await start("(platform-written repair brief)", { repairCheckout: true });
		expect(out.ok).toBe(true);
		expect((pilots[0]?.goal as { repairCheckout?: boolean })?.repairCheckout).toBe(true);
	});

	it("an explicit continue of the claimed run is admitted even when it has no issue", async () => {
		d1.exec("UPDATE coding_sessions SET recovery_issue = NULL, issue_number = NULL WHERE id = 'csess-A'");
		const refused = await start("Something else entirely", { issue: 404 });
		expect(refused.ok).toBe(false);
		const out = await start("Implement #978: application execution runs on the Board", { continueFromRunId: "run-978" });
		expect(out.ok).toBe(true);
	});

	it("nothing is discarded or cleared by the platform: the claim and the diff survive a refusal", async () => {
		await start("Implement #982: checkpoint auto-continue", { issue: 982 });
		await start("Implement #982: checkpoint auto-continue", { issue: 982 });
		// Still owned by #978 after two refusals, still unreleased, and the machine was only ever read.
		expect(await claim()).toMatchObject({ recovery_run_id: "run-978", recovery_released_at: null, recovered_by_run_id: null });
		expect(wroteToRepo()).toEqual([]);
		expect(new Set(commands.map((c) => c.path))).toEqual(new Set(["/coding/capture", "/coding/git"]));
	});
});

describe("a confirmed-clean handover is not a blocker (#984)", () => {
	it("engine stopped and tree clean: the claim is released and the next issue starts normally", async () => {
		interruptedRun(4 * HOUR);
		machine.alive = false;
		machine.gitStatus = "## main...origin/main\n";
		await sweepStaleRuns(env);
		queue982();

		const drained = await tryDequeueAndStart(env, "coder", "r1", "u1");
		expect(drained).toMatchObject({ drained: true, started: true });
		expect(pilots).toHaveLength(1);
		expect(String((pilots[0]?.goal as { objective?: string })?.objective ?? pilots[0]?.objective)).toContain("#982");
		// The claim is answered with nobody having recovered anything, because there was nothing to.
		const c = await claim();
		expect(c?.recovery_released_at).toBeTruthy();
		expect(c?.recovered_by_run_id).toBeNull();
		expect(String(c?.recovery_state)).toBe("safe_to_start_next");
		// Nothing left claiming the repo for a later reader.
		expect(await storedHandoff(env, "coder", "u1", "r1")).toBeNull();
		expect((await cards()).some((c2) => c2.type === "coding.recovery")).toBe(false);
	});

	it("an engine the machine has never heard of is CONFIRMED gone — a restarted runner must not wedge the queue", async () => {
		interruptedRun(4 * HOUR);
		machine.alive = false;
		await sweepStaleRuns(env);
		// The runner restarted: the session id means nothing to it any more.
		const original = env.RELAY;
		(env as unknown as { RELAY: unknown }).RELAY = {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					if (new URL(req.url).pathname === "/status") return new Response(JSON.stringify({ connected: true }));
					const cmd = (await req.json().catch(() => ({}))) as { path?: string };
					commands.push({ path: cmd.path });
					if (cmd.path === "/coding/capture") return new Response("No coding session: csess-A", { status: 500 });
					if (cmd.path === "/coding/git") return new Response(JSON.stringify({ output: "## main...origin/main\n" }));
					return new Response(JSON.stringify({ ok: true }));
				},
			}),
		};
		const out = await start("Implement #982: checkpoint auto-continue", { issue: 982 });
		(env as unknown as { RELAY: unknown }).RELAY = original;
		expect(out.ok).toBe(true);
	});
});

describe("the handover check cannot wedge a healthy agent (#984)", () => {
	it("no claim, no running run: one extra SELECT and nothing else — no probe, no refusal", async () => {
		const out = await start("Add a test for the new board card", { issue: 1000 });
		expect(out.ok).toBe(true);
		// The admission check must not cost a relay round trip on the ordinary path.
		expect(commands.filter((c) => c.path === "/coding/capture")).toEqual([]);
	});

	it("a HEALTHY long run is still answered with the ordinary busy refusal, not a recovery one", async () => {
		// Its Pilot heartbeats its claim on every action, so `driver_at` is fresh. Mislabelling this
		// as stalled would rewrite the most common refusal in the product.
		interruptedRun(2 * HOUR, { driverAtAgo: 30_000 });
		const out = await start("Implement #982: checkpoint auto-continue", { issue: 982 });
		expect(out).toMatchObject({ ok: false, reason: "busy" });
		if (!out.ok) expect(out.error).toContain("already being worked on");
	});
});
