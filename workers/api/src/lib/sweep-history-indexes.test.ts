/**
 * The three per-minute sweeps that used to full-scan growing history tables (#1680).
 * Each runs its real function on the migrated schema, takes the SELECT it issued, then proves (a) only the live
 * rows come back among finished/old ones and (b) the plan reads an index, never a bare SCAN of the table.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RealSchemaD1, realSchemaD1 } from "./d1-sqlite.js";
import { failExpiredCodeWaits } from "./local-apply/agent-sign-in.js";
import { syncLeadWritebacks } from "./local-artifact/store.js";
import { expireScheduledUpdateOps } from "./runner-update-ops.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("PRAGMA foreign_keys = OFF");
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

/** Re-run the SELECT the code issued on a table, by hand, to read its rows and its plan. */
function selectIssued(table: string, params: unknown[]) {
	const sql = d1.issued.map((s) => s.sql).find((q) => /^\s*SELECT/i.test(q) && q.includes(table));
	expect(sql, `no SELECT on ${table} was issued`).toBeTruthy();
	const rows = d1.sqlite.prepare(sql as string).all(...(params as never[])) as Array<Record<string, unknown>>;
	const plan = (d1.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>).map((p) => p.detail);
	return { rows, plan };
}
const bareScan = (plan: string[], table: string) => plan.some((d) => d.startsWith(`SCAN ${table}`) && !d.includes("USING"));

describe("expireScheduledUpdateOps reads only the scheduled set (#1680)", () => {
	it("returns the expired scheduled row, not finished or reconciled ones, via the partial index", async () => {
		d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1');
		INSERT INTO runner_update_ops (id, user_id, node, state, deferred_until, reconciliation, created_at, updated_at) VALUES
		 ('live', 'u1', 'n', 'scheduled', 100, NULL, 1, 1),
		 ('later', 'u1', 'n2', 'scheduled', 99999999999999, NULL, 2, 2),
		 ('recon', 'u1', 'n3', 'scheduled', 100, 'x', 3, 3),
		 ('done', 'u1', 'n4', 'restarted', 100, NULL, 4, 4)`);
		expect(await expireScheduledUpdateOps(env, 1_000_000)).toBe(1);
		const expired = d1.sqlite.prepare("SELECT id FROM runner_update_ops WHERE state = 'expired'").all() as Array<{ id: string }>;
		expect(expired.map((r) => r.id)).toEqual(["live"]);
		const { plan } = selectIssued("runner_update_ops", [300_000, 1_000_000, 100]);
		expect(plan.some((d) => d.includes("idx_runner_update_ops_scheduled")), plan.join(" | ")).toBe(true);
		expect(bareScan(plan, "runner_update_ops")).toBe(false);
	});
});

describe("failExpiredCodeWaits reads only waiting sign-ins (#1680)", () => {
	it("returns the overdue code wait, not settled or answered ones, via the partial index", async () => {
		d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1');
		INSERT INTO local_apply_agent_sign_ins (run_id, instance_id, user_id, host, state, code_requested_at, code_message_id, created_at, updated_at) VALUES
		 ('live', 'i', 'u1', 'h', 'signing_in', 100, NULL, 1, 1),
		 ('fresh', 'i', 'u1', 'h', 'signing_in', 9999999999999, NULL, 1, 1),
		 ('answered', 'i', 'u1', 'h', 'signing_in', 100, 'm', 1, 1),
		 ('failed', 'i', 'u1', 'h', 'failed', 100, NULL, 1, 1)`);
		await failExpiredCodeWaits(env, 1_000_000).catch(() => 0);
		const failed = d1.sqlite.prepare("SELECT run_id FROM local_apply_agent_sign_ins WHERE failure = 'code_not_received'").all() as Array<{ run_id: string }>;
		expect(failed.map((r) => r.run_id)).toEqual(["live"]);
		const { plan } = selectIssued("local_apply_agent_sign_ins", [700_000]);
		expect(plan.some((d) => d.startsWith("SEARCH local_apply_agent_sign_ins USING INDEX idx_local_apply_agent_sign_ins_code_wait")), plan.join(" | ")).toBe(true);
	});
});

describe("syncLeadWritebacks reads no application history (#1680)", () => {
	it("returns recent and unsynced-disposition rows, each arm index-served", async () => {
		const cols = "id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, created_at, updated_at, lead, archive_reason, lead_disposition_synced_at";
		d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1');
		INSERT INTO job_applications (${cols}) VALUES
		 ('recent', 'i', 'u1', 'i', 'l1', 1, 'k1', 1, 5000, '{}', NULL, NULL),
		 ('old', 'i', 'u1', 'i', 'l2', 1, 'k2', 1, 10, '{}', NULL, NULL),
		 ('backlog', 'i', 'u1', 'i', 'l3', 1, 'k3', 1, 20, '{"verification":{"state":"live"}}', NULL, NULL),
		 ('unavail', 'i', 'u1', 'i', 'l4', 1, 'k4', 1, 30, '{}', 'job_unavailable', NULL),
		 ('synced', 'i', 'u1', 'i', 'l5', 1, 'k5', 1, 40, '{}', 'job_unavailable', 1)`);
		await syncLeadWritebacks(env as never, 1000).catch(() => 0);
		const { rows, plan } = selectIssued("job_applications", [1000, 50]);
		expect(rows.map((r) => r.id)).toEqual(["recent", "unavail", "backlog"]);
		expect(plan.some((d) => d.startsWith("SEARCH job_applications USING INDEX idx_job_applications_updated")), plan.join(" | ")).toBe(true);
		expect(plan.some((d) => d.includes("idx_job_applications_disposition_backlog")), plan.join(" | ")).toBe(true);
		expect(bareScan(plan, "job_applications")).toBe(false);
	});
});
