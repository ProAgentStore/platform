import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { agentRoutes } from "./agents.js";
import { instanceRoutes } from "./instances.js";

/**
 * The coding template's whole subscriber path, on the schema the migrations build (#830).
 *
 * The reported failure was `list_agents → subscribe_agent → my_instances` stopping at step one: an
 * empty catalogue, so nothing could be subscribed to. The template itself was never missing —
 * `coder` has been seeded published since migration 0021 — but the catalogue's COUNT query named
 * `a.visibility` without the alias, D1 rejected every read, and the MCP tool rendered the error as
 * `[]`. The recorded SQL stubs in the existing tests could not detect that production failure.
 *
 * This drives the REST calls behind the MCP flow over `d1-sqlite.ts`: every migration applies to
 * real SQLite and no agent fixture is added. It also verifies the private instance can receive the
 * repository-specific context that a coding task needs. Only the Durable Object is stubbed: its
 * state is not `env.DB`, and the routes simply proxy instance initialization and knowledge there.
 */

const SECRET = "coding-template-catalogue-secret";
const USER = "u-subscriber";

/** A template/instance DO with no persisted state, as seeded first-party agents start. */
function agentNamespace() {
	const inits: unknown[] = [];
	const knowledgeWrites: unknown[] = [];
	const stub = {
		async fetch(req: Request) {
			const url = new URL(req.url);
			if (url.pathname === "/init") inits.push(await req.json());
			if (url.pathname === "/knowledge" && req.method === "GET") return Response.json({ documents: [] });
			if (url.pathname === "/knowledge" && req.method === "POST") {
				knowledgeWrites.push(await req.json());
				return Response.json({ id: "repo-context" }, { status: 201 });
			}
			return Response.json({});
		},
	};
	return { ns: { idFromName: (name: string) => name, get: () => stub }, inits, knowledgeWrites };
}

function buildApp(d1: RealSchemaD1) {
	const app = new Hono<{ Bindings: Env }>();
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	app.route("/v1/agents", agentRoutes);
	app.route("/v1/instances", instanceRoutes);
	const { ns, inits, knowledgeWrites } = agentNamespace();
	const env = { DB: d1.DB, SESSION_SIGNING_KEY: SECRET, AGENT: ns } as unknown as Env;
	return { app, env, inits, knowledgeWrites };
}

describe("the coding template is published and subscribable (#830)", () => {
	it("lists, subscribes, accepts repository context, and exposes the instance from migrations alone", async () => {
		const d1 = realSchemaD1();
		try {
			d1.exec(`INSERT INTO users (id, github_login, github_name, roles) VALUES ('${USER}', 'subscriber', 'Subscriber', '["user"]')`);
			const { app, env, inits, knowledgeWrites } = buildApp(d1);

			// 1. list_agents — the public catalogue carries a coding template.
			const listRes = await app.request("/v1/agents?limit=500", {}, env);
			expect(listRes.status).toBe(200);
			const list = (await listRes.json()) as { agents: Array<{ id: string; slug: string; category: string; description: string }>; total: number };
			const coder = list.agents.find((agent) => agent.slug === "coder");
			expect(coder, "no `coder` in the public catalogue").toBeDefined();
			expect(coder?.category).toBe("code");
			expect(coder?.description).toMatch(/GitHub repo/i);
			expect(list.total).toBe(list.agents.length);

			// Its runtime describes repository coding work and exposes `coding.session` tasks.
			const cfgRow = d1.sqlite.prepare("SELECT config FROM agents WHERE slug = 'coder'").get() as { config: string };
			const cfg = JSON.parse(cfgRow.config) as { runtime?: { kind?: string; taskTypes?: string[] }; repoAgnostic?: boolean };
			expect(cfg.runtime?.kind).toBe("pags-coding-runtime");
			expect(cfg.runtime?.taskTypes).toContain("coding.session");
			expect(cfg.repoAgnostic).toBe(true);

			const auth = { Authorization: `Bearer ${await signSession(USER, SECRET, { roles: ["user"] })}`, "Content-Type": "application/json" };

			// 2. subscribe_agent — by the slug that list_agents returns.
			const subRes = await app.request("/v1/instances/coder/subscribe", { method: "POST", headers: auth, body: "{}" }, env);
			expect(subRes.status).toBe(201);
			const sub = (await subRes.json()) as { instanceId: string; agentId: string; status: string };
			expect(sub).toMatchObject({ agentId: coder?.id, status: "active" });
			expect(inits).toHaveLength(1);

			// 3. add_instance_knowledge — the subscriber owns and can give the instance repo context.
			const context = { title: "HeartFull repository", content: "Repository: HeartFull-online/website", source: "user" };
			const knowledgeRes = await app.request(`/v1/instances/${encodeURIComponent(sub.instanceId)}/knowledge`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify(context),
			}, env);
			expect(knowledgeRes.status).toBe(201);
			expect(knowledgeWrites).toEqual([context]);

			// 4. my_instances — the active private instance is visible to its subscriber.
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
