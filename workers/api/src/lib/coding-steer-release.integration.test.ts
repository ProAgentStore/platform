/**
 * A steer's claim on an ENDED session is released on the runner's word, and the queue it held back
 * drains exactly once (#1015, comment 6109749991).
 *
 * ── What is real here
 *
 * The migrated schema, the coding routes (`/message`, `/end`), the dispatcher's admission, the
 * ownership probe and its relay transport (`callRunner` → `RelayDO` response shape), the session
 * settlement, the watcher's settle pass, the objective-queue drain and the coding driver's whole
 * admission path. The fakes are the machine behind the relay — which answers a missing session
 * exactly as the runner does (500 `{"error":"No coding session: <id>"}`, `server.ts` + `RelayDO`) —
 * the workflow bindings, and the Co-pilot summary and push notification the watcher ends with.
 *
 * ── The defect
 *
 * A message to a run-driven session is a steer, and a steer reserves the checkout. The run ends, its
 * engine is ended, `endSession` clears the driver claim but not the reservation, and the runner
 * forgets the session. Every later capture failed, every failure read as `unknown`, so the claim was
 * kept forever and the queued objective never started.
 *
 * Invariants protected: only the session's own stamped machine saying it has no session by that
 * exact id releases a claim (unreachable, timeouts, dropped sockets, malformed replies and other ids
 * do not); a release never clears a newer claim; the original queued objective is admitted exactly
 * once however many settlers run; active work on another session is not touched; a watcher whose
 * watch failed still settles; ending an ended session is an owner's exact-target way out; and a run
 * start refused for a known direct owner launches no engine, while one refused in the race disposes
 * only the engine it launched.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { signSession } from "./session.js";
import { HttpError } from "./auth.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { Env } from "../types.js";

vi.mock("./coding-copilot.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./coding-copilot.js")>()), copilotSummary: async () => "" }));
vi.mock("../routes/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../routes/push.js")>()), notifyUser: async () => undefined }));

const { codingRoutes } = await import("../routes/coding.js");
const { captureSaysSessionAbsent, releaseReservation, runnerEngineProbe } = await import("./coding-ownership.js");
const { endSession } = await import("./coding-store.js");
const { loopDriverFor } = await import("./loop-drivers.js");
const { runWatchSession, settleAfterDirectTurn } = await import("../workflows/coding-watch.js");

const CODING = { surfaces: [], runtime: "pags", workflow: "CODING_SESSION", tools: undefined } as unknown as AgentCapabilities;
const SECRET = "steer-release-secret";

type Engine = { alive: boolean; ready: boolean; runState: string };
let d1: RealSchemaD1;
let env: Env;
/** The machine: the sessions its runner holds, per node, and whether each node's relay is up. */
let machine: { sessions: Map<string, Engine>; up: Record<string, boolean>; captureFailure: null | { status: number; body: string } };
/** Every command sent to a machine, with the relay it went to. */
let commands: Array<{ relay: string; path?: string; sessionId?: string }>;
/** Every workflow created: Pilots (a run began) and watchers. */
let pilots: Array<Record<string, unknown>>;
let watchers: Array<Record<string, unknown>>;
/** Run inside `/coding/start`, to land a concurrent send in the driver's admission gap. */
let onStart: (() => void) | null;
/** What the runner answers `/coding/end` with; null = the real runner's `{ok:true, …}` (runtime.ts `end()`). */
let endAnswer: { raw: string } | null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makeEnv(): Env {
	return {
		DB: d1.DB,
		SESSION_SIGNING_KEY: SECRET,
		RELAY: {
			idFromName: (n: string) => n,
			get: (relay: string) => ({
				async fetch(req: Request) {
					const node = relay.includes(":node:") ? relay.split(":node:")[1] : "";
					const up = machine.up[node] === true;
					if (new URL(req.url).pathname === "/status") return json({ connected: up });
					const cmd = (await req.json().catch(() => ({}))) as { path?: string; body?: { sessionId?: string } };
					const sid = cmd.body?.sessionId;
					commands.push({ relay, path: cmd.path, sessionId: sid });
					// RelayDO: no socket at dispatch.
					if (!up) return json({ error: "No runner connected" }, 503);
					const s = sid ? machine.sessions.get(sid) : undefined;
					// The runner's own answer for an id it does not hold (runtime.ts `require` → server.ts 500).
					const missing = () => json({ error: `No coding session: ${sid}` }, 500);
					switch (cmd.path) {
						case "/coding/capture":
							if (machine.captureFailure) return new Response(machine.captureFailure.body, { status: machine.captureFailure.status });
							return s ? json({ sessionId: sid, pane: "$ ", ...s }) : missing();
						case "/coding/act":
							if (!s) return missing();
							Object.assign(s, { ready: false, runState: "thinking" });
							return json({ sessionId: sid, pane: "$ ", ...s });
						case "/coding/start":
							machine.sessions.set(String(sid), { alive: true, ready: true, runState: "idle" });
							onStart?.();
							return json({ ok: true });
						case "/coding/end":
							if (sid) machine.sessions.delete(sid);
							if (endAnswer) return new Response(endAnswer.raw, { status: 200 });
							return json({ ok: true, usage: [], acts: [], authResolved: null });
						case "/coding/engine-check":
							return json({ checked: true, state: "signed-in" });
						case "/coding/repo-check":
							return json({ checked: true, path: "/w/platform", exists: true, isDirectory: true, entryCount: 9, insideWorkTree: true });
						case "/coding/git":
							return json({ output: "## main...origin/main\n" });
						default:
							return json({ ok: true });
					}
				},
			}),
		},
		CODING_SESSION: {
			create: vi.fn(async (o: { params: Record<string, unknown> }) => {
				(o.params.mode === "watch" ? watchers : pilots).push(o.params);
				return { id: "wf" };
			}),
		},
		AGENT_LOOP: { create: vi.fn(async () => ({ id: "wf" })) },
	} as unknown as Env;
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec(`UPDATE agents SET config = '{"capabilities":{"surfaces":["coding"],"runtime":"pags_browser_runtime","workflow":"CODING_SESSION"}}' WHERE id = 'agent-1'`);
	d1.exec(
		`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, default_client, workdir, clone_status)
		 VALUES ('r1', 'coder', 'u1', 'ProAgentStore/platform', 'ProAgentStore/platform', 'claude', '/w/platform', 'ready')`,
	);
	// One machine, `n1`, registered both as the default runtime and as an addressable node.
	d1.exec(
		`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, token_plaintext, runner_version, status, last_seen_at, runner_node)
		 VALUES ('coder', 'u1', 'https://runner.local', 't', '0.4.32', 'registered', datetime('now'), 'n1')`,
	);
	d1.exec(
		`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, status, last_seen_at)
		 VALUES ('coder', 'u1', 'n1', 'https://runner.local', 't', 'registered', datetime('now'))`,
	);
	// S1 is driven by run-1, which is working on it now; its engine is busy on the run's turn.
	d1.exec(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, runner_node, driver_id, driver_at)
		 VALUES ('S1', 'coder', 'r1', 'u1', 'claude', 'active', 'n1', 'pilot-1', ${Date.now()})`,
	);
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status, iteration, session_id, last_alive_at)
		 VALUES ('run-1', 'u1', 'coder', 'Implement #1: the first issue', 12, ${Date.now() - 60_000}, 'running', 3, 'S1', ${Date.now()})`,
	);
	// The objective queued behind run-1, which the stuck claim used to hold back forever.
	d1.exec(
		`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at)
		 VALUES ('objq-2', 'coder', 'r1', 'u1', 'Implement #2: the queued issue', 'pending', ${Date.now()})`,
	);
	machine = { sessions: new Map([["S1", { alive: true, ready: false, runState: "thinking" }]]), up: { n1: true }, captureFailure: null };
	commands = [];
	pilots = [];
	watchers = [];
	onStart = null;
	endAnswer = null;
	env = makeEnv();
});
afterEach(() => d1.close());

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", codingRoutes);
	a.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	return a;
}
async function call(method: string, path: string, body?: unknown) {
	const token = await signSession("u1", SECRET, { roles: [] });
	const res = await app().request(`/v1/instances/coder${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const row = <T>(sql: string) => d1.DB.prepare(sql).first<T>();
const claimOf = async (sid: string) => (await row<{ direct_turn_id: string | null }>(`SELECT direct_turn_id FROM coding_sessions WHERE id = '${sid}'`))?.direct_turn_id ?? null;
const entry = () => row<{ status: string; run_id: string | null }>("SELECT status, run_id FROM instance_objective_queue WHERE id = 'objq-2'");
const sent = (path: string, sid?: string) => commands.filter((c) => c.path === path && (sid === undefined || c.sessionId === sid));

/** The owner steers run-1, then run-1 finishes and its engine is ended — the Pilot's own close. */
async function steerThenRunEnds(): Promise<string> {
	const res = await call("POST", "/coding/sessions/S1/message", { text: "also update the changelog" });
	expect(res.status).toBe(200);
	expect(res.body.admission).toMatchObject({ kind: "steer", runId: "run-1" });
	const turnId = String((res.body.admission as { turnId: string }).turnId);
	expect(await claimOf("S1")).toBe(turnId);
	expect(watchers).toHaveLength(1);
	expect(watchers[0]).toMatchObject({ sessionId: "S1", directTurnId: turnId });
	d1.exec("UPDATE agent_loop_runs SET status = 'completed', finished_at = " + Date.now() + " WHERE run_id = 'run-1'");
	machine.sessions.delete("S1"); // `/coding/end`: the runner forgets the session
	await endSession(env, "coder", "u1", "S1");
	expect(await row("SELECT status, driver_id, direct_turn_id FROM coding_sessions WHERE id = 'S1'")).toMatchObject({ status: "ended", driver_id: null, direct_turn_id: turnId });
	return turnId;
}
const settle = (turnId: string) => settleAfterDirectTurn(env, { instanceId: "coder", userId: "u1", sessionId: "S1", repoId: "r1", turnId, finalPane: null });

describe("the probe: only the stamped machine's exact-session absence is `stopped`", () => {
	beforeEach(() => machine.sessions.delete("S1"));
	const probe = () => runnerEngineProbe(env, "coder", "u1")("S1");

	it("the session's own stamped machine saying it has no session by this id → stopped", async () => {
		expect(await probe()).toBe("stopped");
	});

	it.each([
		["another session's absence", 500, JSON.stringify({ error: "No coding session: S9" })],
		["a runner exception", 500, JSON.stringify({ error: "spawn EAGAIN" })],
		["a malformed body", 500, "<html>Internal Server Error</html>"],
		["a draining runner (503)", 503, JSON.stringify({ error: "Runner is draining for a safe automatic update; retry shortly." })],
		["a socket dropped with the command in flight (504)", 504, JSON.stringify({ error: "Runner disconnected" })],
		["a relay timeout (504)", 504, JSON.stringify({ error: "Relay command timed out" })],
	])("%s → unknown", async (_label, status, body) => {
		machine.captureFailure = { status, body };
		expect(await probe()).toBe("unknown");
	});

	it("an unreachable stamped machine → unknown", async () => {
		machine.up.n1 = false;
		expect(await probe()).toBe("unknown");
	});

	it("an UNSTAMPED session answered by whichever machine is default → unknown", async () => {
		d1.exec("UPDATE coding_sessions SET runner_node = NULL WHERE id = 'S1'");
		expect(await probe()).toBe("unknown");
	});

	it("a session stamped to a machine that is down, while another machine is up → unknown", async () => {
		d1.exec(
			`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, status, last_seen_at)
			 VALUES ('coder', 'u1', 'n2', 'https://runner2.local', 't', 'registered', datetime('now'))`,
		);
		d1.exec("UPDATE coding_sessions SET runner_node = 'n2' WHERE id = 'S1'");
		expect(await probe()).toBe("unknown");
		expect(sent("/coding/capture")).toEqual([]);
	});

	it("reads only the runner's exact sentence for the exact id", () => {
		expect(captureSaysSessionAbsent(new Error('Runner /coding/capture → 500: {"error":"No coding session: S1"}'), "S1")).toBe(true);
		expect(captureSaysSessionAbsent(new Error('Runner /coding/capture → 500: {"error":"No coding session: S10"}'), "S1")).toBe(false);
		expect(captureSaysSessionAbsent(new Error('Runner /coding/act → 500: {"error":"No coding session: S1"}'), "S1")).toBe(false);
		// #1116: a current runner answers that lookup 404 (an older one, 500) — the same sentence either way.
		expect(captureSaysSessionAbsent(new Error('Runner /coding/capture → 404: {"error":"No coding session: S1"}'), "S1")).toBe(true);
		// …but a 404 for the ROUTE (an older runner without the endpoint) is not that answer.
		expect(captureSaysSessionAbsent(new Error('Runner /coding/capture → 404: {"error":"Not found"}'), "S1")).toBe(false);
		expect(captureSaysSessionAbsent("No coding session: S1", "S1")).toBe(false);
	});
});

describe("steer → run ends → engine ended → the watcher settles on the runner's word", () => {
	it("releases the steer's claim and admits the ORIGINAL queued objective exactly once", async () => {
		const turnId = await steerThenRunEnds();
		expect(await settle(turnId)).toBe(true);
		expect(await claimOf("S1")).toBeNull();
		expect(pilots).toHaveLength(1);
		expect(pilots[0]).toMatchObject({ goal: expect.objectContaining({ objective: "Implement #2: the queued issue" }) });
		const e = await entry();
		expect(e).toMatchObject({ status: "started" });
		// The ended engine was not revived: the drain's run opened its OWN session.
		expect(await row("SELECT status FROM coding_sessions WHERE id = 'S1'")).toMatchObject({ status: "ended" });
		expect(await row<{ n: number }>("SELECT count(*) AS n FROM coding_sessions WHERE status = 'active' AND id <> 'S1'")).toMatchObject({ n: 1 });
	});

	it("a late or repeated watcher pass after that is a no-op: still exactly one admission", async () => {
		const turnId = await steerThenRunEnds();
		await settle(turnId);
		await settle(turnId);
		await settle(turnId);
		expect(pilots).toHaveLength(1);
		expect(await row<{ n: number }>("SELECT count(*) AS n FROM agent_loop_runs WHERE status = 'running'")).toMatchObject({ n: 1 });
		expect(await entry()).toMatchObject({ status: "started" });
	});

	it("an unreachable machine keeps the claim and drains nothing — unknown fails closed", async () => {
		const turnId = await steerThenRunEnds();
		machine.up.n1 = false;
		expect(await settle(turnId)).toBe(false);
		expect(await claimOf("S1")).toBe(turnId);
		expect(pilots).toHaveLength(0);
		expect(await entry()).toMatchObject({ status: "pending" });
	});

	it("an ambiguous capture (dropped socket) keeps the claim too", async () => {
		const turnId = await steerThenRunEnds();
		machine.captureFailure = { status: 504, body: JSON.stringify({ error: "Runner disconnected" }) };
		expect(await settle(turnId)).toBe(false);
		expect(await claimOf("S1")).toBe(turnId);
		expect(pilots).toHaveLength(0);
	});

	it("a NEWER claim on the session survives the older watcher, and nothing drains", async () => {
		const turnId = await steerThenRunEnds();
		d1.exec(`UPDATE coding_sessions SET direct_turn_id = 'dturn-newer', direct_turn_at = ${Date.now()}, direct_turn_delivered_at = ${Date.now()} WHERE id = 'S1'`);
		await settle(turnId);
		expect(await claimOf("S1")).toBe("dturn-newer");
		expect(pilots).toHaveLength(0);
		// …and the release itself is keyed to the turn it read.
		expect(await releaseReservation(env, "S1", turnId)).toBe(false);
		expect(await claimOf("S1")).toBe("dturn-newer");
	});

	it("active work on another session of the repo is not interrupted, and the queue waits for it", async () => {
		const turnId = await steerThenRunEnds();
		// Another run took the repo on its own session after S1 ended (one ACTIVE session per repo).
		d1.exec(
			`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, runner_node, driver_id, driver_at)
			 VALUES ('S2', 'coder', 'r1', 'u1', 'claude', 'active', 'n1', 'pilot-2', ${Date.now()})`,
		);
		d1.exec(
			`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status, iteration, session_id, last_alive_at)
			 VALUES ('run-2', 'u1', 'coder', 'Implement #3', 12, ${Date.now()}, 'running', 1, 'S2', ${Date.now()})`,
		);
		machine.sessions.set("S2", { alive: true, ready: false, runState: "thinking" });
		commands = [];
		expect(await settle(turnId)).toBe(true);
		expect(await claimOf("S1")).toBeNull();
		expect(pilots).toHaveLength(0);
		expect(await entry()).toMatchObject({ status: "pending" });
		expect(await row("SELECT status FROM agent_loop_runs WHERE run_id = 'run-2'")).toMatchObject({ status: "running" });
		expect(commands.filter((c) => c.sessionId === "S2" && c.path !== "/coding/capture")).toEqual([]);
		expect(machine.sessions.get("S2")).toMatchObject({ alive: true });
	});
});

describe("a watcher whose watch failed still settles", () => {
	it("watch-idle throwing (the session ended under it) still reaches the settle step, releases and drains once", { timeout: 20_000 }, async () => {
		await steerThenRunEnds();
		const steps: string[] = [];
		const step = {
			do: async (name: string, a: unknown, b?: unknown) => {
				steps.push(name);
				return ((typeof a === "function" ? a : b) as () => Promise<unknown>)();
			},
			sleep: async () => undefined,
		};
		const event = { payload: { ...watchers[0] } };
		const out = await runWatchSession(env, event as never, step as never);
		expect(steps).toContain("watch-idle");
		expect(steps).toContain("direct-turn-settle-0");
		expect(out).toMatchObject({ outcome: "done" });
		expect(await claimOf("S1")).toBeNull();
		expect(pilots).toHaveLength(1);
		expect(await entry()).toMatchObject({ status: "started" });
	});
});

describe("ending the ended session is the owner's exact-target way out (exhausted watcher)", () => {
	it("the HTTP response says already ended, stop confirmed, the exact claim released, and the run the drain admitted", async () => {
		const turnId = await steerThenRunEnds();
		const first = await call("POST", "/coding/sessions/S1/end");
		expect(first.status).toBe(200);
		expect(await claimOf("S1")).toBeNull();
		expect(pilots).toHaveLength(1);
		const e = await entry();
		expect(e).toMatchObject({ status: "started" });
		// Not a failure because the row needed no change; every fact is the one that happened.
		expect(first.body).toEqual({
			ok: true,
			session: "already_ended",
			engineStopped: true,
			directTurn: { turnId, released: true, queue: { attempted: true, drained: true, entryId: "objq-2", started: true, runId: e?.run_id, driver: expect.any(String) } },
		});
	});

	it("a repeat is idempotent: nothing to release, nothing drained, and it says so", async () => {
		await steerThenRunEnds();
		await call("POST", "/coding/sessions/S1/end");
		const second = await call("POST", "/coding/sessions/S1/end");
		expect(second.status).toBe(200);
		expect(second.body).toEqual({ ok: true, session: "already_ended", engineStopped: true });
		expect(pilots).toHaveLength(1);
		expect(await row<{ n: number }>("SELECT count(*) AS n FROM agent_loop_runs WHERE status = 'running'")).toMatchObject({ n: 1 });
	});

	it("an unreachable machine: the stop is unknown, the claim is kept, and no admission is claimed", async () => {
		const turnId = await steerThenRunEnds();
		machine.up.n1 = false;
		const res = await call("POST", "/coding/sessions/S1/end");
		expect(res.body).toEqual({ ok: true, session: "already_ended", engineStopped: null, directTurn: { turnId, released: false, reason: "stop_not_confirmed" } });
		expect(await claimOf("S1")).toBe(turnId);
		expect(pilots).toHaveLength(0);
		expect(await entry()).toMatchObject({ status: "pending" });
	});

	it("a released claim with the repo still owned reports the release and that no drain was attempted", async () => {
		const turnId = await steerThenRunEnds();
		d1.exec(
			`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, runner_node, driver_id, driver_at)
			 VALUES ('S2', 'coder', 'r1', 'u1', 'claude', 'active', 'n1', 'pilot-2', ${Date.now()})`,
		);
		const res = await call("POST", "/coding/sessions/S1/end");
		expect(res.body).toEqual({ ok: true, session: "already_ended", engineStopped: true, directTurn: { turnId, released: true, queue: { attempted: false, reason: "repo_still_owned" } } });
		expect(pilots).toHaveLength(0);
		expect(await entry()).toMatchObject({ status: "pending" });
	});

	it("an unstamped session releases nothing — the stop came from whichever machine is default", async () => {
		const turnId = await steerThenRunEnds();
		d1.exec("UPDATE coding_sessions SET runner_node = NULL WHERE id = 'S1'");
		const res = await call("POST", "/coding/sessions/S1/end");
		expect(res.body).toMatchObject({ session: "already_ended", directTurn: { turnId, released: false, reason: "stop_not_confirmed" } });
		expect(await claimOf("S1")).toBe(turnId);
		expect(pilots).toHaveLength(0);
	});

	it("a live session with no claim still ends as before", async () => {
		const res = await call("POST", "/coding/sessions/S1/end");
		expect(res.body).toEqual({ ok: true, session: "ended", engineStopped: true });
		expect(machine.sessions.has("S1")).toBe(false);
	});

	// A delivered `/coding/end` is not a confirmed stop: only the runner's `{ok:true}` is (#1015).
	it.each([
		["a negative answer", '{"ok":false}'],
		["an answer with no ok at all", '{"usage":[],"acts":[]}'],
		["a non-boolean ok", '{"ok":"true"}'],
		["an empty object", "{}"],
		["null", "null"],
	])("%s from the stamped machine keeps the claim, reports the stop unconfirmed, and admits nothing", async (_name, raw) => {
		const turnId = await steerThenRunEnds();
		endAnswer = { raw };
		const res = await call("POST", "/coding/sessions/S1/end");
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, session: "already_ended", engineStopped: false, directTurn: { turnId, released: false, reason: "stop_not_confirmed" } });
		expect(String(res.body.warning)).toContain("did not confirm it stopped");
		expect(await claimOf("S1")).toBe(turnId);
		expect(pilots).toHaveLength(0);
		expect(await entry()).toMatchObject({ status: "pending" });
	});

	it("the legacy runner's bare {ok:true} still confirms the stop and releases the exact claim once", async () => {
		const turnId = await steerThenRunEnds();
		endAnswer = { raw: '{"ok":true}' };
		const res = await call("POST", "/coding/sessions/S1/end");
		expect(res.body).toMatchObject({ ok: true, session: "already_ended", engineStopped: true, directTurn: { turnId, released: true, queue: { attempted: true, started: true } } });
		expect(res.body).not.toHaveProperty("warning");
		expect(await claimOf("S1")).toBeNull();
		expect(pilots).toHaveLength(1);
	});

	it("a live session whose stop is not confirmed still closes its row, with the warning", async () => {
		endAnswer = { raw: '{"ok":false}' };
		const res = await call("POST", "/coding/sessions/S1/end");
		expect(res.body).toMatchObject({ ok: true, session: "ended", engineStopped: false });
		expect(String(res.body.warning)).toContain("did not confirm it stopped");
	});

	it("an unknown session is not found, and not ok", async () => {
		const res = await call("POST", "/coding/sessions/NOPE/end");
		expect(res.body).toEqual({ ok: false, session: "not_found", engineStopped: null });
	});
});

describe("a run start against a direct owner launches no engine it cannot use", () => {
	const start = () => loopDriverFor(CODING).start({ env, instanceId: "coder", userId: "u1", objective: "Implement #4", budgetId: "b1", depth: 0, repoId: "r1" });

	it("a KNOWN direct owner refuses as busy before any session is opened or engine started", async () => {
		// run-1 is over; S1 holds a delivered direct turn its busy engine is still working.
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-1'");
		d1.exec(`UPDATE coding_sessions SET status = 'ended', driver_id = NULL, direct_turn_id = 'dturn-1', direct_turn_at = ${Date.now()}, direct_turn_delivered_at = ${Date.now()} WHERE id = 'S1'`);
		const out = await start();
		expect(out).toMatchObject({ ok: false, status: 409, reason: "busy" });
		expect(sent("/coding/start")).toEqual([]);
		expect(await row<{ n: number }>("SELECT count(*) AS n FROM coding_sessions")).toMatchObject({ n: 1 });
		expect(pilots).toHaveLength(0);
		expect(await claimOf("S1")).toBe("dturn-1");
	});

	it("a claim landing in the admission gap disposes ONLY the engine this start launched", async () => {
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'run-1'");
		d1.exec("UPDATE coding_sessions SET status = 'ended', driver_id = NULL WHERE id = 'S1'");
		machine.sessions.set("S1", { alive: true, ready: false, runState: "thinking" });
		// A direct send on S1 is admitted while the driver is opening its own session.
		onStart = () => d1.exec(`UPDATE coding_sessions SET direct_turn_id = 'dturn-gap', direct_turn_at = ${Date.now()}, direct_turn_delivered_at = ${Date.now()} WHERE id = 'S1'`);
		const out = await start();
		expect(out).toMatchObject({ ok: false, reason: "busy" });
		const opened = sent("/coding/start");
		expect(opened).toHaveLength(1);
		const newSid = String(opened[0].sessionId);
		expect(newSid).not.toBe("S1");
		expect(sent("/coding/end")).toEqual([{ relay: "coder:node:n1", path: "/coding/end", sessionId: newSid }]);
		expect(machine.sessions.has(newSid)).toBe(false);
		expect(await row(`SELECT status FROM coding_sessions WHERE id = '${newSid}'`)).toMatchObject({ status: "ended" });
		// The owner's engine and claim are untouched, and nothing was drained.
		expect(machine.sessions.get("S1")).toMatchObject({ alive: true });
		expect(await claimOf("S1")).toBe("dturn-gap");
		expect(pilots).toHaveLength(0);
		expect(await entry()).toMatchObject({ status: "pending" });
	});
});

