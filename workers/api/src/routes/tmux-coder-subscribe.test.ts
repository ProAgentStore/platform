/**
 * #515 AC2, driven rather than inferred: `POST /v1/instances/tmux-coder/subscribe` succeeds on the REAL
 * migrated schema, and the new instance is initialised with the seed's identity.
 *
 * `tmux-coder-seed.test.ts` asserts the row is `published`, which is what the subscribe gate reads.
 * This runs the gate itself. The contrast row is `single-pane-operator` (0112): seeded `draft`, so the
 * same route refuses it — the defect #515 named, and the reason any new seed here must be published.
 *
 * The identity half is #496's point stated as a test: identity is copied ONCE, at subscribe, from the
 * seed when the template DO is uninitialised — so a brand-new agent's first instance gets the correct
 * personality by the one copy that works.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { instanceRoutes } from "./instances.js";
import type { Env } from "../types.js";

const SECRET = "tmux-coder-subscribe";
let d1: RealSchemaD1;
afterEach(() => d1?.close());

function setup() {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: [] });
	const inits: Array<{ name: string; body: Record<string, unknown> }> = [];
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: d1.DB,
		AGENT: {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }) => ({
				fetch: async (req: Request) => {
					const path = new URL(req.url).pathname;
					// A first-party seed has no initialised template DO: /state answers with no name.
					if (path === "/state") return Response.json({});
					if (path === "/knowledge") return Response.json({ documents: [] });
					if (path === "/init") inits.push({ name: id.name, body: (await req.json()) as Record<string, unknown> });
					return Response.json({ ok: true });
				},
			}),
		},
	} as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
	const subscribe = async (slug: string) =>
		app.request(`/v1/instances/${slug}/subscribe`, { method: "POST", headers: { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: [] })}`, "Content-Type": "application/json" }, body: "{}" }, env);
	return { subscribe, inits };
}

const seed = () => {
	const row = d1.sqlite.prepare("SELECT id, name, model, config FROM agents WHERE slug = 'tmux-coder'").get() as { id: string; name: string; model: string; config: string };
	return { ...row, identity: (JSON.parse(row.config) as { identity: Record<string, unknown> }).identity };
};

describe("POST /v1/instances/tmux-coder/subscribe (#515 AC2)", () => {
	it("succeeds, and creates an active instance of the tmux Coder", async () => {
		const { subscribe } = setup();
		const res = await subscribe("tmux-coder");
		expect(res.status).toBe(201);
		const body = (await res.json()) as { instanceId: string; agentId: string; status: string };
		expect(body).toMatchObject({ agentId: "agent_tmux_coder", status: "active" });
		const row = d1.sqlite.prepare("SELECT agent_id, user_id, status FROM agent_instances WHERE id = ?").get(body.instanceId);
		expect(row).toEqual({ agent_id: "agent_tmux_coder", user_id: "u1", status: "active" });
	});

	it("initialises the instance with the seed's identity — the one copy #496 says works", async () => {
		const { subscribe, inits } = setup();
		const { instanceId } = (await (await subscribe("tmux-coder")).json()) as { instanceId: string };
		const init = inits.find((i) => i.name === instanceId);
		const s = seed();
		expect(init?.body).toMatchObject({
			agentId: instanceId,
			name: s.name,
			model: s.model,
			personality: s.identity.personality,
			goal: s.identity.goal,
			guardrails: s.identity.guardrails,
			welcomeMessage: s.identity.welcomeMessage,
		});
		// The personality it receives is the current one — 0140's read-tools section included.
		expect(String(init?.body.personality)).toContain("repo_read_file");
		expect(String(init?.body.personality)).not.toMatch(/terminal_(new_target|run_command|send_keys|capture)/);
	});

	it("the same route refuses 0112's draft single-pane-operator — the defect a published seed avoids", async () => {
		const { subscribe } = setup();
		expect((d1.sqlite.prepare("SELECT visibility FROM agents WHERE slug = 'single-pane-operator'").get() as { visibility: string }).visibility).toBe("draft");
		expect((await subscribe("single-pane-operator")).status).toBe(404);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_instances").get() as { n: number }).n).toBe(0);
	});
});
