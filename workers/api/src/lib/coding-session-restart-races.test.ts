/**
 * #1178 — the coding-session state races around a runner restart, over the real schema.
 *
 * 1. The orphan reconcile ends `active` sessions the runner does not list. A restart empties that memory-only list while a run is between
 *    turns and about to relaunch the engine, so a session a live driver or a ticking run owns must survive it — decided in the UPDATE, so a
 *    claim taken after the read still wins.
 * 3. Relocating a `suspended` session to another machine reactivates it, in the same statement that moves it.
 * (2, the runner's restart guard, is tested where it lives: packages/browser-runner coding/runtime.test.ts and packages/cli
 *  runner-work-observation.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSessionDriver, endSession, reassignSessionNode, reconcileOrphanedSessions, releaseSessionDriver, STALE_DRIVER_MS } from "./coding-store.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const MIN = 60_000;
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'owner/repo'), ('r2', 'i1', 'u1', 'owner/other')`);
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

/** An `active` session whose last write was `age` minutes ago — past the reconcile's grace window by default. */
function session(id: string, over: { repo?: string; status?: string; ageMin?: number; node?: string | null } = {}) {
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, runner_node, updated_at)
	  VALUES ('${id}', 'i1', '${over.repo ?? "r1"}', 'u1', '${over.status ?? "active"}', 'claude', ${over.node === null ? "NULL" : `'${over.node ?? "laptop"}'`}, datetime('now', '-${over.ageMin ?? 10} minutes'))`);
}
const quiet = (id: string) => d1.exec(`UPDATE coding_sessions SET updated_at = datetime('now', '-10 minutes') WHERE id = '${id}'`);
const row = (id: string) => d1.sqlite.prepare("SELECT status, runner_node, ended_at, driver_id FROM coding_sessions WHERE id = ?").get(id) as { status: string; runner_node: string | null; ended_at: string | null; driver_id: string | null };
function run(id: string, sessionId: string, over: { status?: string; aliveAgoMs?: number } = {}) {
	const alive = Date.now() - (over.aliveAgoMs ?? 0);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, last_alive_at)
	  VALUES ('${id}', 'u1', 'i1', 'x', '${over.status ?? "running"}', 10, ${alive}, '${sessionId}', ${alive})`);
}

describe("the orphan reconcile leaves a session something owns (#1178)", () => {
	it("ends a session nothing owns and the runner does not list — as before", async () => {
		session("s1");
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual(["s1"]);
		expect(row("s1").status).toBe("ended");
	});

	it("keeps one the runner lists, and one inside the grace window", async () => {
		session("live");
		session("fresh", { repo: "r2", ageMin: 1 });
		expect(await reconcileOrphanedSessions(env, "i1", "u1", ["live"])).toEqual([]);
		expect(row("live").status).toBe("active");
		expect(row("fresh").status).toBe("active");
	});

	it("keeps a session with a live driver claim — the run that is about to relaunch the engine", async () => {
		session("s1");
		expect(await claimSessionDriver(env, "i1", "u1", "s1", "drv-1")).toBe(true);
		quiet("s1"); // a claim stamps updated_at too; the session must be past the grace window for the claim to be what protects it
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual([]);
		expect(row("s1")).toMatchObject({ status: "active", driver_id: "drv-1" });
	});

	it("reaps it once the claim has gone quiet for the stale window, and frees the claim", async () => {
		session("s1");
		await claimSessionDriver(env, "i1", "u1", "s1", "drv-1");
		quiet("s1");
		const now = Date.now();
		// a heartbeat just inside the window still owns it...
		d1.exec(`UPDATE coding_sessions SET driver_at = ${now - STALE_DRIVER_MS + MIN} WHERE id = 's1'`);
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [], now)).toEqual([]);
		// ...one past it owns nothing
		d1.exec(`UPDATE coding_sessions SET driver_at = ${now - STALE_DRIVER_MS - MIN} WHERE id = 's1'`);
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [], now)).toEqual(["s1"]);
		expect(row("s1")).toMatchObject({ status: "ended", driver_id: null });
	});

	it("a legacy claim with no heartbeat stamp does not pin a session forever", async () => {
		session("s1");
		d1.exec(`UPDATE coding_sessions SET driver_id = 'old', driver_at = NULL WHERE id = 's1'`);
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual(["s1"]);
	});

	it("keeps a session whose run is still ticking, with no claim held; reaps it when the run has gone quiet or finished", async () => {
		session("ticking");
		run("run-a", "ticking", { aliveAgoMs: 2 * MIN });
		session("quiet", { repo: "r2" });
		run("run-b", "quiet", { aliveAgoMs: STALE_DRIVER_MS + MIN });
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual(["quiet"]);
		expect(row("ticking").status).toBe("active");
		d1.exec(`UPDATE agent_loop_runs SET status = 'done' WHERE run_id = 'run-a'`);
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual(["ticking"]);
	});

	it("a claim taken AFTER the read still wins: the guard is in the UPDATE, and an unguarded end is unchanged", async () => {
		session("s1");
		const drivenSince = Date.now() - STALE_DRIVER_MS;
		// the reconcile has listed s1 as an orphan; a run now claims it
		await claimSessionDriver(env, "i1", "u1", "s1", "drv-late");
		expect(await endSession(env, "i1", "u1", "s1", "ended", { notDrivenSince: drivenSince })).toBe(false);
		expect(row("s1")).toMatchObject({ status: "active", driver_id: "drv-late" });
		// released, the same guarded end goes through; and the plain end route never asks
		await releaseSessionDriver(env, "i1", "u1", "s1", "drv-late");
		expect(await endSession(env, "i1", "u1", "s1", "ended", { notDrivenSince: drivenSince })).toBe(true);
		session("s2", { repo: "r2" });
		await claimSessionDriver(env, "i1", "u1", "s2", "drv-2");
		expect(await endSession(env, "i1", "u1", "s2")).toBe(true);
	});

	it("replays safely: running the reconcile again after a reap finds nothing, and never touches ended or other tenants' rows", async () => {
		session("s1");
		session("gone", { repo: "r2", status: "ended" });
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual(["s1"]);
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual([]);
		expect(await reconcileOrphanedSessions(env, "i1", "someone-else", [])).toEqual([]);
		expect(row("gone").status).toBe("ended");
	});
});

describe("relocating a session reactivates a suspended one (#1178)", () => {
	it("moves the node and reactivates in one statement", async () => {
		session("s1", { status: "suspended", node: "old-laptop" });
		d1.exec(`UPDATE coding_sessions SET ended_at = datetime('now') WHERE id = 's1'`);
		await reassignSessionNode(env, "i1", "u1", "s1", "new-desktop");
		expect(row("s1")).toMatchObject({ status: "active", runner_node: "new-desktop", ended_at: null });
	});

	it("replays to the same state", async () => {
		session("s1", { status: "suspended", node: "old" });
		await reassignSessionNode(env, "i1", "u1", "s1", "new");
		await reassignSessionNode(env, "i1", "u1", "s1", "new");
		expect(row("s1")).toMatchObject({ status: "active", runner_node: "new" });
	});

	it("an active session just relocates, and an ended one is never resurrected by a relocation", async () => {
		session("a", { node: "x" });
		session("e", { repo: "r2", status: "ended", node: "x" });
		await reassignSessionNode(env, "i1", "u1", "a", "y");
		await reassignSessionNode(env, "i1", "u1", "e", "y");
		expect(row("a")).toMatchObject({ status: "active", runner_node: "y" });
		expect(row("e")).toMatchObject({ status: "ended", runner_node: "y" });
	});

	it("does not reactivate when the repo already has an active session (one allowed): it relocates and stays suspended", async () => {
		session("susp", { status: "suspended", node: "old" });
		session("other", { node: "x", ageMin: 0 });
		await reassignSessionNode(env, "i1", "u1", "susp", "new");
		expect(row("susp")).toMatchObject({ status: "suspended", runner_node: "new" });
		expect(row("other").status).toBe("active");
	});

	it("leaves a parked run's session suspended — the resume takes its checkout back before anything reactivates it", async () => {
		session("s1", { status: "suspended", node: "pink-laptop" });
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, checkout_released_at)
		  VALUES ('run-1', 'u1', 'i1', 'x', 'running', 10, ${Date.now()}, 's1', ${Date.now()})`);
		await reassignSessionNode(env, "i1", "u1", "s1", "pink-laptop.modem");
		expect(row("s1")).toMatchObject({ status: "suspended", runner_node: "pink-laptop.modem" });
		// once the run has put its checkout back, a relocation reactivates like any other
		d1.exec(`UPDATE agent_loop_runs SET checkout_released_at = NULL`);
		await reassignSessionNode(env, "i1", "u1", "s1", "pink-laptop.modem");
		expect(row("s1").status).toBe("active");
	});

	it("clears the node when none is given, and is scoped to its owner", async () => {
		session("s1", { status: "suspended", node: "old" });
		await reassignSessionNode(env, "i1", "intruder", "s1", "evil");
		expect(row("s1")).toMatchObject({ status: "suspended", runner_node: "old" });
		await reassignSessionNode(env, "i1", "u1", "s1", null);
		expect(row("s1")).toMatchObject({ status: "active", runner_node: null });
	});

	it("a reactivated session is no longer skipped by the checks that read status — the reconcile owns it like any active one", async () => {
		session("s1", { status: "suspended", node: "old" });
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual([]); // suspended: skipped
		await reassignSessionNode(env, "i1", "u1", "s1", "new");
		expect(await reconcileOrphanedSessions(env, "i1", "u1", ["s1"])).toEqual([]); // active and tracked: kept
		expect(row("s1").status).toBe("active");
	});
});
