import { describe, expect, it } from "vitest";
import { recentRunsForInstances, recentWorkForInstances } from "./instance-work.js";
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
