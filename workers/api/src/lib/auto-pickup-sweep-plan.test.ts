/**
 * #1683: the sweepAutoPickup driving read must not scan every agent_instances row through json_extract(config).
 * Runs the real sweep on the migrated schema, takes the SELECT it issued, and proves the rows are right and the
 * plan reads the partial index. The plan assertions are "no bare SCAN of i" plus the index by name; the planner can
 * choose differently across SQLite versions, so nothing here depends on which of several valid plans it prefers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RealSchemaD1, realSchemaD1 } from "./d1-sqlite.js";
import { sweepAutoPickup } from "./auto-pickup.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("PRAGMA foreign_keys = OFF");
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("sweepAutoPickup reads only the auto-pickup set (#1683)", () => {
	it("wakes only active instances with auto-pickup on, and never scans agent_instances bare", async () => {
		const on = JSON.stringify({ autoPickup: { enabled: true } });
		const off = JSON.stringify({ autoPickup: { enabled: false } });
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
		 ('on', 'a', 'u', 'active', '${on}'),
		 ('off', 'a', 'u', 'active', '${off}'),
		 ('none', 'a', 'u', 'active', '{}'),
		 ('paused', 'a', 'u', 'paused', '${on}')`);
		const woken: string[] = [];
		await sweepAutoPickup(env, 1_000_000, (async (_e: Env, id: string) => {
			woken.push(id);
			return { started: false, reason: "test" };
		}) as never);
		expect(woken).toEqual(["on"]);

		const sql = d1.issued.map((s) => s.sql).find((q) => /^\s*SELECT/i.test(q) && q.includes("autoPickup.enabled"));
		expect(sql, "the sweep SELECT was not issued").toBeTruthy();
		const plan = (d1.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 25, 3) as Array<{ detail: string }>).map((p) => p.detail);
		expect(plan.some((d) => d.startsWith("SCAN i") && !d.includes("USING")), plan.join(" | ")).toBe(false);
		expect(plan.some((d) => d.includes("idx_agent_instances_auto_pickup")), plan.join(" | ")).toBe(true);
	});
});
