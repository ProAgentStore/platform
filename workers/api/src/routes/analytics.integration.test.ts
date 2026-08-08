import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { analyticsRoutes } from "./analytics.js";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

/**
 * INTEGRATION test for `GET /v1/agents/:id/analytics`, drilling on the funnel (#383).
 *
 * The route reported `views` and `trials` off `usage`, where neither could ever be
 * non-zero — nothing wrote `trial_start`, and the `view` insert violated a foreign key on
 * every request. What is worth pinning is not the arithmetic but the SOURCE: the two
 * counters must be read from the table something actually writes to.
 */

const SECRET = "analytics-integration-secret";

/** One row of the `ai_usage` ledger, in the two columns that decide who it belongs to. */
interface LedgerRow {
	id: string;
	agent_id: string | null;
	instance_id: string | null;
	model: string;
	kind: string;
	created_at: string;
}

interface Opts {
	/** Rows the funnel table returns for this agent. */
	funnel?: Array<{ event: string; total: number }>;
	subscribes?: number;
	/** Rows in `ai_usage`, for the AI-calls counter (#451). */
	ledger?: LedgerRow[];
	/** instance id -> the agent it belongs to, i.e. what `agent_instances` would resolve. */
	instances?: Record<string, string>;
}

function buildApp(opts: Opts = {}) {
	const sqls: string[] = [];
	const ledger = opts.ledger ?? [];
	const instances = opts.instances ?? {};

	/**
	 * Model what D1 would actually return for the query as WRITTEN, so the shape of the
	 * predicate changes the answer. A query that only matches `agent_id` sees the 14% of the
	 * real ledger that carries one; the instance fallback is what makes it complete. Hard-coding
	 * a count here would let the naive query pass (#451).
	 */
	const ledgerRowsFor = (sql: string, agentId: string) => {
		const resolvesInstances = sql.includes("FROM agent_instances");
		return ledger.filter(
			(r) =>
				r.agent_id === agentId ||
				(resolvesInstances && r.instance_id !== null && instances[r.instance_id] === agentId),
		);
	};

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare(sql: string) {
				sqls.push(sql);
				return {
					bind(..._args: unknown[]) {
						return {
							async first() {
								if (sql.includes("FROM users")) return { suspended: 0 };
								if (sql.includes("FROM agents")) return { id: "a1", owner_id: "u1" };
								if (sql.includes("FROM ai_usage")) return { count: ledgerRowsFor(sql, "a1").length };
								if (sql.includes("event = 'subscribe'")) return { count: opts.subscribes ?? 0 };
								return { count: 0 };
							},
							async all() {
								if (sql.includes("FROM agent_funnel_daily")) return { results: opts.funnel ?? [] };
								if (sql.includes("FROM ai_usage")) {
									// Only the columns the SELECT list names — a dropped column must not
									// reappear because the fixture happened to carry it.
									const cols = ["id", "model", "kind", "created_at", "duration_ms"].filter((col) =>
										new RegExp(`\\b${col}\\b`).test(sql.slice(0, sql.indexOf("FROM"))),
									);
									const rows = [...ledgerRowsFor(sql, "a1")]
										.sort((a, b) => b.created_at.localeCompare(a.created_at))
										.map((r) => Object.fromEntries(cols.map((col) => [col, (r as unknown as Record<string, unknown>)[col] ?? null])));
									return { results: rows };
								}
								return { results: [] };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", analyticsRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	const get = async (id: string, uid = "u1") =>
		app.request(`/v1/agents/${id}/analytics`, {
			headers: { Authorization: `Bearer ${await signSession(uid, SECRET, { roles: ["user"] })}` },
		}, env);
	return { get, sqls };
}

describe("GET /v1/agents/:id/analytics — funnel", () => {
	it("reads views + trials from agent_funnel_daily, never from `usage`", async () => {
		const { get, sqls } = buildApp({
			funnel: [
				{ event: "view", total: 128 },
				{ event: "trial_start", total: 9 },
			],
			subscribes: 3,
		});
		const res = await get("a1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { funnel: { views: number; trials: number; subscribes: number } };
		expect(body.funnel).toEqual({ views: 128, trials: 9, subscribes: 3 });

		expect(sqls.some((s) => s.includes("FROM agent_funnel_daily"))).toBe(true);
		// The two dead reads must be gone: `usage` has no 'view' row (the FK made that
		// impossible) and never had a 'trial_start' row at all.
		expect(sqls.some((s) => s.includes("event = 'view'"))).toBe(false);
		expect(sqls.some((s) => s.includes("event = 'trial_start'"))).toBe(false);
		// `subscribe` stays in `usage` — an authenticated act by a user that table records.
		expect(sqls.some((s) => s.includes("FROM usage") && s.includes("event = 'subscribe'"))).toBe(true);
	});

	it("403s a caller who does not own the agent", async () => {
		const { get } = buildApp();
		const res = await get("a1", "someone-else");
		expect(res.status).toBe(403);
	});
});

/**
 * The AI-calls counter (#451) — the same class of defect as the funnel above, one card over.
 *
 * `totalExecutions` and `recentExecutions` read `agent_executions`, which has one writer in the
 * whole API (`routes/run.ts`, the legacy direct-inference route) and held ZERO rows in production
 * on 2026-08-08. Every agent reported that it had never run, next to a chat count proving
 * otherwise.
 *
 * There are two wrong ways to fix it and this file exists to fail both:
 *
 *   1. Backfill `agent_executions` from the modern paths — five request-path INSERTs duplicating
 *      `ai_usage`'s columns. Caught by asserting the table is not read at all.
 *   2. `SELECT COUNT(*) FROM ai_usage WHERE agent_id = ?1` alone. Looks right, passes any test
 *      whose fixture happens to set `agent_id`, and sees 14% of the real ledger — 2,091 of 3,628
 *      rows carry only an `instance_id`. Caught by a fixture whose rows carry ONLY that.
 */
describe("GET /v1/agents/:id/analytics — AI calls", () => {
	const row = (over: Partial<LedgerRow>): LedgerRow => ({
		id: "l1",
		agent_id: null,
		instance_id: null,
		model: "claude-sonnet-4-6",
		kind: "chat",
		created_at: "2026-08-01T00:00:00Z",
		...over,
	});

	it("counts the ai_usage ledger, and never reads agent_executions", async () => {
		const { get, sqls } = buildApp({
			ledger: [
				row({ id: "l1", agent_id: "a1" }),
				row({ id: "l2", agent_id: "a1", kind: "pipeline" }),
				row({ id: "l3", agent_id: "other-agent" }),
			],
		});
		const res = await get("a1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { totalExecutions: number };
		expect(body.totalExecutions).toBe(2);

		expect(sqls.some((s) => s.includes("agent_executions"))).toBe(false);
		expect(sqls.some((s) => s.includes("FROM ai_usage"))).toBe(true);
	});

	it("still counts rows the ledger could only attribute to an instance", async () => {
		// `ai_usage.agent_id` is nullable — "some paths only know the instance" (migration 0048).
		// Not one of these rows carries it, and the count must still be 3.
		const { get } = buildApp({
			ledger: [
				row({ id: "l1", instance_id: "i1", kind: "coding" }),
				row({ id: "l2", instance_id: "i1", kind: "copilot" }),
				row({ id: "l3", instance_id: "i2", kind: "chat" }),
				row({ id: "l4", instance_id: "someone-elses", kind: "chat" }),
				row({ id: "l5", kind: "voice" }), // account-scoped: attributable to no agent, by nature
			],
			instances: { i1: "a1", i2: "a1", "someone-elses": "other-agent" },
		});
		const res = await get("a1");
		const body = (await res.json()) as { totalExecutions: number };
		expect(body.totalExecutions).toBe(3);
	});

	it("cannot be structurally zero for an agent with recorded activity", async () => {
		const { get } = buildApp({ ledger: [row({ agent_id: "a1" })] });
		const body = (await (await get("a1")).json()) as { totalExecutions: number };
		expect(body.totalExecutions).toBeGreaterThan(0);
	});

	it("lists recent calls newest-first, with kind in place of the duration nothing records", async () => {
		const { get } = buildApp({
			ledger: [
				row({ id: "old", agent_id: "a1", created_at: "2026-08-01T00:00:00Z" }),
				row({ id: "new", instance_id: "i1", kind: "coding", created_at: "2026-08-06T00:00:00Z" }),
			],
			instances: { i1: "a1" },
		});
		const body = (await (await get("a1")).json()) as {
			recentExecutions: Array<Record<string, unknown>>;
		};
		expect(body.recentExecutions.map((r) => r.id)).toEqual(["new", "old"]);
		expect(body.recentExecutions[0].kind).toBe("coding");
		// `ai_usage` has no duration column. The field is gone from the payload rather than
		// present-and-always-null, and no reader in `store/` ever consumed it.
		expect(body.recentExecutions[0]).not.toHaveProperty("duration_ms");
	});
});
