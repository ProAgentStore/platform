import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import type { Env } from "../../types.js";
import { recordTriggerRunOutcome } from "./trigger-outcome.js";

// #1582: the trigger shows the outcome of the run it started, not just that it dispatched.
let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB }) as unknown as Env;
const run = { id: "scan-run-1", instanceId: "i1", userId: "u1" };
const trigger = async () => (await d1.DB.prepare("SELECT failure_count AS n, last_error AS e FROM agent_triggers WHERE id = 'trig-i1'").first<{ n: number; e: string | null }>())!;

function dispatched(runId: string, payload: Record<string, unknown> = { runId, status: "running", objective: "x" }) {
	d1.exec(
		`INSERT INTO agent_trigger_events (id, trigger_id, user_id, instance_id, type, status, payload, created_at)
		 VALUES ('ev-${runId}', 'trig-i1', 'u1', 'i1', 'cron', 'succeeded', '${JSON.stringify(payload)}', datetime('now'))`,
	);
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
});
afterEach(() => d1.close());

describe("a finished scheduled run is recorded on its trigger", () => {
	it("a failed run counts and names the run and why", async () => {
		dispatched("scan-run-1");
		await recordTriggerRunOutcome(env(), run, { status: "failed", errorCode: "runner_error", error: "engine crashed" });
		expect(await trigger()).toEqual({ n: 1, e: "Run scan-run-1 failed (runner_error): engine crashed" });
	});

	it("a completed run clears an earlier failure", async () => {
		dispatched("scan-run-1");
		await recordTriggerRunOutcome(env(), run, { status: "failed", errorCode: null, error: "boom" });
		await recordTriggerRunOutcome(env(), run, { status: "completed", errorCode: null, error: null });
		expect(await trigger()).toEqual({ n: 0, e: null });
	});

	it("a machine that was not there, a cancel, and a run no trigger started leave the trigger alone", async () => {
		dispatched("scan-run-1");
		await recordTriggerRunOutcome(env(), run, { status: "failed", errorCode: "runner_offline", error: "none" });
		await recordTriggerRunOutcome(env(), run, { status: "cancelled", errorCode: null, error: null });
		await recordTriggerRunOutcome(env(), { ...run, id: "owner-run" }, { status: "failed", errorCode: null, error: "boom" });
		expect(await trigger()).toEqual({ n: 0, e: null });
	});
});
