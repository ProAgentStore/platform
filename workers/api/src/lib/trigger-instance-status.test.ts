import { describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { activeInstanceSql, isActiveInstanceStatus } from "./trigger-eligibility.js";
import { runDueTriggers } from "./triggers.js";
import type { Env } from "../types.js";

/**
 * #649 — a cancelled instance must stop costing its owner money.
 *
 * These run against the REAL migrated schema (`d1-sqlite.ts`) rather than a SQL-matching stub,
 * because the whole defect is a missing join: a stub that returns seeded rows for any statement
 * answers identically before and after the fix, so it cannot tell the two apart. The sweep's
 * `WHERE` has to actually execute against actual rows for the assertion to mean anything — which
 * is the harness's own stated caveat, that parsing has no opinion on data.
 */

const DUE = "2026-08-04T00:00:00.000Z";
const NOW = new Date("2026-08-04T01:00:00.000Z");

/** Owner, agent, one active instance and one cancelled one, each with a due cron trigger. */
function fixture() {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["live", "dead"] });
	d1.exec(`UPDATE agent_instances SET status = 'active'   WHERE id = 'live'`);
	d1.exec(`UPDATE agent_instances SET status = 'canceled' WHERE id = 'dead'`);
	// seedTenant gives each instance a `run_pipeline` trigger; make both due, and give them an
	// action with no side effects so a dispatch that DOES happen is still observable via the claim.
	d1.exec(
		`UPDATE agent_triggers
		    SET type = 'cron', enabled = 1, action = 'log_event',
		        schedule = '0 9 * * *', next_run_at = '${DUE}'`,
	);
	return d1;
}

const rows = (d1: ReturnType<typeof realSchemaD1>, sql: string) =>
	d1.sqlite.prepare(sql).all() as Array<Record<string, unknown>>;

describe("#649 — the cron sweep must not fire for a cancelled instance", () => {
	it("skips the cancelled instance's due trigger and still fires the active one", async () => {
		const d1 = fixture();
		try {
			// ADR 0002 — state the size of what was measured. Both rows are genuinely due and
			// enabled, so a sweep that returned neither would pass a bare "the dead one did not
			// fire" assertion while protecting nothing.
			const due = rows(
				d1,
				`SELECT t.id, i.status FROM agent_triggers t JOIN agent_instances i ON i.id = t.instance_id
				  WHERE t.type = 'cron' AND t.enabled = 1 AND t.next_run_at <= '${NOW.toISOString()}'`,
			);
			expect(due.map((r) => r.id).sort()).toEqual(["trig-dead", "trig-live"]);
			expect(due.filter((r) => r.status === "canceled")).toHaveLength(1);

			const res = await runDueTriggers({ DB: d1.DB } as unknown as Env, NOW);

			// Only the live one was even considered.
			expect(res.checked).toBe(1);

			// The claim UPDATE is the fact that separates "was swept" from "was not swept": it runs
			// before dispatch and advances `next_run_at`. Asserting on it rather than on a dispatch
			// side effect keeps the test about the sweep's scope, and holds whether or not the
			// action itself can complete in this fixture.
			const after = Object.fromEntries(
				rows(d1, `SELECT id, next_run_at FROM agent_triggers`).map((r) => [r.id, r.next_run_at]),
			);
			expect(after["trig-live"]).not.toBe(DUE);
			expect(after["trig-dead"]).toBe(DUE);
		} finally {
			d1.close();
		}
	});
});

describe("the eligibility predicate", () => {
	it("admits only 'active', so a status nobody has taught it about cannot spend money", () => {
		// Every value the column declares (`lib/status-domain.ts:81`), plus the shapes a missing
		// join produces. Asserting the whole declared domain is what stops this reading as "one
		// example passed".
		const declared = ["active", "paused", "canceled"];
		expect(declared.filter(isActiveInstanceStatus)).toEqual(["active"]);
		for (const absent of [undefined, null, "", "ACTIVE", 1]) {
			expect(isActiveInstanceStatus(absent)).toBe(false);
		}
	});

	it("builds the SQL half from the same constant as the JS half", () => {
		expect(activeInstanceSql("i")).toBe("i.status = 'active'");
	});
});
