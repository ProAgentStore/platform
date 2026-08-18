import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { adminModerationRoutes } from "./admin-moderation.js";
import { instanceRoutes } from "./instances.js";
import type { Env } from "../types.js";

/**
 * #669 — one `subscriptions` row is shared by every instance of an agent, so cancelling one of N
 * must not change the standing of the other N-1.
 *
 * Against the REAL migrated schema (`d1-sqlite.ts`), because the fix is a correlated subquery over
 * `agent_instances` inside the cancel's UPDATE. A SQL-matching double records the statement and
 * has no opinion on which rows it would have touched — the defect and the fix look identical to
 * it, which is exactly how the old statement passed `instances.integration.test.ts` while
 * retiring a row it did not own.
 *
 * The two production rows this reproduces are named in migration 0131.
 */

const SECRET = "subscription-standing-secret";
const USER = "u1";
const AGENT = "a1";

/** One owner with `n` active instances of one agent, sharing the single subscription row. */
function fixture(n: number): RealSchemaD1 {
	const d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('${USER}', '${USER}')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('${AGENT}', '${USER}', 'shared', 'Shared')`);
	for (let i = 1; i <= n; i++) {
		d1.exec(
			`INSERT INTO agent_instances (id, agent_id, user_id, status) VALUES ('i${i}', '${AGENT}', '${USER}', 'active')`,
		);
	}
	d1.exec(`INSERT INTO subscriptions (id, user_id, agent_id, status) VALUES ('s1', '${USER}', '${AGENT}', 'active')`);
	return d1;
}

function app(d1: RealSchemaD1) {
	const hono = new Hono<{ Bindings: Env }>();
	hono.route("/v1/instances", instanceRoutes);
	hono.route("/v1/admin", adminModerationRoutes);
	hono.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { hono, env: { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env };
}

const cancel = async (d1: RealSchemaD1, path: string, uid: string, roles: string[]) => {
	const { hono, env } = app(d1);
	const token = await signSession(uid, SECRET, { roles });
	return await hono.fetch(
		new Request(`https://api.test${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: "{}",
		}),
		env,
	);
};

const sub = (d1: RealSchemaD1) =>
	d1.sqlite.prepare(`SELECT status, canceled_at FROM subscriptions WHERE id = 's1'`).get() as {
		status: string;
		canceled_at: string | null;
	};

const instanceStatuses = (d1: RealSchemaD1) =>
	Object.fromEntries(
		(d1.sqlite.prepare(`SELECT id, status FROM agent_instances ORDER BY id`).all() as Array<{ id: string; status: string }>).map((r) => [
			r.id,
			r.status,
		]),
	);

describe("#669 — cancelling one of N instances", () => {
	it("leaves the shared subscription standing while a sibling is still live", async () => {
		const d1 = fixture(3);
		try {
			// Denominator: three instances, ONE subscription row between them. If the fixture held a
			// row per instance the assertion below would be true for the wrong reason.
			expect(d1.sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_instances`).get()).toEqual({ n: 3 });
			expect(d1.sqlite.prepare(`SELECT COUNT(*) AS n FROM subscriptions`).get()).toEqual({ n: 1 });

			const res = await cancel(d1, "/v1/instances/i1/cancel", USER, ["user"]);
			expect(res.status).toBe(200);

			// The per-instance authority moved; the shared record did not.
			expect(instanceStatuses(d1)).toEqual({ i1: "canceled", i2: "active", i3: "active" });
			expect(sub(d1)).toEqual({ status: "active", canceled_at: null });
		} finally {
			d1.close();
		}
	});

	it("retires it when the cancel takes the LAST live instance", async () => {
		const d1 = fixture(2);
		try {
			await cancel(d1, "/v1/instances/i1/cancel", USER, ["user"]);
			expect(sub(d1).status).toBe("active");

			await cancel(d1, "/v1/instances/i2/cancel", USER, ["user"]);
			expect(instanceStatuses(d1)).toEqual({ i1: "canceled", i2: "canceled" });
			const after = sub(d1);
			expect(after.status).toBe("canceled");
			expect(after.canceled_at).toBeTruthy();
		} finally {
			d1.close();
		}
	});

	it("does not re-stamp canceled_at when the row is already retired", async () => {
		const d1 = fixture(1);
		try {
			d1.exec(`UPDATE subscriptions SET status = 'canceled', canceled_at = '2020-01-01 00:00:00'`);
			await cancel(d1, "/v1/instances/i1/cancel", USER, ["user"]);
			expect(sub(d1)).toEqual({ status: "canceled", canceled_at: "2020-01-01 00:00:00" });
		} finally {
			d1.close();
		}
	});

	it("holds for the OPERATOR cancel too — both writers share the statement", async () => {
		const d1 = fixture(3);
		try {
			// `isAdmin` short-circuits on the session's own roles, so no allowlist or column is needed.
			d1.exec(`INSERT INTO users (id, github_login) VALUES ('op', 'op')`);
			const res = await cancel(d1, "/v1/admin/instances/i1/cancel", "op", ["admin"]);
			expect(res.status).toBe(200);
			expect(instanceStatuses(d1)).toMatchObject({ i1: "canceled", i2: "active", i3: "active" });
			expect(sub(d1).status).toBe("active");
		} finally {
			d1.close();
		}
	});
});

/**
 * The reconciliation half (AC2). Migration 0131 runs the same rule over rows written before the
 * fix, so a database that already diverged converges — including the case no future write can
 * reach, an ACTIVE instance whose subscription a sibling's cancel retired.
 */
describe("#669 — migration 0131 reconciles the rows already written", () => {
	it("re-activates a row a sibling's cancel retired, and retires one whose instances are all gone", () => {
		// `realSchemaD1()` applies every migration including 0131, so seeding the divergence and
		// re-running the migration's statements is the only way to observe it. Read from the file so
		// the test cannot drift from the migration it claims to cover.
		const d1 = fixture(2);
		try {
			d1.exec(`UPDATE agent_instances SET status = 'canceled' WHERE id = 'i2'`);
			// 880ce9d4's shape: i1 is still ACTIVE, but the shared row was retired by i2's cancel.
			d1.exec(`UPDATE subscriptions SET status = 'canceled', canceled_at = '2026-08-01 00:00:00'`);
			// A second (agent, user) pair whose every instance is cancelled while the row stands.
			d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('a2', '${USER}', 'gone', 'Gone')`);
			d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status) VALUES ('g1', 'a2', '${USER}', 'canceled')`);
			d1.exec(`INSERT INTO subscriptions (id, user_id, agent_id, status) VALUES ('s2', '${USER}', 'a2', 'active')`);

			migration0131(d1);

			expect(sub(d1)).toEqual({ status: "active", canceled_at: null });
			expect(d1.sqlite.prepare(`SELECT status FROM subscriptions WHERE id = 's2'`).get()).toEqual({ status: "canceled" });

			// Idempotent — a second application changes nothing.
			migration0131(d1);
			expect(sub(d1).status).toBe("active");
			expect(d1.sqlite.prepare(`SELECT status FROM subscriptions WHERE id = 's2'`).get()).toEqual({ status: "canceled" });
		} finally {
			d1.close();
		}
	});
});

/** The migration's own statements, read from the file rather than retyped here. */
function migration0131(d1: RealSchemaD1): void {
	// By PATH, not `new URL(...)`: this Worker's `URL` is the DOM one and `fileURLToPath` wants
	// node's, so the URL form fails `tsconfig.test.json` even though it runs (#627).
	const here = dirname(fileURLToPath(import.meta.url));
	d1.exec(readFileSync(join(here, "..", "..", "migrations", "0131_reconcile_subscription_standing.sql"), "utf8"));
}
