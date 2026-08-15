/**
 * Liveness, progress and parks — against the real schema, with real rows (#580).
 *
 * Deliberately NOT a SQL-string test. The whole defect being fixed is that two columns advanced
 * together when only one should have, and a stub that matches statement text has no opinion on what
 * a statement WROTE. `run-sweeper.test.ts` asserts the predicate's shape; this asserts its effect,
 * which is the half that would have caught the conflation in the first place.
 */
import { afterEach, describe, expect, it } from "vitest";
import { countInterruption, getLoopRun, recordIteration, recordLiveness } from "./agent-loop-store.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { STALE_RUN_MS, sweepStaleRuns } from "./run-sweeper.js";
import type { Env } from "../types.js";

const USER = "user-1";
const INSTANCE = "inst-1";
const NOW = Date.parse("2026-08-15T17:00:00.000Z");

let open: RealSchemaD1 | null = null;
afterEach(() => {
	open?.close();
	open = null;
});

/** A real `agent_loop_runs` row, with whatever timestamps the case is about. */
function withRun(row: {
	runId: string;
	startedAt: number;
	iteration?: number;
	lastProgressAt?: number | null;
	lastAliveAt?: number | null;
	waitingReason?: string | null;
	waitingUntil?: number | null;
	status?: string;
}): { env: Env; d1: RealSchemaD1 } {
	const d1 = realSchemaD1();
	open = d1;
	seedTenant(d1, { userId: USER, instanceIds: [INSTANCE] });
	const q = (v: string | number | null | undefined) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${v}'`);
	d1.exec(
		`INSERT INTO agent_loop_runs
		   (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at,
		    last_progress_at, last_alive_at, waiting_reason, waiting_until)
		 VALUES (${q(row.runId)}, '${USER}', '${INSTANCE}', 'do the thing', ${q(row.status ?? "running")},
		         ${row.iteration ?? 1}, 30, ${row.startedAt},
		         ${q(row.lastProgressAt)}, ${q(row.lastAliveAt)}, ${q(row.waitingReason)}, ${q(row.waitingUntil)})`,
	);
	return { env: { DB: d1.DB } as unknown as Env, d1 };
}

const readRow = (d1: RealSchemaD1, runId: string) =>
	d1.sqlite
		.prepare("SELECT status, iteration, last_progress_at, last_alive_at, waiting_reason, waiting_until, interruptions FROM agent_loop_runs WHERE run_id = ?")
		.get(runId) as Record<string, number | string | null>;

describe("the sweeper reads LIVENESS, so a parked run survives and a dead one does not", () => {
	it("does NOT sweep a run parked for over 3h whose orchestrator is still ticking", async () => {
		// THE REGRESSION THIS FIX MUST NOT SHIP. `coding-session.ts`'s pause tick wrote
		// `last_progress_at` on a timer for exactly one reason — "without which `sweepStaleRuns`
		// closes a parked run as dead at 3h" — so moving progress onto its own honest meaning is
		// only safe if the sweeper starts reading the heartbeat instead. A run parked on an engine
		// usage limit may legitimately sit here for six hours (`MAX_ENGINE_WAIT_MS`), which is twice
		// the sweeper's cutoff.
		const parkedFor = STALE_RUN_MS + 60 * 60_000; // 4h — past the 3h cutoff, inside the 6h park
		const { env, d1 } = withRun({
			runId: "parked",
			startedAt: NOW - parkedFor,
			lastProgressAt: NOW - parkedFor, // has not advanced since it parked, and that is CORRECT
			lastAliveAt: NOW - 5 * 60_000, // the 5-minute engine-wait tick, still beating
			waitingReason: "engine_limit",
			waitingUntil: NOW + 60 * 60_000,
		});
		const out = await sweepStaleRuns(env, NOW);
		expect(out.loopRuns).toBe(0);
		expect(readRow(d1, "parked").status).toBe("running");
	});

	it("sweeps a run whose orchestrator stopped ticking, even though it once reported progress", async () => {
		// The other half of the same denominator: the fix must not make the sweeper toothless. This
		// is the run whose Workflow died — nothing has ticked, and `status` would say `running`
		// forever.
		const { env, d1 } = withRun({
			runId: "dead",
			startedAt: NOW - 5 * 60 * 60_000,
			lastProgressAt: NOW - 4 * 60 * 60_000,
			lastAliveAt: NOW - 4 * 60 * 60_000,
		});
		const out = await sweepStaleRuns(env, NOW);
		expect(out.loopRuns).toBe(1);
		const row = readRow(d1, "dead");
		expect(row.status).toBe("failed");
		expect(row.waiting_reason).toBeNull;
	});

	it("falls back to last_progress_at for a row written before 0127", async () => {
		// Compatibility is a claim about DATA, not about a COALESCE being present in the string. An
		// in-flight run at deploy time has a null `last_alive_at` and must keep behaving exactly as
		// it did — swept on the old column, at the old threshold.
		const { env } = withRun({ runId: "legacy", startedAt: NOW - 9 * 60 * 60_000, lastProgressAt: NOW - 4 * 60 * 60_000, lastAliveAt: null });
		expect((await sweepStaleRuns(env, NOW)).loopRuns).toBe(1);
	});

	it("falls back to started_at when a run died before reporting anything at all", async () => {
		const { env } = withRun({ runId: "stillborn", startedAt: NOW - 4 * 60 * 60_000, lastProgressAt: null, lastAliveAt: null });
		expect((await sweepStaleRuns(env, NOW)).loopRuns).toBe(1);
	});
});

describe("recordIteration — progress cannot move unless the counter moves", () => {
	it("a tick with an UNCHANGED iteration updates liveness only", async () => {
		// The conflation, stated as a test. This is the exact call `coding-session.ts`'s pause tick
		// made — `recordIteration(runId, pilotSteps)` with `pilotSteps` stuck at 1 — and it is what
		// carried run 70ea298e's `lastProgressAt` to within 3.5 minutes of an observation made 4.35
		// hours after its last real advance.
		const parked = NOW - 4 * 60 * 60_000;
		const { env, d1 } = withRun({ runId: "r", startedAt: parked, iteration: 1, lastProgressAt: parked, lastAliveAt: parked });
		await recordIteration(env, "r", 1, NOW);
		const row = readRow(d1, "r");
		expect(row.last_progress_at).toBe(parked);
		expect(row.last_alive_at).toBe(NOW);
	});

	it("an ADVANCE moves both, and clears the park the run just came out of", async () => {
		const parked = NOW - 60 * 60_000;
		const { env, d1 } = withRun({
			runId: "r",
			startedAt: parked,
			iteration: 1,
			lastProgressAt: parked,
			lastAliveAt: NOW - 60_000,
			waitingReason: "engine_limit",
			waitingUntil: NOW + 60_000,
		});
		await recordIteration(env, "r", 2, NOW);
		const row = readRow(d1, "r");
		expect(row.iteration).toBe(2);
		expect(row.last_progress_at).toBe(NOW);
		expect(row.last_alive_at).toBe(NOW);
		expect(row.waiting_reason).toBeNull();
		expect(row.waiting_until).toBeNull();
	});

	it("a park is NOT cleared by a tick that did not advance", async () => {
		const { env, d1 } = withRun({ runId: "r", startedAt: NOW - 60_000, iteration: 3, waitingReason: "human", waitingUntil: null });
		await recordIteration(env, "r", 3, NOW);
		expect(readRow(d1, "r").waiting_reason).toBe("human");
	});
});

describe("recordLiveness — a heartbeat is a statement about the orchestrator, never the objective", () => {
	it("touches neither the counter nor progress", async () => {
		const before = NOW - 60 * 60_000;
		const { env, d1 } = withRun({ runId: "r", startedAt: before, iteration: 4, lastProgressAt: before, lastAliveAt: before });
		await recordLiveness(env, "r", NOW);
		const row = readRow(d1, "r");
		expect(row.iteration).toBe(4);
		expect(row.last_progress_at).toBe(before);
		expect(row.last_alive_at).toBe(NOW);
	});

	it("records WHY a run is parked and when it should resume", async () => {
		const { env, d1 } = withRun({ runId: "r", startedAt: NOW - 60_000 });
		await recordLiveness(env, "r", NOW, { reason: "engine_limit", until: NOW + 3600_000 });
		const row = readRow(d1, "r");
		expect(row.waiting_reason).toBe("engine_limit");
		expect(row.waiting_until).toBe(NOW + 3600_000);
	});

	it("an omitted `wait` leaves an existing park alone, so a park-blind heartbeat cannot erase one", async () => {
		const { env, d1 } = withRun({ runId: "r", startedAt: NOW - 60_000, waitingReason: "human" });
		await recordLiveness(env, "r", NOW);
		expect(readRow(d1, "r").waiting_reason).toBe("human");
	});

	it("an explicit null CLEARS the park", async () => {
		const { env, d1 } = withRun({ runId: "r", startedAt: NOW - 60_000, waitingReason: "human", waitingUntil: NOW });
		await recordLiveness(env, "r", NOW, null);
		const row = readRow(d1, "r");
		expect(row.waiting_reason).toBeNull();
		expect(row.waiting_until).toBeNull();
	});
});

describe("countInterruption — a bound that survives the replay it bounds (#583)", () => {
	it("increments durably and returns the new total", async () => {
		const { env } = withRun({ runId: "r", startedAt: NOW - 60_000 });
		expect(await countInterruption(env, "r")).toBe(1);
		expect(await countInterruption(env, "r")).toBe(2);
	});

	it("returns 0 for a run with no row, so a caller cannot resume without a bound", async () => {
		const { env } = withRun({ runId: "r", startedAt: NOW - 60_000 });
		expect(await countInterruption(env, "missing")).toBe(0);
	});
});

describe("the view carries the three facts apart", () => {
	it("reads liveness, the park and the interruption count back off the row", async () => {
		const { env } = withRun({
			runId: "r",
			startedAt: NOW - 60_000,
			lastProgressAt: NOW - 60_000,
			lastAliveAt: NOW,
			waitingReason: "engine_limit",
			waitingUntil: NOW + 1000,
		});
		const view = await getLoopRun(env, USER, "r");
		expect(view?.lastAliveAt).toBe(NOW);
		expect(view?.waitingReason).toBe("engine_limit");
		expect(view?.waitingUntil).toBe(NOW + 1000);
		expect(view?.interruptions).toBe(0);
	});
});
