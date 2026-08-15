import { describe, expect, it } from "vitest";
import { actsInWindow, recentActsForInstances, recentRunsForInstances, recentWorkForInstances } from "./instance-work.js";
import { D1_MAX_COMPOUND_TERMS } from "./sql.js";
import type { Env } from "../types.js";

/** D1 stub that COUNTS prepare() calls — the query-cost claim is the thing that silently regresses. */
function stubEnv(rows: unknown[] = []) {
	const sqls: string[] = [];
	const binds: unknown[][] = [];
	const env = {
		DB: {
			prepare(sql: string) {
				sqls.push(sql);
				return {
					bind(...args: unknown[]) {
						binds.push(args);
						return { async all() { return { results: rows }; } };
					},
				};
			},
		},
	} as unknown as Env;
	return { env, sqls, binds };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `inst-${i}`);

/** The compound terms of one statement. `UNION ALL` joins them, so terms = joins + 1. */
const branchesOf = (sql: string) => sql.split("UNION ALL");

/** The three cross-instance readers, with the bind slots their instance ids start at. */
const readers = [
	{ name: "recentWorkForInstances", read: recentWorkForInstances, firstIdParam: 3, lead: 2 },
	{ name: "recentRunsForInstances", read: recentRunsForInstances, firstIdParam: 3, lead: 2 },
	// `?3` is the bound event name, so acts start one slot later.
	{ name: "recentActsForInstances", read: recentActsForInstances, firstIdParam: 4, lead: 3 },
] as const;

describe("the compound-SELECT ceiling — every statement stays under D1's limit (#434)", () => {
	// D1 sets SQLITE_MAX_COMPOUND_SELECT to 5 (measured against production in #423). The sixth
	// branch is a PARSE failure, so the statement never executes once — and every consumer wraps
	// these reads in `.catch(() => [])`, so a supervisor with six subordinates was told, with
	// complete confidence, that its whole team was idle.
	//
	// This replaces an "issues EXACTLY ONE statement for 12 subordinates" assertion, which pinned
	// the broken shape as if it were the design. The anti-fan-out guarantee it was defending is
	// kept below as ceil(n/5) — bounded and sub-linear, never one statement per instance.
	for (const { name, read, firstIdParam, lead } of readers) {
		for (const n of [5, 6, 12]) {
			const stmts = Math.ceil(n / D1_MAX_COMPOUND_TERMS);
			it(`${name}: ${n} subordinates → ${stmts} statement${stmts === 1 ? "" : "s"}, none over the ceiling`, async () => {
				const { env, sqls, binds } = stubEnv();
				await read(env, "u1", ids(n));

				expect(sqls).toHaveLength(Math.ceil(n / D1_MAX_COMPOUND_TERMS));
				for (const sql of sqls) expect(branchesOf(sql).length).toBeLessThanOrEqual(D1_MAX_COMPOUND_TERMS);
				// No id is dropped by the chunking: the branches still add up to the whole team.
				expect(sqls.reduce((t, sql) => t + branchesOf(sql).length, 0)).toBe(n);

				// Parameter numbering is RE-BASED per chunk — each statement carries its own bind
				// array, so its ids restart at the same first slot. A running offset would read
				// another instance's rows into this one's answer, silently.
				const all = ids(n);
				for (let c = 0; c < sqls.length; c++) {
					const chunk = all.slice(c * D1_MAX_COMPOUND_TERMS, (c + 1) * D1_MAX_COMPOUND_TERMS);
					for (let j = 0; j < chunk.length; j++) expect(sqls[c]).toContain(`instance_id = ?${firstIdParam + j}`);
					expect(binds[c].slice(lead)).toEqual(chunk);
					expect(binds[c][0]).toBe("u1"); // ?1 is the owner in every chunk
				}
			});
		}
	}

	it("keeps the per-branch LIMIT bound, not spliced, in every chunk", async () => {
		// The whole point of the union (see the docstring): moving the limit to the merged set
		// returns the globally newest rows and a supervisor reads a team of one. And the cap is a
		// runtime value, so it stays a parameter rather than text spliced into each branch (#327).
		const { env, sqls, binds } = stubEnv();
		await recentWorkForInstances(env, "u1", ids(12), 4);
		for (const sql of sqls) for (const b of branchesOf(sql)) expect(b).toContain("LIMIT ?2");
		for (const bind of binds) expect(bind[1]).toBe(4);
	});
});

describe("recentWorkForInstances / recentRunsForInstances — cost is sub-linear in fan-out", () => {
	it("gives each subordinate its OWN limit, so one busy agent can't crowd out eleven", async () => {
		// A flat `IN (…) ORDER BY updated_at DESC LIMIT n` returns the globally newest n rows —
		// so a supervisor with one chatty subordinate sees a team of one. Per-instance branches.
		const { env, sqls, binds } = stubEnv();
		await recentWorkForInstances(env, "u1", ids(3), 4);
		const branches = sqls[0].split("UNION ALL");
		expect(branches).toHaveLength(3);
		// One BOUND limit shared by every branch (#327) — the cap is a runtime value, so it is a
		// parameter rather than text spliced into each branch.
		for (const b of branches) expect(b).toContain("LIMIT ?2");
		expect(binds[0][1]).toBe(4);
	});

	it("filters hidden = 0 — a cleared card must not resurface", async () => {
		// Migration 0019 added `hidden` so a human can dismiss a finished card. Omitting it
		// resurrects everything they have ever cleared, on the supervisor's summary.
		const { env, sqls } = stubEnv();
		await recentWorkForInstances(env, "u1", ids(2));
		expect(sqls[0]).toContain("hidden = 0");
	});

	it("scopes every branch to the owner as well as the instance", async () => {
        const { env, sqls, binds } = stubEnv();
		await recentWorkForInstances(env, "u1", ids(2));
		expect(sqls[0]).toContain("user_id = ?1");
		expect(binds[0][0]).toBe("u1");
		expect(binds[0].slice(2)).toEqual(["inst-0", "inst-1"]); // ?2 is the bound limit
	});

	it("issues NO query at all for an empty id list", async () => {
		// An empty UNION ALL is a syntax error, and a supervisor with no links is ordinary.
		const a = stubEnv();
		await expect(recentWorkForInstances(a.env, "u1", [])).resolves.toEqual([]);
		expect(a.sqls).toHaveLength(0);

		const b = stubEnv();
		await expect(recentRunsForInstances(b.env, "u1", [])).resolves.toEqual([]);
		expect(b.sqls).toHaveLength(0);
	});

	it("clamps the per-instance limit so one call can't become an unbounded read", async () => {
		const hi = stubEnv();
		await recentWorkForInstances(hi.env, "u1", ids(1), 9999);
		expect(hi.binds[0][1]).toBe(25);

		const lo = stubEnv();
		await recentWorkForInstances(lo.env, "u1", ids(1), 0);
		expect(lo.binds[0][1]).toBe(1);
	});
});

describe("recentWorkForInstances — payload handling", () => {
	const row = (over: Record<string, unknown> = {}) => ({
		instance_id: "i1",
		id: "t1",
		type: "delegation",
		status: "running",
		payload: JSON.stringify({ title: "Delegated: green the suite", description: "step 3" }),
		updated_at: "2026-08-05T10:00:00.000Z",
		...over,
	});

	it("maps a card to its title + detail", async () => {
		const { env } = stubEnv([row()]);
		const [w] = await recentWorkForInstances(env, "u1", ["i1"]);
		expect(w).toMatchObject({ instanceId: "i1", kind: "delegation", status: "running", title: "Delegated: green the suite", detail: "step 3" });
	});

	it("survives a corrupt payload — the card still carries its type and status", async () => {
		// A broken payload must not hide work from a supervisor; type+status is still actionable.
		const { env } = stubEnv([row({ payload: "{not json" })]);
		const [w] = await recentWorkForInstances(env, "u1", ["i1"]);
		expect(w).toMatchObject({ kind: "delegation", status: "running", title: "delegation", detail: "" });
	});

	it("falls back through description → output.detail → result → error", async () => {
		const { env } = stubEnv([
			row({ id: "a", payload: JSON.stringify({ output: { detail: "from output" } }) }),
			row({ id: "b", payload: JSON.stringify({ result: "from result" }) }),
			row({ id: "c", payload: JSON.stringify({ error: "from error" }) }),
		]);
		const out = await recentWorkForInstances(env, "u1", ["i1"]);
		expect(out.map((w) => w.detail)).toEqual(["from output", "from result", "from error"]);
	});
});

describe("recentRunsForInstances — the run shape", () => {
	it("carries the staleness signal and tolerates a pre-0067 null", async () => {
		const { env } = stubEnv([
			{ instance_id: "i1", run_id: "r1", objective: "o", status: "running", stop_reason: null, detail: null,
			  iteration: 3, max_iterations: 10, started_at: 100, finished_at: null, last_progress_at: 900 },
			{ instance_id: "i1", run_id: "r0", objective: "o", status: "running", stop_reason: null, detail: null,
			  iteration: 0, max_iterations: 10, started_at: 100, finished_at: null, last_progress_at: null },
		]);
		const out = await recentRunsForInstances(env, "u1", ["i1"]);
		expect(out[0].lastProgressAt).toBe(900);
		expect(out[1].lastProgressAt).toBeNull(); // rows written before the column existed
	});
});

const actRow = (over: Record<string, unknown> = {}) => ({
	instance_id: "i1",
	trace_id: "run-1",
	message: "merged a pull request #42",
	context: JSON.stringify({ act: "pr.merge", command: "gh pr merge 42", irreversible: true, ok: true }),
	ts: 500,
	...over,
});

describe("recentActsForInstances — what each subordinate actually DID (#294)", () => {
	it("reads the GENERIC event name, so supervision never learns a domain vocabulary", async () => {
		// This module is deliberately forbidden from knowing a coding Engine exists (the coupling
		// migration 0063 removed). Keying on `coding.act` would smuggle it back in and any other
		// subsystem recording an act would then be invisible to a supervisor.
		const { env, sqls, binds } = stubEnv();
		await recentActsForInstances(env, "u1", ids(2));
		// Bound rather than spliced into the WHERE (#327); the name itself is what this pins.
		expect(binds[0]).toContain("act.consequential");
		expect(sqls[0]).not.toMatch(/coding/);
	});

	it("gives each subordinate its own limit — the crowded-out row is somebody's merge", async () => {
		// The same reason `recentWorkForInstances` uses UNION ALL, with a sharper consequence: a flat
		// global LIMIT would drop one agent's unreviewed merge because another agent was busier.
		const { env, sqls, binds } = stubEnv();
		await recentActsForInstances(env, "u1", ids(4), 3);
		expect(sqls).toHaveLength(1);
		const branches = sqls[0].split("UNION ALL");
		expect(branches).toHaveLength(4);
		for (const b of branches) expect(b).toContain("LIMIT ?2");
		expect(binds[0][1]).toBe(3);
	});

	it("scopes to the owner as well as the instance", async () => {
		const { env, sqls, binds } = stubEnv();
		await recentActsForInstances(env, "u1", ids(2));
		expect(sqls[0]).toContain("user_id = ?1");
		expect(binds[0][0]).toBe("u1");
	});

	it("unpacks the act out of the trace row's context JSON", async () => {
		const { env } = stubEnv([actRow()]);
		const [a] = await recentActsForInstances(env, "u1", ["i1"]);
		expect(a).toMatchObject({ kind: "pr.merge", irreversible: true, command: "gh pr merge 42", traceId: "run-1", at: 500 });
	});

	it("still yields the act when the context JSON is unreadable", async () => {
		// A dropped row is a silently missing merge — the exact failure the record exists to end. A
		// row with an unusable `context` still carries the sentence that names the act.
		const { env } = stubEnv([actRow({ context: "{not json" })]);
		const [a] = await recentActsForInstances(env, "u1", ["i1"]);
		expect(a.summary).toBe("merged a pull request #42");
		expect(a.kind).toBe("unknown");
		expect(a.irreversible).toBe(false); // never ASSUMED true from an unreadable row
	});

	/**
	 * #594 — the payload has to carry the field two legends tell the model to read.
	 *
	 * `subordinate-payload.ts`'s `STATUS_LEGEND` and `check_delegation`'s `actsLegend` have both
	 * said, for months: "an act with `ok: false` FAILED and one with `ok: null` was not observed to
	 * succeed". `ActItem` never declared `ok` and `toActItem` never read it, though
	 * `engine-acts.ts` writes it into `context` at capture. A model instructed to check a key that
	 * is ABSENT reads the absence as "fine" — which inverts the default for an unobserved act, in
	 * exactly the direction the legend exists to prevent.
	 */
	describe("carries `ok` — the outcome both supervision legends promise (#594)", () => {
		it("passes an observed success through", async () => {
			const { env } = stubEnv([actRow()]);
			expect((await recentActsForInstances(env, "u1", ["i1"]))[0]?.ok).toBe(true);
		});

		it("passes an observed FAILURE through as false, not as absent", async () => {
			const { env } = stubEnv([actRow({ context: JSON.stringify({ act: "pr.merge", ok: false }) })]);
			expect((await recentActsForInstances(env, "u1", ["i1"]))[0]?.ok).toBe(false);
		});

		it("reports an UNOBSERVED outcome as null — never as false, and never as fine", async () => {
			// Three distinct states, and the third is real: only a stream-json engine reports an
			// outcome at all. "We did not see" must not collapse into either of the other two.
			for (const context of [JSON.stringify({ act: "pr.merge" }), JSON.stringify({ act: "pr.merge", ok: "yes" }), "{not json"]) {
				const { env } = stubEnv([actRow({ context })]);
				expect((await recentActsForInstances(env, "u1", ["i1"]))[0]?.ok, context).toBeNull();
			}
		});

		it("agrees with the sentence in `summary`, which already encoded the same outcome", async () => {
			// `describeEngineAct` appends " — FAILED" / " — outcome not observed", so the outcome
			// was never lost, only unreadable as a field. The two must not now disagree.
			const { env } = stubEnv([actRow({ message: "merged a pull request #42 — FAILED", context: JSON.stringify({ act: "pr.merge", ok: false }) })]);
			const [a] = await recentActsForInstances(env, "u1", ["i1"]);
			expect(a.ok).toBe(false);
			expect(a.summary).toContain("FAILED");
		});

		it("is on the window read too, so `check_delegation` and `subordinate_status` agree", async () => {
			const { env } = stubEnv([actRow({ context: JSON.stringify({ act: "pr.merge", ok: false }) })]);
			expect((await actsInWindow(env, "u1", "i1", 0, 1000))[0]?.ok).toBe(false);
		});
	});

	it("issues no query at all for an empty id list", async () => {
		const { env, sqls } = stubEnv();
		await expect(recentActsForInstances(env, "u1", [])).resolves.toEqual([]);
		expect(sqls).toHaveLength(0);
	});
});

describe("actsInWindow — one run's acts", () => {
	it("bounds by TIME, not by trace id", async () => {
		// A console terminal poll can drain a run's acts before the Pilot does, and stamps the
		// session id when it does. Keying on trace_id would return a run's acts only when nobody had
		// the terminal open — arbitrary, and backwards: the unwatched run is the one that matters.
		const { env, sqls, binds } = stubEnv([actRow()]);
		await actsInWindow(env, "u1", "i1", 100, 900);
		expect(sqls[0]).toContain("ts >= ?3 AND ts <= ?4");
		expect(binds[0]).toEqual(["i1", "u1", 100, 900, "act.consequential", 25]);
	});

	it("returns the window CHRONOLOGICALLY, so the run reads as a sequence", async () => {
		const { env, sqls } = stubEnv([actRow()]);
		await actsInWindow(env, "u1", "i1", 0, 1);
		expect(sqls[0]).toContain("ORDER BY ts ASC");
	});

	it("clamps the row cap so a long run cannot return an unbounded read", async () => {
		const { env, binds } = stubEnv();
		await actsInWindow(env, "u1", "i1", 0, 1, 100_000);
		expect(binds[0][5]).toBe(100);
	});
});
