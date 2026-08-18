import { describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { deliverEvent } from "./connections.js";
import { dueDeliveries } from "./connection-deliveries.js";
import type { Env } from "../types.js";

/**
 * #649 — the two pump paths must stop dispatching to a cancelled instance.
 *
 * The cron sweep was gated in `5b7db678`; these are the other two reads that hand work to an
 * instance. They are measured against the REAL migrated schema (`d1-sqlite.ts`) for the reason
 * that issue already had to learn once: every other D1 double in this Worker resolves a statement
 * by matching its text, and the whole defect here is a missing JOIN, so a stub returns the same
 * rows before and after the fix and cannot tell the two apart.
 *
 * Per ADR 0002 each test states its own denominator — the cancelled row is proved to be present,
 * enabled and otherwise deliverable BEFORE anything asserts that it was skipped. Without that,
 * a query returning nothing at all would pass every assertion here.
 */

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** Owner with a live producer and two consumers — one active, one cancelled. */
function fixture(): RealSchemaD1 {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["producer", "live", "dead"] });
	d1.exec(`UPDATE agent_instances SET status = 'active'   WHERE id IN ('producer', 'live')`);
	d1.exec(`UPDATE agent_instances SET status = 'canceled' WHERE id = 'dead'`);
	// seedTenant's triggers are irrelevant here and would fire nothing; the connections are the
	// subject. Both edges are enabled and identical apart from where they point.
	for (const target of ["live", "dead"]) {
		d1.exec(
			`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled)
			 VALUES ('conn-${target}', 'u1', 'producer', 'lead.created', '${target}', 'create_task', '{"title":"T"}', 1)`,
		);
	}
	return d1;
}

const env = (d1: RealSchemaD1) => ({ DB: d1.DB } as unknown as Env);

const rows = (d1: RealSchemaD1, sql: string) => d1.sqlite.prepare(sql).all() as Array<Record<string, unknown>>;

describe("#649 — the agent-to-agent pump", () => {
	it("enqueues for the active target only, and counts the cancelled one rather than hiding it", async () => {
		const d1 = fixture();
		try {
			// Denominator: two enabled edges on the same (source, event), so a read that returned
			// neither would satisfy "the dead one got nothing" while protecting nothing at all.
			const wired = rows(
				d1,
				`SELECT c.id, i.status FROM agent_connections c JOIN agent_instances i ON i.id = c.target_instance_id
				  WHERE c.source_instance_id = 'producer' AND c.event_type = 'lead.created' AND c.enabled = 1`,
			);
			expect(wired.map((r) => r.id).sort()).toEqual(["conn-dead", "conn-live"]);
			expect(wired.filter((r) => r.status === "canceled")).toHaveLength(1);

			const r = await deliverEvent(env(d1), "producer", "u1", "lead.created", [{ place_id: "p1" }]);

			expect(r.connections).toBe(1);
			expect(r.inactive).toBe(1);
			expect(r.disabled).toBe(0);

			// The outbox is the fact that separates "was dispatched" from "was not": every delivery
			// is persisted BEFORE it is attempted, so exactly one row must exist and it must be the
			// live one. Asserting here rather than on the action's side effect keeps the test about
			// this read's scope and holds whether or not `create_task` can complete in a fixture.
			const queued = rows(d1, `SELECT connection_id, target_instance_id FROM agent_connection_deliveries`);
			expect(queued).toHaveLength(1);
			expect(queued[0].target_instance_id).toBe("live");
		} finally {
			d1.close();
		}
	});

	it("says nothing was delivered AND why, when the only consumer is cancelled", async () => {
		const d1 = fixture();
		try {
			d1.exec(`DELETE FROM agent_connections WHERE id = 'conn-live'`);
			const r = await deliverEvent(env(d1), "producer", "u1", "lead.created", [{ place_id: "p1" }]);
			expect(r.connections).toBe(0);
			expect(r.inactive).toBe(1);
			// A chain stopped by a cancellation must be distinguishable from one that was never
			// wired — the same distinction #644 drew for a paused edge, and the only signal the
			// owner gets, since the pump has no other surface.
			const warned = rows(d1, `SELECT event, message, context FROM agent_events WHERE event = 'connection.paused'`);
			expect(warned).toHaveLength(1);
			expect(String(warned[0].message)).toContain("cancelled instance");
			expect(rows(d1, `SELECT id FROM agent_connection_deliveries`)).toHaveLength(0);
		} finally {
			d1.close();
		}
	});
});

describe("#649 — the delivery retry loop", () => {
	it("leaves a pending delivery to a cancelled instance out of the due set", async () => {
		const d1 = fixture();
		try {
			for (const target of ["live", "dead"]) {
				d1.exec(
					`INSERT INTO agent_connection_deliveries
					   (id, connection_id, user_id, source_instance_id, target_instance_id, event_type, action,
					    payload, config, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
					 VALUES ('d-${target}', 'conn-${target}', 'u1', 'producer', '${target}', 'lead.created', 'create_task',
					    '{}', '{}', 'key-${target}', 'pending', 1, '2026-08-16T11:00:00.000Z',
					    '2026-08-16T10:00:00.000Z', '2026-08-16T11:00:00.000Z')`,
				);
			}
			// Denominator: both rows are pending and overdue, so the ungated query returns two.
			const pending = rows(
				d1,
				`SELECT id FROM agent_connection_deliveries WHERE status = 'pending' AND next_attempt_at <= '${NOW.toISOString()}'`,
			);
			expect(pending.map((r) => r.id).sort()).toEqual(["d-dead", "d-live"]);

			const due = await dueDeliveries(env(d1), NOW);
			expect(due.map((r) => r.id)).toEqual(["d-live"]);

			// Skipped, not destroyed: the gate is on the READ, so the row is still in the outbox and
			// still visible to the owner's deliveries list rather than silently rewritten.
			const dead = rows(d1, `SELECT status, attempts FROM agent_connection_deliveries WHERE id = 'd-dead'`);
			expect(dead[0]).toMatchObject({ status: "pending", attempts: 1 });
		} finally {
			d1.close();
		}
	});
});
