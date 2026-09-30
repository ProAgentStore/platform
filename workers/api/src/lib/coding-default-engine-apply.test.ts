import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDefaultCodingEngineToIdle } from "./coding-default-engine-apply.js";
import { claimFreeSessionDriver, claimSessionDriver, STALE_DRIVER_MS } from "./coding-store.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { CodingClientType, CodingSessionRecord } from "./coding-types.js";
import type { EnginePreflight } from "./engine-preflight.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;

const INSTANCES = ["idle", "explicit", "running", "busy", "queued", "nocodex", "oldcli", "claimed", "idle2"];

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: INSTANCES });
	env = { DB: d1.DB } as unknown as Env;
	d1.exec(`UPDATE users SET preferences = '{"coding":{"defaultEngineId":"codex"}}' WHERE id = 'u1'`);
});

afterEach(() => d1.close());

function q(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

function repo(instanceId: string): string {
	const id = `repo-${instanceId}`;
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, default_client) VALUES (${q(id)}, ${q(instanceId)}, 'u1', ${q(instanceId)}, 'claude')`);
	return id;
}

function session(instanceId: string, opts: { driver?: string; driverAt?: number | null } = {}): string {
	const repoId = repo(instanceId);
	const id = `sess-${instanceId}`;
	d1.exec(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, tmux_session, launch_command, driver_id, driver_at, last_activity_at)
		 VALUES (${q(id)}, ${q(instanceId)}, ${q(repoId)}, 'u1', 'claude', 'active', ${q(`pags-${id}`)}, 'claude --dangerously-skip-permissions',
		         ${opts.driver ? q(opts.driver) : "NULL"}, ${opts.driverAt === undefined || opts.driverAt === null ? "NULL" : opts.driverAt}, 1)`,
	);
	return id;
}

const one = <T>(sql: string): T => d1.sqlite.prepare(sql).get() as T;

type Restart = { sessionId: string; command: string; clientType: CodingClientType };

/** Deps that never touch a runner: every coder reachable and idle, every machine able to run codex. */
function deps(overrides: {
	runState?: (s: CodingSessionRecord) => string | null;
	preflight?: (t: CodingSessionRecord) => EnginePreflight;
	onCapture?: (s: CodingSessionRecord) => Promise<void>;
} = {}) {
	const restarted: Restart[] = [];
	const preflighted: CodingSessionRecord[] = [];
	return {
		restarted,
		preflighted,
		deps: {
			captureRunState: async (s: CodingSessionRecord) => {
				await overrides.onCapture?.(s);
				return { reachable: true, runState: overrides.runState ? overrides.runState(s) : "idle" };
			},
			preflight: async (t: CodingSessionRecord) => {
				preflighted.push(t);
				return overrides.preflight ? overrides.preflight(t) : ({ state: "ok" } as EnginePreflight);
			},
			restartSession: async ({ session, command, clientType }: { session: CodingSessionRecord; command: string; clientType: CodingClientType }) => {
				restarted.push({ sessionId: session.id, command, clientType });
				return { ok: true, newSessionId: `new-${session.id}` };
			},
		},
	};
}

const CODEX = "codex exec --json --sandbox danger-full-access";

describe("applyDefaultCodingEngineToIdle — mixed idle and active coders (#879)", () => {
	it("restarts only inherited idle coders; skips explicit, in-flight, busy, queued, unavailable and outdated ones", async () => {
		const idle = session("idle");
		session("explicit");
		d1.exec(`UPDATE agent_instances SET config = '{"defaultEngineId":"gemini"}' WHERE id = 'explicit'`);
		const running = session("running");
		d1.exec(
			`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id)
			 VALUES ('run-1', 'u1', 'running', 'ship', 'running', 10, 1, ${q(running)})`,
		);
		session("busy");
		session("queued");
		d1.exec(
			`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at)
			 VALUES ('qo-1', 'queued', 'repo-queued', 'u1', 'next thing', 'pending', 1)`,
		);
		session("nocodex");
		session("oldcli");

		const t = deps({
			runState: (s) => (s.instanceId === "busy" ? "thinking" : "idle"),
			preflight: (target) =>
				target.instanceId === "nocodex"
					? { state: "no-binary", message: "Codex is not installed on machine \"mini\"" }
					: target.instanceId === "oldcli"
						? { state: "unverified", outdated: true, message: "older than 0.4.67 — runner_update" }
						: { state: "ok" },
		});
		const result = await applyDefaultCodingEngineToIdle(env, "u1", t.deps);

		expect(result.defaultEngineId).toBe("codex");
		expect(t.restarted).toEqual([{ sessionId: idle, command: CODEX, clientType: "codex" }]);
		expect(result.restarted).toBe(1);
		expect(result.skipped).toMatchObject({
			"explicit-instance-default": 1,
			"active-run": 1,
			busy: 1,
			"queued-objective": 1,
			"engine-unavailable": 1,
			"runner-outdated": 1,
		});
		expect(result.items.find((i) => i.sessionId === idle)?.newSessionId).toBe(`new-${idle}`);
		// The skip names the engine and what to do, so the Preferences page / MCP caller can relay it.
		expect(result.items.find((i) => i.instanceId === "nocodex")?.detail).toMatch(/Codex is not installed/);
		expect(result.items.find((i) => i.instanceId === "oldcli")?.detail).toMatch(/runner_update/);
		// The preflight asked about the TARGET engine, not the one currently running.
		expect(t.preflighted.every((p) => p.clientType === "codex" && p.launchCommand === CODEX)).toBe(true);
		// Every skipped coder is left exactly as it was: still active, and no claim left behind.
		for (const id of ["busy", "queued", "nocodex", "oldcli"]) {
			expect(one<{ status: string; driver_id: string | null }>(`SELECT status, driver_id FROM coding_sessions WHERE id = 'sess-${id}'`)).toEqual({ status: "active", driver_id: null });
		}
	});

	it("a coder whose engine cannot be confirmed is never stopped", async () => {
		session("nocodex");
		const t = deps({ preflight: () => ({ state: "signed-out", message: "Codex is installed but not signed in" }) });
		const result = await applyDefaultCodingEngineToIdle(env, "u1", t.deps);
		expect(t.restarted).toEqual([]);
		expect(result.skipped["engine-unavailable"]).toBe(1);
	});

	it("an unreachable machine during the preflight is offline, not a condemned engine", async () => {
		session("idle");
		const t = deps({ preflight: () => ({ state: "unverified", outdated: false, message: "did not answer" }) });
		const result = await applyDefaultCodingEngineToIdle(env, "u1", t.deps);
		expect(t.restarted).toEqual([]);
		expect(result.skipped.offline).toBe(1);
		expect(result.skipped["engine-unavailable"]).toBe(0);
	});

	it("a queued objective for ANY repo of the instance (repo_id NULL) also holds the restart", async () => {
		session("queued");
		d1.exec(
			`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at)
			 VALUES ('qo-any', 'queued', NULL, 'u1', 'whatever repo', 'running', 1)`,
		);
		const t = deps();
		const result = await applyDefaultCodingEngineToIdle(env, "u1", t.deps);
		expect(t.restarted).toEqual([]);
		expect(result.skipped["queued-objective"]).toBe(1);
	});

	it("a finished queue entry does not hold anything", async () => {
		session("queued");
		d1.exec(
			`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at)
			 VALUES ('qo-done', 'queued', 'repo-queued', 'u1', 'done', 'started', 1)`,
		);
		const t = deps();
		expect((await applyDefaultCodingEngineToIdle(env, "u1", t.deps)).restarted).toBe(1);
	});
});

describe("applyDefaultCodingEngineToIdle — a run starting mid-apply (#879)", () => {
	it("holds the session while it decides: a run trying to start in that window is refused", async () => {
		const idle = session("idle");
		let runClaimed: boolean | null = null;
		const t = deps({
			// The capture runs AFTER apply-now's claim — exactly the idle-check→restart window.
			onCapture: async (s) => {
				runClaimed = await claimSessionDriver(env, s.instanceId, "u1", s.id, "loop-run-1");
			},
		});
		const result = await applyDefaultCodingEngineToIdle(env, "u1", t.deps);
		expect(runClaimed).toBe(false);
		expect(t.restarted.map((r) => r.sessionId)).toEqual([idle]);
		expect(result.restarted).toBe(1);
	});

	it("a run that becomes active after the first check is caught by the re-check under the claim", async () => {
		const idle = session("idle");
		const t = deps({
			// A run row lands while apply-now holds the claim (a path that writes its row before it
			// claims). The capture is the last read before the restart, so recheck must see it...
			onCapture: async () => {
				d1.exec(
					`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id)
					 VALUES ('run-late', 'u1', 'idle', 'late', 'running', 10, 1, ${q(idle)})`,
				);
			},
			// ...and the engine reports it is working, so it is not idle either.
			runState: () => "thinking",
		});
		const result = await applyDefaultCodingEngineToIdle(env, "u1", t.deps);
		expect(t.restarted).toEqual([]);
		expect(result.skipped.busy).toBe(1);
		expect(one<{ driver_id: string | null }>(`SELECT driver_id FROM coding_sessions WHERE id = ${q(idle)}`).driver_id).toBeNull();
	});

	it("never steals a stale claim — the run holding it is not retired by a convenience action", async () => {
		const claimed = session("claimed", { driver: "loop-old", driverAt: Date.now() - STALE_DRIVER_MS - 60_000 });
		d1.exec(
			`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id)
			 VALUES ('run-stale', 'u1', 'claimed', 'old', 'running', 10, 1, ${q(claimed)})`,
		);
		const t = deps();
		const result = await applyDefaultCodingEngineToIdle(env, "u1", t.deps);
		expect(t.restarted).toEqual([]);
		expect(result.skipped["active-run"]).toBe(1);
		expect(one<{ driver_id: string }>(`SELECT driver_id FROM coding_sessions WHERE id = ${q(claimed)}`).driver_id).toBe("loop-old");
		expect(one<{ status: string }>("SELECT status FROM agent_loop_runs WHERE run_id = 'run-stale'").status).toBe("running");
	});
});

describe("claimFreeSessionDriver (#879)", () => {
	it("claims a free active session once, and never over any existing claim", async () => {
		const id = session("idle");
		expect(await claimFreeSessionDriver(env, "idle", "u1", id, "a")).toBe(true);
		expect(await claimFreeSessionDriver(env, "idle", "u1", id, "b")).toBe(false);
		const stale = session("claimed", { driver: "x", driverAt: 1 });
		expect(await claimFreeSessionDriver(env, "claimed", "u1", stale, "b")).toBe(false);
	});

	it("does not claim an ended session", async () => {
		const id = session("idle2");
		d1.exec(`UPDATE coding_sessions SET status = 'ended' WHERE id = ${q(id)}`);
		expect(await claimFreeSessionDriver(env, "idle2", "u1", id, "a")).toBe(false);
	});
});
