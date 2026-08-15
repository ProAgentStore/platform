import { describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { assertChargeColumnsSelected } from "../lib/usage-columns.js";
import { loadAdminUsage } from "./admin.js";
import type { Env } from "../types.js";

/**
 * #647 — the operator portal's "BYOK spend" was structurally $0.00.
 *
 * This is the test the issue asks for, and it has to run against the REAL migrated schema
 * (`d1-sqlite.ts`): the defect is a column missing from a select list, and every existing test of
 * this aggregator hands it hand-built fixture objects, which is precisely how it went unnoticed —
 * `lib/usage-admin.test.ts`'s `row()` helper never sets `payer` either. Only executing the actual
 * SQL against a table that actually has the column can tell the two apart.
 */

const CHARGED = 1_500_000; // $1.50 in micros, on a byok-api row: real money someone owes.
const SUBSCRIPTION = 900_000; // notional value only — drawn from a plan allowance, never charged.

function ledger(): RealSchemaD1 {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	const insert = (id: string, payer: string | null, cost: number) =>
		d1.exec(
			`INSERT INTO ai_usage (id, user_id, agent_id, instance_id, provider, model, kind,
			                       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
			                       cost_micros, payer, created_at)
			 VALUES ('${id}', 'u1', 'agent-1', 'i1', 'anthropic', 'claude-sonnet-4-6', 'chat',
			         1000, 500, 700, 300, ${cost}, ${payer === null ? "NULL" : `'${payer}'`}, '2026-08-01 10:00:00')`,
		);
	insert("r-byok", "byok-api", CHARGED);
	insert("r-sub", "subscription", SUBSCRIPTION);
	insert("r-unknown", null, 100_000);
	return d1;
}

describe("#647 — loadAdminUsage must be able to see who paid", () => {
	it("reports non-zero charged spend for a byok-api row", async () => {
		const d1 = ledger();
		try {
			const s = await loadAdminUsage({ DB: d1.DB } as unknown as Env, undefined);

			// ADR 0002 — say how much was measured. All three rows reached the aggregator, so the
			// charged figure below is a real discrimination between them and not an empty set.
			expect(s.totals.calls).toBe(3);
			expect(s.totals.costMicros).toBe(CHARGED + SUBSCRIPTION + 100_000);

			// The headline both operator pages render. It was 0 for every input before the fix.
			expect(s.split.byok.chargedMicros).toBe(CHARGED);

			// And it is a discrimination, not "everything counts now": a subscription row draws a
			// plan allowance and an unestablished payer is not a charge we may assert.
			expect(s.split.byok.chargedMicros).toBeLessThan(s.split.byok.costMicros);
		} finally {
			d1.close();
		}
	});

	it("carries the prompt-cache columns the daily series publishes", async () => {
		const d1 = ledger();
		try {
			const s = await loadAdminUsage({ DB: d1.DB } as unknown as Env, undefined);
			const day = s.daily.find((d) => d.date === "2026-08-01");
			expect(day?.cacheReadTokens).toBe(2100); // 3 rows × 700
			expect(day?.cacheWriteTokens).toBe(900); // 3 rows × 300
		} finally {
			d1.close();
		}
	});

	it("ranks top spenders by a charge that can be non-zero", async () => {
		const d1 = ledger();
		try {
			const s = await loadAdminUsage({ DB: d1.DB } as unknown as Env, undefined);
			expect(s.byUser.find((b) => b.key === "u1")?.chargedCostMicros).toBe(CHARGED);
		} finally {
			d1.close();
		}
	});
});

describe("the select-list guard", () => {
	it("rejects rows fetched without the column every charged figure is decided on", () => {
		// The exact shape the bug produced: a well-typed row object whose `payer` key is absent
		// because the SELECT never asked for it.
		expect(() => assertChargeColumnsSelected([{ cost_micros: 10 }], "loadAdminUsage")).toThrow(/payer/);
	});

	it("accepts a selected-but-NULL payer, which is a real answer and not an omission", () => {
		// `null` means "we could not establish who paid" — recorded deliberately. Conflating it
		// with "not selected" is what made the bug invisible, so the guard must not do it either.
		expect(() => assertChargeColumnsSelected([{ payer: null }], "loadAdminUsage")).not.toThrow();
	});

	it("asserts nothing about an empty result set", () => {
		expect(() => assertChargeColumnsSelected([], "loadAdminUsage")).not.toThrow();
	});
});
