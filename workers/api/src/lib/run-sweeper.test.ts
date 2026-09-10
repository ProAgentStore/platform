import { describe, expect, it } from "vitest";
import { CANCEL_ENFORCE_MS, STALE_RUN_MS, sweepStaleRuns } from "./run-sweeper.js";
import { PARK_LIMIT_MS } from "./work-report.js";
import type { Env } from "../types.js";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");

/**
 * D1 stub: SELECTs return the rows queued per PASS, UPDATEs are recorded.
 *
 * Keyed on each pass's own predicate rather than on the table (#790). `sweepStaleRuns` now makes
 * three different SELECTs against `agent_loop_runs` — the cancel enforcer, the wedged-park reap and
 * the 3h staleness sweep — and a stub that answered all of them with the same rows would fire every
 * pass on every test, which is exactly what it did the first time this file was run after the
 * change.
 */
function stubEnv(
	open: {
		loop?: string[];
		pipeline?: string[];
		cancelling?: string[];
		parked?: string[];
		loopSessions?: Record<string, string | null>;
	} = {},
) {
	const updates: Array<{ sql: string; args: unknown[] }> = [];
	const selects: Array<{ sql: string; args: unknown[] }> = [];
	/** Which pass is asking. The predicates are disjoint, which is what makes this readable. */
	const passFor = (sql: string): string[] | undefined => {
		if (!sql.includes("agent_loop_runs")) return open.pipeline;
		if (sql.includes("cancel_requested = 1")) return open.cancelling;
		if (sql.includes("waiting_reason = ?1")) return open.parked;
		return open.loop;
	};
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async all() {
								selects.push({ sql, args });
								return {
									results: (passFor(sql) ?? []).map((run_id) => ({
										run_id,
										instance_id: `inst-${run_id}`,
										user_id: `user-${run_id}`,
										session_id: open.loopSessions?.[run_id] ?? null,
									})),
								};
							},
							async run() {
								updates.push({ sql, args });
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, updates, selects };
}

/** The 3h staleness pass's own SELECT, told apart from the two #790 passes above it. */
const stalenessSelect = (x: { sql: string }) =>
	x.sql.includes("agent_loop_runs") && !x.sql.includes("cancel_requested = 1") && !x.sql.includes("waiting_reason = ?1");

const NOTHING_SWEPT = { loopRuns: 0, pipelineRuns: 0, cancelledRuns: 0, wedgedParks: 0 };

describe("sweepStaleRuns — a run nobody will ever close", () => {
	it("closes a silent loop run as FAILED, not escalated", async () => {
		// `escalated` would put it in "Needs you" and imply a human can unblock it by answering a
		// question. Nothing about a dead workflow is answerable — `failed` is the honest word.
		const { env, updates } = stubEnv({ loop: ["r1"] });
		const out = await sweepStaleRuns(env, NOW);
		expect(out.loopRuns).toBe(1);
		const u = updates.find((x) => x.sql.includes("agent_loop_runs"));
		// The status and reason are BOUND since #790 — three passes share one `closeRuns`, and the
		// status is derived from the reason through `statusFor` so the two cannot disagree.
		expect(u?.args[0]).toBe("failed");
		expect(u?.args[1]).toBe("failed");
		expect(u?.args).toContain(NOW); // finished_at, ms epoch like the column
		expect(u?.args).toContain("r1");
	});

	it("marks a silent pipeline run INTERRUPTED — the word that vocabulary already has", async () => {
		const { env, updates } = stubEnv({ pipeline: ["p1"] });
		const out = await sweepStaleRuns(env, NOW);
		expect(out.pipelineRuns).toBe(1);
		const u = updates.find((x) => x.sql.includes("pipeline_runs"));
		expect(u?.sql).toContain("status = 'interrupted'");
	});

	it("measures loop-run quiet from LIVENESS, falling back to progress and then to started_at", async () => {
		// The SAME rule `summarizeSubordinates` uses. If the sweeper and the supervisor disagreed
		// about what "quiet" means, a run could read as fine to one and dead to the other.
		//
		// `last_alive_at` first since 0127 (#580): this predicate is the reason the pause tick wrote
		// `last_progress_at` on a timer, which is what made a parked run's progress timestamp lie.
		// The fallback chain is what keeps a pre-0127 row behaving exactly as it did.
		// `run-liveness.test.ts` asserts the EFFECT of this on real rows; this asserts its shape.
		const { env, selects } = stubEnv({ loop: [] });
		await sweepStaleRuns(env, NOW);
		const s = selects.find(stalenessSelect);
		expect(s?.sql).toContain("COALESCE(last_alive_at, last_progress_at, started_at)");
		expect(s?.args[0]).toBe(NOW - STALE_RUN_MS);
	});

	it("only ever touches rows still marked running", async () => {
		// The UPDATE re-checks the status it selected on. Without it, a run that closed itself in
		// the gap between the SELECT and the UPDATE would be overwritten with 'failed' — turning a
		// completed run into a failure, which is worse than the stranded row being fixed.
		const { env, updates } = stubEnv({ loop: ["r1"], pipeline: ["p1"] });
		await sweepStaleRuns(env, NOW);
		expect(updates).toHaveLength(2);
		for (const u of updates) expect(u.sql).toContain("WHERE status = 'running'");
	});

	it("issues NO update when nothing is stale", async () => {
		const { env, updates } = stubEnv();
		await expect(sweepStaleRuns(env, NOW)).resolves.toEqual(NOTHING_SWEPT);
		expect(updates).toHaveLength(0);
	});

	it("bounds one pass so a backlog drains over several minutes", async () => {
		const { env, selects } = stubEnv();
		await sweepStaleRuns(env, NOW);
		// The park pass binds four values, so its LIMIT is `?4`; every other pass binds two.
		for (const s of selects) expect(s.sql).toMatch(/LIMIT \?[24]/);
	});

	it("waits far longer than the longest LEGITIMATE silence", async () => {
		// A Pilot parked in a human handoff is silent for up to HANDOFF_WAIT_POLLS × 5s = 15 min,
		// and can take several such waits across its rounds. Sweeping a live run tells a supervisor
		// its subordinate failed while it is still working — the expensive direction of the error.
		expect(STALE_RUN_MS).toBeGreaterThanOrEqual(60 * 60_000);
		expect(STALE_RUN_MS).toBe(3 * 60 * 60_000);
	});
});

describe("a dead run's BOARD CARD closes with it (#553 AC 3)", () => {
	it("closes the coding card of every stale run that had a session", async () => {
		// `csess_22d08431` sat in "Running" 16 HOURS after its run died: the sweeper closed the run
		// row and nothing touched the card, so the board — the surface somebody actually looks at —
		// showed an in-flight job for a workflow that no longer existed.
		const { env, updates } = stubEnv({ loop: ["r1", "r2"], loopSessions: { r1: "csess_a", r2: null } });
		await sweepStaleRuns(env, NOW);
		const cards = updates.filter((u) => u.sql.includes("instance_runtime_tasks"));
		// EXACTLY one: `r2` is a chat or pipeline run with no `session_id`, and inventing a card id
		// for it would patch a row belonging to something else.
		expect(cards.length, "one card write, for the one run that had a coding session").toBe(1);
		expect(cards[0].args).toEqual(["failed", "inst-r1", "user-r1", "csess-csess_a"]);
	});

	it("cannot overwrite a card the run itself already closed", async () => {
		// The sweeper is a backstop, not an authority: if the workflow turns out to be alive after
		// all, its own terminal write wins. Same rule this file's header states for the run rows.
		const { env, updates } = stubEnv({ loop: ["r1"], loopSessions: { r1: "csess_a" } });
		await sweepStaleRuns(env, NOW);
		expect(updates.find((u) => u.sql.includes("instance_runtime_tasks"))?.sql).toContain("status IN ('running', 'needs_human')");
	});

	it("writes no card at all when nothing was stale", async () => {
		const { env, updates } = stubEnv({ loop: [] });
		await sweepStaleRuns(env, NOW);
		expect(updates.filter((u) => u.sql.includes("instance_runtime_tasks"))).toHaveLength(0);
	});
});


/**
 * #790 symptom 2 — a requested cancel that nothing was left alive to read.
 *
 * `requestCancel` writes a flag and the flag's only two readers live inside the running workflow
 * (`capture()` and the pause `tick()`). A workflow that has thrown for a journal replay executes
 * neither, so the incident's run reported "a cancel has been requested" across three polls over two
 * minutes and never moved. This pass is the independent enforcer that was missing.
 */
describe("the cancel enforcer (#790)", () => {
	it("lands a cancel nothing was alive to read, as CANCELLED", async () => {
		// `cancelled`, not `failed`: the owner asked for this. Recording their own stop as a failure
		// would be a worse lie than the stuck row it replaces.
		const { env, updates } = stubEnv({ cancelling: ["r1"] });
		const out = await sweepStaleRuns(env, NOW);
		expect(out.cancelledRuns).toBe(1);
		const u = updates.find((x) => x.sql.includes("agent_loop_runs"));
		expect(u?.args[0]).toBe("cancelled");
		expect(u?.args[1]).toBe("cancelled");
		expect(String(u?.args[2])).toContain("asked this run to stop");
	});

	it("requires BOTH an old cancel and a dead heartbeat", async () => {
		// The two-condition rule is the whole design. A run in a long engine turn keeps heartbeating
		// from the capture loop, and its own cooperative stop must be allowed to land — killing it
		// from outside strands the budget reservation the in-flight step holds, which is precisely
		// what `requestCancel` is cooperative in order to avoid.
		const { env, selects } = stubEnv({ cancelling: [] });
		await sweepStaleRuns(env, NOW);
		const s = selects.find((x) => x.sql.includes("cancel_requested = 1"));
		expect(s?.sql).toContain("COALESCE(cancel_requested_at, started_at) < ?1");
		expect(s?.sql).toContain("COALESCE(last_alive_at, last_progress_at, started_at) < ?1");
		expect(s?.args[0]).toBe(NOW - CANCEL_ENFORCE_MS);
	});

	it("only touches rows still running, and closes the board card too", async () => {
		const { env, updates } = stubEnv({ cancelling: ["r1"], loopSessions: { r1: "csess_a" } });
		await sweepStaleRuns(env, NOW);
		expect(updates.find((u) => u.sql.includes("agent_loop_runs"))?.sql).toContain("WHERE status = 'running'");
		const card = updates.find((u) => u.sql.includes("instance_runtime_tasks"));
		expect(card?.args).toEqual(["cancelled", "inst-r1", "user-r1", "csess-csess_a"]);
	});

	it("gives a live driver far more time than it needs to answer by itself", async () => {
		// Both in-workflow readers run far more often than this — the capture poll every cycle, the
		// pause tick about once a minute — so five minutes is many chances, not a race.
		expect(CANCEL_ENFORCE_MS).toBe(5 * 60_000);
	});
});

/**
 * #790 symptom 1 — a park that never ends.
 *
 * The 3h staleness pass cannot see these: a parked run keeps `last_alive_at` FRESH on purpose
 * (0127), which is what lets a legitimate six-hour usage-limit park survive the cutoff. That
 * protection is right, and it also means a run that parks forever while still ticking is invisible
 * to every pass that existed.
 */
describe("the wedged-park reap (#790)", () => {
	it("reaps a park past what its reason is worth, as INTERRUPTED", async () => {
		// `interrupted` (#546): the platform cut the invocation off and the objective never reported
		// either way. `statusFor` puts that in `needs_human` rather than `failed`, which is the
		// honest column — the run may have pushed commits before it wedged.
		const { env, updates } = stubEnv({ parked: ["r1"] });
		const out = await sweepStaleRuns(env, NOW);
		expect(out.wedgedParks).toBeGreaterThan(0);
		const u = updates.find((x) => x.sql.includes("agent_loop_runs"));
		expect(u?.args[0]).toBe("needs_human");
		expect(u?.args[1]).toBe("interrupted");
		expect(String(u?.args[2])).toContain("never came back");
	});

	it("asks once per park reason, with that reason's OWN budget", async () => {
		// One statement per reason rather than a CASE, so the cutoff bound into the query is the same
		// value `runHealth` reads for that reason — the sweeper must not be able to reap a run the
		// platform is still calling `waiting`.
		const { env, selects } = stubEnv({ parked: [] });
		await sweepStaleRuns(env, NOW);
		const parkSelects = selects.filter((x) => x.sql.includes("waiting_reason = ?1"));
		expect(parkSelects).toHaveLength(Object.keys(PARK_LIMIT_MS).length);
		for (const s of parkSelects) {
			const reason = s.args[0] as keyof typeof PARK_LIMIT_MS;
			expect(s.args[1], `cutoff for ${reason}`).toBe(NOW - PARK_LIMIT_MS[reason]);
		}
	});

	it("leaves a park alone while its published deadline is still in the future", async () => {
		// When the platform has stated when a park ends it KNOWS, and a budget guessed from a table
		// has no business overriding a fact. Same exclusion `parkOverrun` makes.
		const { env, selects } = stubEnv({ parked: [] });
		await sweepStaleRuns(env, NOW);
		const s = selects.find((x) => x.sql.includes("waiting_reason = ?1"));
		expect(s?.sql).toContain("(waiting_until IS NULL OR waiting_until < ?3)");
		expect(s?.args[2]).toBe(NOW);
	});

	it("dates the park from parked_since, falling back through the heartbeat", async () => {
		// `parked_since` is the only column not rewritten by the ticks a park generates. The fallback
		// keeps a pre-0150 row bounded from a timestamp at least as old as its park, never newer.
		const { env, selects } = stubEnv({ parked: [] });
		await sweepStaleRuns(env, NOW);
		expect(selects.find((x) => x.sql.includes("waiting_reason = ?1"))?.sql).toContain(
			"COALESCE(parked_since, last_alive_at, last_progress_at, started_at)",
		);
	});
});
