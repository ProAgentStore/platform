/**
 * One writer per repository checkout (#1015), on the real migrated schema with a simulated engine.
 *
 * Invariants protected: a direct turn is never admitted while another session of the same repo is
 * owned (a run, a driver claim, or another unconfirmed direct turn); a run start never takes a
 * checkout a direct turn holds; a direct claim is released ONLY on the engine's confirmed idle/stop,
 * so unknown and offline fail closed; concurrent admissions produce exactly one owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import {
	admitDirectTurn,
	deliveryFor,
	engineProbeFromSnapshot,
	listDirectives,
	markDirectivesProcessed,
	recordDirective,
	repoFreeForRun,
	type EngineProbe,
	type ProbeEngine,
} from "./coding-ownership.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
const scope = { instanceId: "i1", userId: "u1", repoId: "r1" };
/** The simulated engine per session; anything unlisted is `unknown` (an unreachable machine). */
let engines: Record<string, EngineProbe>;
const probe: ProbeEngine = async (sid) => engines[sid] ?? "unknown";

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'acme/platform', '/w/platform', 'ready')`);
	// A: a RETAINED session whose run has ended. B: the active session another run is working.
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('A', 'i1', 'r1', 'u1', 'ended', 'codex')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('B', 'i1', 'r1', 'u1', 'active', 'claude')`);
	engines = { A: "idle", B: "idle" };
});
afterEach(() => d1.close());

const runOnB = () =>
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-B', 'u1', 'i1', 'other issue', 'running', 10, 1, 'B')`);
const claimOf = (sid: string) => d1.sqlite.prepare(`SELECT direct_turn_id FROM coding_sessions WHERE id = '${sid}'`).get() as { direct_turn_id: string | null };

describe("admitting a direct turn", () => {
	it("refuses a direct turn on a retained session while another session's run works the checkout (the incident)", async () => {
		runOnB();
		const out = await admitDirectTurn(env, { ...scope, sessionId: "A" }, probe);
		expect(out).toMatchObject({ ok: false, owner: { kind: "run", runId: "run-B", sessionId: "B" } });
		expect(claimOf("A").direct_turn_id).toBeNull();
	});

	it("admits it when nothing else owns the checkout, and records the claim", async () => {
		const out = await admitDirectTurn(env, { ...scope, sessionId: "A" }, probe, 1000);
		expect(out).toMatchObject({ ok: true, kind: "direct" });
		expect(claimOf("A").direct_turn_id).toMatch(/^dturn-/);
	});

	it("treats a message to the session its OWN run drives as a steer — the run stays the owner", async () => {
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-A', 'u1', 'i1', 'x', 'running', 10, 1, 'A')`);
		expect(await admitDirectTurn(env, { ...scope, sessionId: "A" }, probe)).toEqual({ ok: true, kind: "steer", runId: "run-A" });
		expect(claimOf("A").direct_turn_id).toBeNull();
	});

	it("refuses while another session's direct turn is unconfirmed — busy or unknown", async () => {
		await admitDirectTurn(env, { ...scope, sessionId: "A" }, probe);
		for (const state of ["busy", "unknown"] as const) {
			engines.A = state;
			expect(await admitDirectTurn(env, { ...scope, sessionId: "B" }, probe)).toMatchObject({ ok: false, owner: { kind: "direct", sessionId: "A" } });
		}
		// Confirmed idle releases it, and only then is the other session admitted.
		engines.A = "idle";
		expect(await admitDirectTurn(env, { ...scope, sessionId: "B" }, probe)).toMatchObject({ ok: true, kind: "direct" });
		expect(claimOf("A").direct_turn_id).toBeNull();
	});

	it("lets exactly one of two concurrent admissions on different sessions win", async () => {
		const [a, b] = await Promise.all([admitDirectTurn(env, { ...scope, sessionId: "A" }, probe), admitDirectTurn(env, { ...scope, sessionId: "B" }, probe)]);
		expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
		const claims = d1.sqlite.prepare("SELECT count(*) AS n FROM coding_sessions WHERE direct_turn_id IS NOT NULL").get() as { n: number };
		expect(claims.n).toBe(1);
	});

	it("does not consult a different repository", async () => {
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r2', 'i1', 'u1', 'acme/other', '/w/other', 'ready')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('C', 'i1', 'r2', 'u1', 'active', 'claude')`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-C', 'u1', 'i1', 'x', 'running', 10, 1, 'C')`);
		expect(await admitDirectTurn(env, { ...scope, sessionId: "A" }, probe)).toMatchObject({ ok: true, kind: "direct" });
	});
});

describe("a run start against a direct turn (loop, queue drain, delegation)", () => {
	beforeEach(async () => {
		await admitDirectTurn(env, { ...scope, sessionId: "A" }, probe);
	});

	it.each(["busy", "unknown"] as const)("refuses while the direct turn's engine is %s — fail closed", async (state) => {
		engines.A = state;
		expect(await repoFreeForRun(env, { ...scope, sessionId: "B" }, probe)).toMatchObject({ free: false, owner: { kind: "direct", sessionId: "A" } });
		expect(claimOf("A").direct_turn_id).not.toBeNull();
	});

	it("refuses even on the same session, until the engine is confirmed idle", async () => {
		engines.A = "busy";
		expect((await repoFreeForRun(env, { ...scope, sessionId: "A" }, probe)).free).toBe(false);
	});

	it.each(["idle", "stopped"] as const)("admits once the engine is confirmed %s, releasing the claim", async (state) => {
		engines.A = state;
		expect(await repoFreeForRun(env, { ...scope, sessionId: "B" }, probe)).toEqual({ free: true });
		expect(claimOf("A").direct_turn_id).toBeNull();
	});

	it("refuses a run on a session other than the one another run owns", async () => {
		engines.A = "idle";
		runOnB();
		expect(await repoFreeForRun(env, { ...scope, sessionId: "A" }, probe)).toMatchObject({ free: false, owner: { kind: "run", runId: "run-B" } });
	});
});

describe("engine probe and delivery vocabulary", () => {
	it("reads a snapshot without ever turning a missing one into idle", () => {
		expect(engineProbeFromSnapshot(null)).toBe("unknown");
		expect(engineProbeFromSnapshot({})).toBe("unknown");
		expect(engineProbeFromSnapshot({ alive: false })).toBe("stopped");
		expect(engineProbeFromSnapshot({ alive: true, ready: true })).toBe("idle");
		expect(engineProbeFromSnapshot({ alive: true, ready: false })).toBe("busy");
	});

	it("separates delivered, queued behind a turn, and interrupting one", () => {
		expect(deliveryFor("idle", true)).toBe("delivered");
		expect(deliveryFor("busy", true)).toBe("queued");
		expect(deliveryFor("busy", false)).toBe("interrupting");
	});
});

describe("directives: delivery is recorded, processing is observed separately", () => {
	it("lists a run's directives oldest first and marks only those a later completed turn covers", async () => {
		await recordDirective(env, { ...scope, sessionId: "B", runId: null, kind: "steer", delivery: "queued", content: "read-only from now on", now: 1_000 });
		await recordDirective(env, { ...scope, sessionId: "B", runId: null, kind: "steer", delivery: "queued", content: "and do not stash", now: 60_000 });
		expect((await listDirectives(env, { ...scope, sessionId: "B", sinceMs: 0 })).map((d) => d.content)).toEqual(["read-only from now on", "and do not stash"]);
		expect(await listDirectives(env, { ...scope, sessionId: "B", sinceMs: 2_000 })).toHaveLength(1);

		// No completed turn reported: nothing is claimed processed.
		expect(await markDirectivesProcessed(env, { ...scope, sessionId: "B", turnEndedAt: null })).toBe(0);
		// A turn that ended after the first but before the second covers only the first.
		expect(await markDirectivesProcessed(env, { ...scope, sessionId: "B", turnEndedAt: 10_000, skewMs: 0 })).toBe(1);
		expect((await listDirectives(env, { ...scope, sessionId: "B", sinceMs: 0 })).map((d) => d.processedAt != null)).toEqual([true, false]);
	});

	it("never credits a directive recorded after the turn ended — the old skew pointed the wrong way (#1019)", async () => {
		// The engine's turn ended at 100_000; the owner's correction arrived three seconds LATER. The engine
		// has not seen it. It used to be marked processed because the skew was ADDED to the turn's end.
		await recordDirective(env, { ...scope, sessionId: "B", runId: null, kind: "steer", delivery: "delivered", content: "stop after the push", now: 103_000 });
		expect(await markDirectivesProcessed(env, { ...scope, sessionId: "B", turnEndedAt: 100_000 })).toBe(0);
		// A turn that ends clearly after it does count.
		expect(await markDirectivesProcessed(env, { ...scope, sessionId: "B", turnEndedAt: 110_000 })).toBe(1);
	});

	it("records a message whose engine state was unknown as ACCEPTED, not delivered (#1019)", async () => {
		expect(deliveryFor("unknown", true)).toBe("accepted");
		expect(deliveryFor("unknown", false)).toBe("accepted");
		const d = await recordDirective(env, { ...scope, sessionId: "B", runId: null, kind: "direct", delivery: deliveryFor("unknown", true), content: "x", now: 5 });
		expect((await listDirectives(env, { ...scope, sessionId: "B", sinceMs: 0 })).find((r) => r.id === d.id)?.delivery).toBe("accepted");
	});
});
