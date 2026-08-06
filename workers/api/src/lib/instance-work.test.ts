import { describe, expect, it } from "vitest";
import { actsInWindow, recentActsForInstances, recentRunsForInstances, recentWorkForInstances } from "./instance-work.js";
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

describe("recentWorkForInstances / recentRunsForInstances — cost is constant in fan-out", () => {
	it("issues EXACTLY ONE statement for 12 subordinates", async () => {
		// MAX_SUBORDINATES is 12. Naive per-instance looping would be 12 round trips each, 24
		// total, on the hot path of a tool the Lead is told to call first. This is the assertion
		// that keeps it at 2.
		const a = stubEnv();
		await recentWorkForInstances(a.env, "u1", ids(12));
		expect(a.sqls).toHaveLength(1);

		const b = stubEnv();
		await recentRunsForInstances(b.env, "u1", ids(12));
		expect(b.sqls).toHaveLength(1);
	});

	it("gives each subordinate its OWN limit, so one busy agent can't crowd out eleven", async () => {
		// A flat `IN (…) ORDER BY updated_at DESC LIMIT n` returns the globally newest n rows —
		// so a supervisor with one chatty subordinate sees a team of one. Per-instance branches.
		const { env, sqls } = stubEnv();
		await recentWorkForInstances(env, "u1", ids(3), 4);
		const branches = sqls[0].split("UNION ALL");
		expect(branches).toHaveLength(3);
		for (const b of branches) expect(b).toContain("LIMIT 4");
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
		expect(binds[0].slice(1)).toEqual(["inst-0", "inst-1"]);
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
		expect(hi.sqls[0]).toContain("LIMIT 25");

		const lo = stubEnv();
		await recentWorkForInstances(lo.env, "u1", ids(1), 0);
		expect(lo.sqls[0]).toContain("LIMIT 1");
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
		const { env, sqls } = stubEnv();
		await recentActsForInstances(env, "u1", ids(2));
		expect(sqls[0]).toContain("act.consequential");
		expect(sqls[0]).not.toMatch(/coding/);
	});

	it("gives each subordinate its own limit — the crowded-out row is somebody's merge", async () => {
		// The same reason `recentWorkForInstances` uses UNION ALL, with a sharper consequence: a flat
		// global LIMIT would drop one agent's unreviewed merge because another agent was busier.
		const { env, sqls } = stubEnv();
		await recentActsForInstances(env, "u1", ids(4), 3);
		expect(sqls).toHaveLength(1);
		const branches = sqls[0].split("UNION ALL");
		expect(branches).toHaveLength(4);
		for (const b of branches) expect(b).toContain("LIMIT 3");
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
		expect(binds[0]).toEqual(["i1", "u1", 100, 900]);
	});

	it("returns the window CHRONOLOGICALLY, so the run reads as a sequence", async () => {
		const { env, sqls } = stubEnv([actRow()]);
		await actsInWindow(env, "u1", "i1", 0, 1);
		expect(sqls[0]).toContain("ORDER BY ts ASC");
	});

	it("clamps the row cap so a long run cannot return an unbounded read", async () => {
		const { env, sqls } = stubEnv();
		await actsInWindow(env, "u1", "i1", 0, 1, 100_000);
		expect(sqls[0]).toContain("LIMIT 100");
	});
});
