/**
 * #646 — the three agent-delete routes, driven against the REAL migrated schema.
 *
 * The defect could not be seen by any of the three routes' own tests, and all three passed
 * throughout: every D1 double in this Worker matches the SQL string instead of running it, so a
 * `DELETE FROM agents` that D1 would reject on a foreign key looked identical to one it would
 * accept. `agents.integration.test.ts` asserted "cascades via a batch (executions + usage +
 * agent)" against a stub that recorded statements — a perfect description of a delete that could
 * not work in production the moment anyone subscribed.
 *
 * So this runs the handlers over `d1-sqlite.ts`: every migration applied to in-memory SQLite with
 * foreign keys ON, which is the same engine and the same enforcement D1 has. `deleteWasImpossible`
 * below is the control — it issues the pre-#646 statement list and asserts SQLite rejects it, so
 * the fixture is proven to reproduce the bug before anything claims to have fixed it.
 *
 * The three routes are deliberately NOT expected to behave identically: they are not the same
 * actor. They are expected to agree on the MECHANISM (one shared cascade) and to differ only in
 * POLICY, and both halves of that are asserted here.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { adminModerationRoutes } from "./admin-moderation.js";
import { agentRoutes } from "./agents.js";
import { batchRoutes } from "./batch.js";
import type { Env } from "../types.js";

const SECRET = "agent-delete-integration-secret";

const OWNER = "u-owner";
const SUBSCRIBER = "u-subscriber";
const OPERATOR = "u-operator";
const AGENT = "a1";

/**
 * An agent with everything a marketplace agent accumulates: a saved version, usage, funnel hits,
 * and one instance belonging to `instanceOwner` carrying the deep coding subtree that is only
 * reachable through `agent_instances`.
 */
function seed(opts: { instanceOwner?: string; instanceStatus?: string } = {}): RealSchemaD1 {
	const d1 = realSchemaD1();
	const subscriber = opts.instanceOwner ?? OWNER;
	const status = opts.instanceStatus ?? "active";
	for (const u of new Set([OWNER, SUBSCRIBER, OPERATOR, subscriber])) {
		d1.exec(`INSERT OR IGNORE INTO users (id, github_login) VALUES ('${u}', '${u}')`);
	}
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('${AGENT}', '${OWNER}', 'delete-fixture', 'Delete Fixture')`);
	d1.exec(
		`INSERT INTO agent_versions (id, agent_id, version_num, state_snapshot) VALUES ('v1', '${AGENT}', 1, '{}')`,
	);
	d1.exec(
		`INSERT INTO agent_executions (id, agent_id, user_id, model) VALUES ('x1', '${AGENT}', '${OWNER}', 'm')`,
	);
	d1.exec(`INSERT INTO usage (id, agent_id, user_id, event) VALUES ('g1', '${AGENT}', '${OWNER}', 'execution')`);
	d1.exec(`INSERT INTO agent_funnel_daily (agent_id, day, event, hits) VALUES ('${AGENT}', '2026-08-01', 'view', 9)`);

	d1.exec(
		`INSERT INTO agent_instances (id, agent_id, user_id, status) VALUES ('i1', '${AGENT}', '${subscriber}', '${status}')`,
	);
	d1.exec(`INSERT INTO subscriptions (id, user_id, agent_id) VALUES ('s1', '${subscriber}', '${AGENT}')`);
	d1.exec(
		`INSERT INTO agent_triggers (id, user_id, agent_id, instance_id, name, type, action)
		 VALUES ('t1', '${subscriber}', '${AGENT}', 'i1', 'nightly', 'cron', 'run_pipeline')`,
	);
	d1.exec(
		`INSERT INTO agent_trigger_events (id, trigger_id, user_id, instance_id, type, status)
		 VALUES ('te1', 't1', '${subscriber}', 'i1', 'cron', 'succeeded')`,
	);
	// Two levels down from `agents`, reachable only via `agent_instances` — the part a
	// hand-written cascade would never have found by reading the three route files.
	d1.exec(
		`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', '${subscriber}', 'platform')`,
	);
	d1.exec(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('cs1', 'i1', 'r1', '${subscriber}')`,
	);
	d1.exec(
		`INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content)
		 VALUES ('cs1', 'i1', '${subscriber}', 'note', 'hello')`,
	);
	return d1;
}

function app(d1: RealSchemaD1) {
	const hono = new Hono<{ Bindings: Env }>();
	hono.route("/v1/agents", agentRoutes);
	hono.route("/v1/batch", batchRoutes);
	hono.route("/v1/admin", adminModerationRoutes);
	hono.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { hono, env: { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env };
}

const tokenFor = (uid: string, roles: string[] = ["creator"]) => signSession(uid, SECRET, { roles });

const count = (d1: RealSchemaD1, table: string, where: string): number =>
	(d1.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

/** The pre-#646 statement list, kept as the control: SQLite must still reject it. */
function deleteWasImpossible(d1: RealSchemaD1): string {
	try {
		d1.exec(`DELETE FROM agent_executions WHERE agent_id = '${AGENT}'`);
		d1.exec(`DELETE FROM usage WHERE agent_id = '${AGENT}'`);
		d1.exec(`DELETE FROM agent_funnel_daily WHERE agent_id = '${AGENT}'`);
		d1.exec(`DELETE FROM agents WHERE id = '${AGENT}'`);
		return "";
	} catch (e) {
		return (e as Error).message;
	}
}

describe("#646 — the fixture reproduces the bug", () => {
	it("the old cascade cannot delete an agent that has an instance", () => {
		const d1 = seed();
		try {
			// Foreign keys are enforced here exactly as D1 enforces them, so this is the creator's
			// experience before the fix: a raw constraint error in an `alert()`.
			expect(deleteWasImpossible(d1)).toMatch(/FOREIGN KEY/i);
			expect(count(d1, "agents", "id = 'a1'")).toBe(1);
		} finally {
			d1.close();
		}
	});
});

describe("DELETE /v1/agents/:id — the owner", () => {
	it("deletes an agent whose only instance is the owner's own, and takes the whole subtree", async () => {
		const d1 = seed({ instanceOwner: OWNER });
		try {
			const { hono, env } = app(d1);
			const res = await hono.request(
				"/v1/agents/a1",
				{ method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor(OWNER)}` } },
				env,
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ success: true, deletedInstances: 1 });

			// Every level, not just the ones the three routes happened to list.
			expect(count(d1, "agents", "id = 'a1'")).toBe(0);
			expect(count(d1, "agent_instances", "agent_id = 'a1'")).toBe(0);
			expect(count(d1, "subscriptions", "agent_id = 'a1'")).toBe(0);
			expect(count(d1, "agent_versions", "agent_id = 'a1'")).toBe(0);
			expect(count(d1, "agent_triggers", "agent_id = 'a1'")).toBe(0);
			expect(count(d1, "agent_trigger_events", "instance_id = 'i1'")).toBe(0);
			expect(count(d1, "coding_timeline", "instance_id = 'i1'")).toBe(0);
			expect(count(d1, "coding_sessions", "instance_id = 'i1'")).toBe(0);
			expect(count(d1, "coding_repos", "instance_id = 'i1'")).toBe(0);
			expect(count(d1, "agent_executions", "agent_id = 'a1'")).toBe(0);
			expect(count(d1, "usage", "agent_id = 'a1'")).toBe(0);
			expect(count(d1, "agent_funnel_daily", "agent_id = 'a1'")).toBe(0);
		} finally {
			d1.close();
		}
	});

	it("409s rather than destroying another user's instance, and says how many", async () => {
		const d1 = seed({ instanceOwner: SUBSCRIBER });
		try {
			const { hono, env } = app(d1);
			const res = await hono.request(
				"/v1/agents/a1",
				{ method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor(OWNER)}` } },
				env,
			);
			expect(res.status).toBe(409);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("1 instance(s)");
			expect(body.error).toContain("1 subscription(s)");
			// Actionable: the refusal names the two ways forward, which the raw D1 error did not.
			expect(body.error).toMatch(/unlisted/);

			// Nothing was touched — the refusal is a decision, not a half-finished delete.
			expect(count(d1, "agents", "id = 'a1'")).toBe(1);
			expect(count(d1, "agent_instances", "agent_id = 'a1'")).toBe(1);
			expect(count(d1, "agent_versions", "agent_id = 'a1'")).toBe(1);
		} finally {
			d1.close();
		}
	});

	it("a cancelled instance still blocks it — the row, not the status, holds the key", async () => {
		const d1 = seed({ instanceOwner: SUBSCRIBER, instanceStatus: "canceled" });
		try {
			const { hono, env } = app(d1);
			const res = await hono.request(
				"/v1/agents/a1",
				{ method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor(OWNER)}` } },
				env,
			);
			expect(res.status).toBe(409);
		} finally {
			d1.close();
		}
	});

	it("an admin's token role does not buy a cross-tenant delete here", async () => {
		// `session.roles` is whatever was baked into a 30-day token. Destroying a subscriber's
		// workspace goes through the audited operator route or not at all.
		const d1 = seed({ instanceOwner: SUBSCRIBER });
		try {
			const { hono, env } = app(d1);
			const res = await hono.request(
				"/v1/agents/a1",
				{ method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor(OPERATOR, ["admin"])}` } },
				env,
			);
			expect(res.status).toBe(409);
			expect(count(d1, "agents", "id = 'a1'")).toBe(1);
		} finally {
			d1.close();
		}
	});
});

describe("POST /v1/batch/bulk-delete — the same act must give the same answer", () => {
	const bulk = async (d1: RealSchemaD1, uid: string) => {
		const { hono, env } = app(d1);
		return hono.request(
			"/v1/batch/bulk-delete",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${await tokenFor(uid)}`, "Content-Type": "application/json" },
				body: JSON.stringify({ agentIds: [AGENT] }),
			},
			env,
		);
	};

	it("succeeds on the owner's own instances, exactly as the single-agent route does", async () => {
		const d1 = seed({ instanceOwner: OWNER });
		try {
			expect((await bulk(d1, OWNER)).status).toBe(200);
			expect(count(d1, "agents", "id = 'a1'")).toBe(0);
			expect(count(d1, "agent_instances", "agent_id = 'a1'")).toBe(0);
			expect(count(d1, "coding_timeline", "instance_id = 'i1'")).toBe(0);
		} finally {
			d1.close();
		}
	});

	it("refuses another user's instances too — this was the door that used to disagree", async () => {
		// Before #646 the disagreement ran the other way (only this route cleared `agent_versions`),
		// but the property under test is the same one: two routes with the same name for the same
		// act must not give different answers about the same agent.
		const d1 = seed({ instanceOwner: SUBSCRIBER });
		try {
			const res = await bulk(d1, OWNER);
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: string }).error).toContain(AGENT);
			expect(count(d1, "agents", "id = 'a1'")).toBe(1);
		} finally {
			d1.close();
		}
	});
});

describe("DELETE /v1/admin/agents/:id — the operator, who may override", () => {
	const del = async (d1: RealSchemaD1, query: string) => {
		const { hono, env } = app(d1);
		return hono.request(
			`/v1/admin/agents/a1?confirm=delete-fixture${query}`,
			{ method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor(OPERATOR, ["admin"])}` } },
			env,
		);
	};

	it("409s without force, counting every instance rather than only the active ones", async () => {
		const d1 = seed({ instanceOwner: SUBSCRIBER, instanceStatus: "canceled" });
		try {
			// The old guard read `status = 'active'`, so this case walked past it and then failed
			// the batch on the foreign key — a 500 where a 409 was the intended answer.
			const res = await del(d1, "");
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: string }).error).toContain("1 instance(s) (0 active)");
			expect(count(d1, "agents", "id = 'a1'")).toBe(1);
		} finally {
			d1.close();
		}
	});

	it("force=true completes, removing the subscriber's rows and auditing what it took", async () => {
		const d1 = seed({ instanceOwner: SUBSCRIBER });
		try {
			const res = await del(d1, "&force=true");
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				success: true,
				canceledInstances: 1,
				removedInstances: 1,
				removedSubscriptions: 1,
			});
			expect(count(d1, "agents", "id = 'a1'")).toBe(0);
			expect(count(d1, "agent_instances", "agent_id = 'a1'")).toBe(0);
			expect(count(d1, "coding_timeline", "instance_id = 'i1'")).toBe(0);

			// The audit row is the point of routing cross-tenant destruction through here: it is
			// what the owner route's 409 sends the operator to, so it must exist.
			const audit = d1.sqlite
				.prepare("SELECT action, detail FROM admin_audit_log WHERE target_id = 'a1'")
				.all() as { action: string; detail: string }[];
			expect(audit).toHaveLength(1);
			expect(audit[0].action).toBe("agent.delete");
			expect(audit[0].detail).toContain('"forced":true');
			expect(audit[0].detail).toContain('"removedInstances":1');
		} finally {
			d1.close();
		}
	});

	it("deletes a clean agent without force, and still clears agent_versions", async () => {
		const d1 = realSchemaD1();
		try {
			d1.exec(`INSERT OR IGNORE INTO users (id, github_login) VALUES ('${OWNER}', '${OWNER}')`);
			d1.exec(`INSERT OR IGNORE INTO users (id, github_login) VALUES ('${OPERATOR}', '${OPERATOR}')`);
			d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('${AGENT}', '${OWNER}', 'delete-fixture', 'Delete Fixture')`);
			d1.exec(
				`INSERT INTO agent_versions (id, agent_id, version_num, state_snapshot) VALUES ('v1', '${AGENT}', 1, '{}')`,
			);
			// A saved version alone used to be enough to make two of the three routes disagree.
			const res = await del(d1, "");
			expect(res.status).toBe(200);
			expect(count(d1, "agents", "id = 'a1'")).toBe(0);
			expect(count(d1, "agent_versions", "agent_id = 'a1'")).toBe(0);
		} finally {
			d1.close();
		}
	});
});
