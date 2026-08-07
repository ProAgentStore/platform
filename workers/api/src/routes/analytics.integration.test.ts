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

interface Opts {
	/** Rows the funnel table returns for this agent. */
	funnel?: Array<{ event: string; total: number }>;
	subscribes?: number;
}

function buildApp(opts: Opts = {}) {
	const sqls: string[] = [];
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
								if (sql.includes("event = 'subscribe'")) return { count: opts.subscribes ?? 0 };
								return { count: 0 };
							},
							async all() {
								if (sql.includes("FROM agent_funnel_daily")) return { results: opts.funnel ?? [] };
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
