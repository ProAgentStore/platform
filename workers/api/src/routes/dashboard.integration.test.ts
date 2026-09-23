import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { dashboardRoutes } from "./dashboard.js";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

const SECRET = "dashboard-integration-secret";

/**
 * The usage dashboard's execution card must read the live AI ledger (#832).
 * `agent_executions` only records the retired direct-inference route, so production
 * has no rows there even for users with recorded current-runtime activity.
 */
describe("GET /v1/dashboard/usage — total AI calls", () => {
	it("counts ai_usage and never falls back to legacy agent_executions", async () => {
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
									if (sql.includes("FROM ai_usage")) return { count: 3 };
									return { count: 0 };
								},
								async all() {
									return { results: [] };
								},
							};
						},
					};
				},
			},
		} as unknown as Env;

		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/dashboard", dashboardRoutes);
		app.onError((err, c) => {
			if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
			throw err;
		});

		const response = await app.request("/v1/dashboard/usage", {
			headers: { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: ["user"] })}` },
		}, env);

		expect(response.status).toBe(200);
		expect((await response.json() as { totalExecutions: number }).totalExecutions).toBe(3);
		expect(sqls.some((sql) => sql.includes("FROM ai_usage") && sql.includes("user_id = ?1"))).toBe(true);
		expect(sqls.some((sql) => sql.includes("agent_executions"))).toBe(false);
	});
});
