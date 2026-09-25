import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { agentRoutes } from "./agents.js";
import { instanceRoutes } from "./instances.js";
import type { Env } from "../types.js";

/**
 * The coding template's whole subscription path, on the schema the migrations build (#830).
 *
 * The reported failure was `list_agents → subscribe_agent → my_instances` stopping at step one: an
 * empty catalogue, so nothing to subscribe to. The template itself was never missing — `coder` has
 * been seeded published since migration 0021 — the catalogue's COUNT query named `a.visibility`
 * without the alias, D1 rejected every read, and the MCP tool rendered the error as `[]`. Every
 * catalogue test passed throughout, because each one answered canned rows to matched SQL strings.
 *
 * So this drives the three REST calls those MCP tools make (`/v1/agents`, `/v1/instances/:id/subscribe`,
 * `/v1/instances/my/instances`) over `d1-sqlite.ts`: every migration applied to real SQLite, no
 * seeded fixture rows for the agent. What it asserts is what the issue's acceptance asks —
 * the migrations alone publish a coding template, its descriptor says it does repository work, and
 * a user can subscribe to it and see the instance. Only the Durable Object is stubbed: its state is
 * not `env.DB`, and the route only copies template identity/knowledge through it.
 */

const SECRET = "coding-template-catalogue-secret";
const USER = "u-subscriber";

/** A template DO with no state — what a seeded first-party agent has (see the route's fallback). */
function agentNamespace() {
	const inits: unknown[] = [];
	const stub = {
		async fetch(req: Request) {
			const url = new URL(req.url);
			if (url.pathname === "/init") inits.push(await req.json());
			if (url.pathname === "/knowledge" && req.method === "GET") return Response.json({ documents: [] });
			return Response.json({});
		},
	};
	return { ns: { idFromName: (n: string) => n, get: () => stub }, inits };
}

function buildApp(d1: RealSchemaD1) {
	const app = new Hono<{ Bindings: Env }>();
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	app.route("/v1/agents", agentRoutes);
	app.route("/v1/instances", instanceRoutes);
	const { ns, inits } = agentNamespace();
	const env = { DB: d1.DB, SESSION_SIGNING_KEY: SECRET, AGENT: ns } as unknown as Env;
	return { app, env, inits };
}

describe("the coding template is published and subscribable (#830)", () => {
	it("list_agents → subscribe_agent → my_instances, from the migrations alone", async () => {
		const d1 = realSchemaD1();
		try {
			d1.exec(`INSERT INTO users (id, github_login, github_name, roles) VALUES ('${USER}', 'subscriber', 'Subscriber', '["user"]')`);
			const { app, env, inits } = buildApp(d1);

			// 1. list_agents — the public catalogue carries a coding template.
			const listRes = await app.request("/v1/agents?limit=500", {}, env);
			expect(listRes.status).toBe(200);
			const list = (await listRes.json()) as { agents: Array<{ id: string; slug: string; category: string; description: string }>; total: number };
			const coder = list.agents.find((a) => a.slug === "coder");
			expect(coder, "no `coder` in the public catalogue").toBeDefined();
			expect(coder?.category).toBe("code");
			expect(coder?.description).toMatch(/GitHub repo/i);
			expect(list.total).toBe(list.agents.length);

			// Its capabilities say repository work: a coding-session runtime, not tied to one repo.
			const cfgRow = d1.sqlite.prepare("SELECT config FROM agents WHERE slug = 'coder'").get() as { config: string };
			const cfg = JSON.parse(cfgRow.config) as { runtime?: { kind?: string; taskTypes?: string[] }; repoAgnostic?: boolean };
			expect(cfg.runtime?.kind).toBe("pags-coding-runtime");
			expect(cfg.runtime?.taskTypes).toContain("coding.session");
			expect(cfg.repoAgnostic).toBe(true);

			// 2. subscribe_agent — by slug, which is what list_agents hands back.
			const auth = { Authorization: `Bearer ${await signSession(USER, SECRET, { roles: ["user"] })}`, "Content-Type": "application/json" };
			const subRes = await app.request("/v1/instances/coder/subscribe", { method: "POST", headers: auth, body: "{}" }, env);
			expect(subRes.status).toBe(201);
			const sub = (await subRes.json()) as { instanceId: string; agentId: string; status: string };
			expect(sub).toMatchObject({ agentId: coder?.id, status: "active" });
			expect(inits).toHaveLength(1);

			// 3. my_instances — the private instance exists, owned by the subscriber.
			const mineRes = await app.request("/v1/instances/my/instances", { headers: auth }, env);
			expect(mineRes.status).toBe(200);
			const mine = JSON.stringify(await mineRes.json());
			expect(mine).toContain(sub.instanceId);
			const row = d1.sqlite.prepare("SELECT user_id, agent_id, status FROM agent_instances WHERE id = ?").get(sub.instanceId);
			expect(row).toEqual({ user_id: USER, agent_id: coder?.id, status: "active" });
		} finally {
			d1.close();
		}
	});
});
