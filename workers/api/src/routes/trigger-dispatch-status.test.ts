import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { triggerRoutes } from "./triggers.js";
import type { Env } from "../types.js";

/**
 * #649 — the two ROUTE paths that could still dispatch for a cancelled instance.
 *
 * Driven against the REAL migrated schema (`d1-sqlite.ts`), like the sweep's own test and for the
 * same reason: the gate is a JOIN, and a SQL-matching double answers identically with and without
 * it. Here the join carries a second risk worth executing — the webhook lookup is by
 * `secret_token`, and a join written against the wrong column would silently 404 every live
 * webhook on the platform. The active cases below are what would catch that.
 */

const SECRET = "trigger-dispatch-status-secret";
const USER = "u1";

/** One owner, two instances of one agent — `live` active, `dead` cancelled — each with a webhook
 *  trigger and a manual-runnable cron trigger. */
function fixture(): RealSchemaD1 {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: USER, instanceIds: ["live", "dead"] });
	d1.exec(`UPDATE agent_instances SET status = 'active'   WHERE id = 'live'`);
	d1.exec(`UPDATE agent_instances SET status = 'canceled' WHERE id = 'dead'`);
	// seedTenant's per-instance trigger is the cron one `/run` targets. `log_event` has no side
	// effects beyond the trace, so a dispatch that DOES happen is observable without a runner.
	d1.exec(`UPDATE agent_triggers SET action = 'log_event', enabled = 1`);
	for (const id of ["live", "dead"]) {
		d1.exec(
			`INSERT INTO agent_triggers (id, user_id, agent_id, instance_id, name, type, action, enabled, secret_token)
			 VALUES ('hook-${id}', '${USER}', 'agent-1', '${id}', 'inbound', 'webhook', 'log_event', 1, 'tok-${id}')`,
		);
	}
	return d1;
}

function app(d1: RealSchemaD1) {
	const hono = new Hono<{ Bindings: Env }>();
	hono.route("/v1/triggers", triggerRoutes);
	hono.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	// `executeTriggerAction` resolves the target DO before it looks at the action, so even
	// `log_event` needs a binding present. Nothing here asserts on the stub: the DO is not what
	// this test is about, and a dispatch that reaches it has already failed the gate.
	const AGENT = {
		idFromName: (name: string) => name,
		get: () => ({ fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) }),
	};
	return { hono, env: { SESSION_SIGNING_KEY: SECRET, DB: d1.DB, AGENT } as unknown as Env };
}

const post = async (d1: RealSchemaD1, path: string, token?: string) => {
	const { hono, env } = app(d1);
	return await hono.fetch(
		new Request(`https://api.test${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: "{}",
		}),
		env,
	);
};

const events = (d1: RealSchemaD1, triggerId: string) =>
	d1.sqlite.prepare(`SELECT status FROM agent_trigger_events WHERE trigger_id = '${triggerId}'`).all() as Array<{ status: string }>;

describe("#649 — POST /v1/triggers/webhook/:token", () => {
	it("still fires for an active instance — the gate must not 404 every live webhook", async () => {
		const d1 = fixture();
		try {
			const res = await post(d1, "/v1/triggers/webhook/tok-live");
			expect(res.status).toBe(202);
			expect(events(d1, "hook-live").length).toBeGreaterThan(0);
		} finally {
			d1.close();
		}
	});

	it("404s for a cancelled instance, and dispatches nothing", async () => {
		const d1 = fixture();
		try {
			// Denominator: the token is valid and the trigger is enabled, so the ONLY thing that can
			// refuse this call is the instance's status. A fixture whose token was simply wrong would
			// pass the assertions below while measuring nothing.
			const row = d1.sqlite.prepare(`SELECT enabled, type FROM agent_triggers WHERE secret_token = 'tok-dead'`).get();
			expect(row).toMatchObject({ enabled: 1, type: "webhook" });

			const res = await post(d1, "/v1/triggers/webhook/tok-dead");
			expect(res.status).toBe(404);
			// Indistinguishable from a bad token: the caller is unauthenticated and learns nothing
			// about whether the instance exists.
			expect(await res.json()).toEqual({ error: "Webhook trigger not found" });
			// Not even a `received` event — the row is refused before anything is recorded or run.
			expect(events(d1, "hook-dead")).toHaveLength(0);
		} finally {
			d1.close();
		}
	});
});

describe("#649 — POST /v1/triggers/:id/run (the owner's explicit poke)", () => {
	it("runs for an active instance", async () => {
		const d1 = fixture();
		try {
			const res = await post(d1, "/v1/triggers/trig-live/run", await signSession(USER, SECRET, { roles: ["user"] }));
			expect(res.status).toBe(200);
			expect(events(d1, "trig-live").length).toBeGreaterThan(0);
		} finally {
			d1.close();
		}
	});

	it("409s for a cancelled instance — owner-initiated is not the same as permitted", async () => {
		const d1 = fixture();
		try {
			const token = await signSession(USER, SECRET, { roles: ["user"] });
			// Denominator: the caller genuinely owns this trigger, so a 404-shaped ownership failure
			// would not produce this result.
			const owned = d1.sqlite.prepare(`SELECT user_id, instance_id FROM agent_triggers WHERE id = 'trig-dead'`).get();
			expect(owned).toMatchObject({ user_id: USER, instance_id: "dead" });

			const res = await post(d1, "/v1/triggers/trig-dead/run", token);
			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({ error: "Instance is not active" });
			expect(events(d1, "trig-dead")).toHaveLength(0);
		} finally {
			d1.close();
		}
	});

	it("leaves the trigger DELETABLE, so a cancelled instance's rows are not stranded", async () => {
		const d1 = fixture();
		try {
			const token = await signSession(USER, SECRET, { roles: ["user"] });
			const { hono, env } = app(d1);
			// The gate is on `/run` alone. Edit and DELETE keep the plain owner lookup, because a
			// trigger that can neither fire nor be removed is a worse outcome than the one #649 set
			// out to fix — it is the recovery problem, not the remedy.
			const del = await hono.fetch(
				new Request("https://api.test/v1/triggers/trig-dead", { method: "DELETE", headers: { authorization: `Bearer ${token}` } }),
				env,
			);
			expect(del.status).toBe(200);
			expect(d1.sqlite.prepare(`SELECT id FROM agent_triggers WHERE id = 'trig-dead'`).all()).toHaveLength(0);
		} finally {
			d1.close();
		}
	});
});
