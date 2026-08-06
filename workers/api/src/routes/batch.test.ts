import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { batchRoutes } from "./batch.js";
import type { Env } from "../types.js";

/**
 * `POST /v1/batch/bulk-visibility` is a SECOND door onto the public catalog. The smoke-test
 * guard (#65) was wired only onto `PUT /v1/agents/:id`, so a fixture the single-agent route
 * refused could still be published here in bulk — the exact way a catalog cleanup (#64) undoes
 * itself. These tests pin the guard to this route.
 */

const SECRET = "batch-test-secret";

type AgentRow = { id: string; owner_id: string; slug: string; name: string; description: string | null };

function buildApp(agents: AgentRow[]) {
	const writes: string[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							const ids = new Set(args as string[]);
							return { results: agents.filter((a) => ids.has(a.id)) };
						},
						async run() { writes.push(sql); return { meta: { changes: 1 } }; },
					};
				},
			};
		},
		async batch(stmts: unknown[]) { writes.push(`BATCH:${stmts.length}`); return []; },
	};
	const env = { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/batch", batchRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { app, env, writes };
}

const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["creator"] });

function post(app: Hono<{ Bindings: Env }>, env: Env, body: unknown, token: string) {
	return app.fetch(
		new Request("https://api.test/v1/batch/bulk-visibility", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		env,
	);
}

const REAL: AgentRow = { id: "a1", owner_id: "u1", slug: "coder", name: "Coder", description: "Codes for you." };
const FIXTURE: AgentRow = { id: "a2", owner_id: "u1", slug: "mcp-smoke-x1", name: "MCP Launch Smoke", description: "Smoke test fixture." };

describe("POST /v1/batch/bulk-visibility", () => {
	it("401s without a token", async () => {
		const { app, env } = buildApp([REAL]);
		const res = await app.fetch(
			new Request("https://api.test/v1/batch/bulk-visibility", { method: "POST", body: "{}" }),
			env,
		);
		expect(res.status).toBe(401);
	});

	it("publishes real agents", async () => {
		const { app, env, writes } = buildApp([REAL]);
		const res = await post(app, env, { agentIds: ["a1"], visibility: "published" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(writes.some((w) => w.startsWith("BATCH"))).toBe(true);
	});

	it("refuses to bulk-publish a smoke-test fixture", async () => {
		const { app, env, writes } = buildApp([REAL, FIXTURE]);
		const res = await post(app, env, { agentIds: ["a1", "a2"], visibility: "published" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toContain("mcp-smoke-x1");
		// Refused as a BATCH: a partial publish would leave the caller believing all of them shipped.
		expect(writes).toHaveLength(0);
	});

	it("allowTestAgent publishes it anyway — a guard, not a ban", async () => {
		const { app, env } = buildApp([FIXTURE]);
		const res = await post(app, env, { agentIds: ["a2"], visibility: "published", allowTestAgent: true }, await tokenFor("u1"));
		expect(res.status).toBe(200);
	});

	it("un-publishing a fixture is never blocked", async () => {
		const { app, env } = buildApp([FIXTURE]);
		for (const visibility of ["draft", "unlisted"]) {
			const res = await post(app, env, { agentIds: ["a2"], visibility }, await tokenFor("u1"));
			expect(res.status).toBe(200);
		}
	});

	it("403s on an agent the caller does not own", async () => {
		const { app, env } = buildApp([{ ...REAL, owner_id: "someone-else" }]);
		const res = await post(app, env, { agentIds: ["a1"], visibility: "published" }, await tokenFor("u1"));
		expect(res.status).toBe(403);
	});
});
