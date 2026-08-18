// #662 — the ledger's instance axis, from both ends.
//
// A platform-paid embedding or summary row used to land with an INSTANCE id in `agent_id` and NULL
// in `instance_id`, because `EngineMeter.instanceId` was declared and read but never constructed.
// Four instance-scoped readers filtered on the raw `instance_id` column and therefore saw none of
// those rows, while the Usage page resolved them by join — so one instance had two different
// numbers for one window.
//
// These tests run the REAL SQL against the REAL schema (`realSchemaD1` — every migration applied
// to in-memory SQLite, foreign keys ON). A string-matching stub cannot tell a query that returns
// the right rows from one that returns none, which is the entire failure being fixed here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { resolveMeterIds } from "./meter-ids.js";
import { readPointInTime, statsPeriod, type StatsCtx } from "./stats-sources.js";
import { instanceSpendMicros } from "./usage.js";
import type { Env } from "../types.js";

const DAY = "2026-08-10";
const AT = `${DAY} 12:00:00`;

/** One owner, one template agent, two instances of it. */
function fixture() {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1", "inst-2"] });
	return d1;
}

function usageRow(
	d1: ReturnType<typeof realSchemaD1>,
	row: { id: string; user?: string; agent?: string | null; instance?: string | null; payer: string; cost: number; input?: number; output?: number },
): void {
	const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${s}'`);
	d1.exec(
		`INSERT INTO ai_usage (id, user_id, agent_id, instance_id, provider, model, kind,
		    input_tokens, output_tokens, cost_micros, payer, created_at)
		 VALUES ('${row.id}', '${row.user ?? "u1"}', ${q(row.agent)}, ${q(row.instance)}, 'platform', 'm', 'chat',
		    ${row.input ?? 0}, ${row.output ?? 0}, ${row.cost}, '${row.payer}', '${AT}')`,
	);
}

describe("resolveMeterIds — which id the DO's own name actually is (#662)", () => {
	it("an instance DO writes the INSTANCE id in instance_id and its TEMPLATE in agent_id", async () => {
		const d1 = fixture();
		try {
			expect(await resolveMeterIds({ DB: d1.DB } as unknown as Env, "inst-1")).toEqual({
				agentId: "agent-1",
				instanceId: "inst-1",
			});
		} finally {
			d1.close();
		}
	});

	it("a template DO keeps agent_id and has no instance — the id is NOT copied across", async () => {
		// The wrong fix. `instanceId = agentId` is right for an instance DO and puts an AGENT id in
		// `instance_id` for a template one, which is the mirror bug usage-ids.ts already records
		// against agent-think.ts.
		const d1 = fixture();
		try {
			expect(await resolveMeterIds({ DB: d1.DB } as unknown as Env, "agent-1")).toEqual({
				agentId: "agent-1",
				instanceId: null,
			});
		} finally {
			d1.close();
		}
	});

	it("a D1 failure falls back to the template reading rather than guessing", async () => {
		const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1_ERROR"); } }) }) } } as unknown as Env;
		expect(await resolveMeterIds(env, "inst-1")).toEqual({ agentId: "inst-1", instanceId: null });
	});

	it("the ONE meter construction goes through it, and no longer hard-codes the DO name as agentId", () => {
		// The function being correct is worth nothing if the writer stops calling it, and
		// `getStorageEngine` lives on a Durable Object — there is no unit seam to assert the wiring
		// from. `grep -rn "db: this.env.DB"` finds exactly one meter in the tree (issue #662), so
		// reading that one file is a complete check rather than a sample.
		const src = readFileSync(join(import.meta.dirname, "..", "agent-do.ts"), "utf8");
		expect(src).toContain("resolveMeterIds");
		expect(src, "the pre-#662 meter shape, which left instanceId undefined").not.toMatch(
			/db:\s*this\.env\.DB,\s*userId,\s*agentId\s*\}/,
		);
	});
});

describe("instance-scoped ledger readers see the rows the writer mislabelled (#662)", () => {
	/** The four kinds of row that matter, seeded once. */
	function seeded() {
		const d1 = fixture();
		// Pre-#662 shape: an INSTANCE id in agent_id, NULL instance_id. Charged (platform).
		usageRow(d1, { id: "r-legacy", agent: "inst-1", instance: null, payer: "platform", cost: 3000, input: 100, output: 10 });
		// Correctly-shaped row on the same instance. Charged (byok-api).
		usageRow(d1, { id: "r-ok", agent: "agent-1", instance: "inst-1", payer: "byok-api", cost: 1000, input: 5, output: 5 });
		// Same instance, but not money — must stay out of the SPEND figure and inside VALUE.
		usageRow(d1, { id: "r-sub", agent: "agent-1", instance: "inst-1", payer: "subscription", cost: 5000, input: 1, output: 1 });
		// A different instance of the same template, in the legacy shape. Must not leak across.
		usageRow(d1, { id: "r-other", agent: "inst-2", instance: null, payer: "platform", cost: 9999, input: 999, output: 999 });
		return d1;
	}

	it("instanceSpendMicros counts the mislabelled charged row — under-charging a pool is the unsafe direction", async () => {
		const d1 = seeded();
		try {
			// 3000 (legacy platform row, previously invisible) + 1000 (byok-api). The subscription
			// row is excluded by CHARGED_SQL, and inst-2's row does not cross over.
			expect(await instanceSpendMicros({ DB: d1.DB } as unknown as Env, "u1", "inst-1")).toBe(4000);
			expect(await instanceSpendMicros({ DB: d1.DB } as unknown as Env, "u1", "inst-2")).toBe(9999);
		} finally {
			d1.close();
		}
	});

	it("the stats cards report the same instance the Usage page does", async () => {
		const d1 = seeded();
		const ctx = { env: { DB: d1.DB } as unknown as Env, instanceId: "inst-1", userId: "u1" } satisfies StatsCtx;
		const period = statsPeriod(DAY, 1);
		try {
			// VALUE is deliberately unfiltered on payer (#346): every row on this instance.
			expect(await readPointInTime(ctx, { id: "c", title: "v", kind: "number", source: "usage.cost", params: {} }, period)).toEqual({
				type: "scalar",
				unit: "usd_micros",
				value: 9000,
			});
			// Tokens likewise count consumption regardless of who paid.
			expect(await readPointInTime(ctx, { id: "c", title: "t", kind: "number", source: "usage.tokens", params: {} }, period)).toEqual({
				type: "scalar",
				unit: "tokens",
				value: 122,
			});
		} finally {
			d1.close();
		}
	});

	it("resolution never reaches across tenants, even when a writer put the wrong id in the column", async () => {
		// `inst-1` belongs to u1. A row owned by u2 that names it must not be counted for either.
		const d1 = fixture();
		d1.exec("INSERT OR IGNORE INTO users (id, github_login) VALUES ('u2', 'u2')");
		usageRow(d1, { id: "r-foreign", user: "u2", agent: "inst-1", instance: null, payer: "platform", cost: 7777 });
		try {
			expect(await instanceSpendMicros({ DB: d1.DB } as unknown as Env, "u1", "inst-1")).toBe(0);
			expect(await instanceSpendMicros({ DB: d1.DB } as unknown as Env, "u2", "inst-1")).toBe(0);
		} finally {
			d1.close();
		}
	});

	it("prefers a resolvable instance_id over agent_id, so a correct row is untouched", async () => {
		// The COALESCE order. A row naming inst-1 explicitly belongs to inst-1 even though its
		// agent_id names something else entirely.
		const d1 = fixture();
		usageRow(d1, { id: "r-both", agent: "inst-2", instance: "inst-1", payer: "platform", cost: 500 });
		try {
			expect(await instanceSpendMicros({ DB: d1.DB } as unknown as Env, "u1", "inst-1")).toBe(500);
			expect(await instanceSpendMicros({ DB: d1.DB } as unknown as Env, "u1", "inst-2")).toBe(0);
		} finally {
			d1.close();
		}
	});
});

/**
 * The ratchet. Four readers drifted because there were four of them; the fifth will be written the
 * same way. Any `ai_usage` read scoped to one instance must go through the shared resolution.
 */
describe("no instance-scoped ai_usage read open-codes the raw column", () => {
	const sources = [
		["lib/usage.ts", join(import.meta.dirname, "usage.ts")],
		["lib/stats-sources.ts", join(import.meta.dirname, "stats-sources.ts")],
		["routes/admin-instance-detail.ts", join(import.meta.dirname, "..", "routes", "admin-instance-detail.ts")],
	] as const;

	it("every one of them uses usageInstanceScopeSql", () => {
		for (const [label, path] of sources) {
			expect(readFileSync(path, "utf8"), label).toContain("usageInstanceScopeSql");
		}
	});

	it("leaves no `instance_id = ?` filter on ai_usage behind", () => {
		// The window is "the rest of the template literal this FROM sits in", not a fixed character
		// count: a count ran past the closing backtick into the NEXT query in the file, and
		// `runsCount` filters `agent_loop_runs.instance_id = ?1` — correctly, because that table
		// really does own the column. The `${…}` interpolations carry no backtick, so a statement
		// assembled from the shared helper stays one window.
		for (const [label, path] of sources) {
			const src = readFileSync(path, "utf8");
			for (const after of src.split(/FROM ai_usage/).slice(1)) {
				expect(after.split("`")[0], `${label}: an ai_usage read filtering the raw instance column`).not.toMatch(
					/\bWHERE\b[\s\S]*?\binstance_id\s*=\s*\?/,
				);
			}
		}
	});
});
