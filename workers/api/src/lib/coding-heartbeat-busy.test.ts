/**
 * A working owner is not reported as a lost heartbeat (#1019), on the real migrated schema.
 *
 * `getHeartbeatLostClaim` read only the session's driver claim. One engine turn longer than
 * `STALE_DRIVER_MS` aged that claim while the run's capture loop was demonstrably alive, writing
 * `last_alive_at` every minute — and the admission check, the queue listing and `coding_loop_status`
 * then told the owner a busy run had stopped reporting. Both signals are now reconciled.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { getHeartbeatLostClaim, storedHandoff } from "./coding-handoff-store.js";
import { STALE_DRIVER_MS } from "./coding-store.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'acme/widget', '/w/widget', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, driver_id, driver_at) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude', 'drv-1', ${NOW - STALE_DRIVER_MS - 5 * 60_000})`);
});
afterEach(() => d1.close());

function runningRun(lastAliveAgo: number | null) {
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, last_alive_at)
	  VALUES ('run-1', 'u1', 'i1', 'synthetic objective', 'running', 10, ${NOW - 60 * 60_000}, 's1', ${lastAliveAgo === null ? "NULL" : NOW - lastAliveAgo})`);
}

describe("busy versus heartbeat lost", () => {
	it("a run mid-turn — stale claim, live capture loop — is NOT heartbeat-lost", async () => {
		runningRun(60_000);
		expect(await getHeartbeatLostClaim(env, "i1", "u1", "r1", NOW)).toBeNull();
		expect(await storedHandoff(env, "i1", "u1", "r1", NOW)).toBeNull();
	});

	it("a run whose claim AND liveness are both stale is reported as such, with a truthful sentence", async () => {
		runningRun(STALE_DRIVER_MS + 60_000);
		expect(await getHeartbeatLostClaim(env, "i1", "u1", "r1", NOW)).toMatchObject({ runId: "run-1", reason: "heartbeat_lost" });
		expect(await storedHandoff(env, "i1", "u1", "r1", NOW)).toMatchObject({ state: "stalled", runId: "run-1" });
	});

	it("a run that never recorded liveness is judged on its claim alone, as before", async () => {
		runningRun(null);
		expect(await getHeartbeatLostClaim(env, "i1", "u1", "r1", NOW)).toMatchObject({ runId: "run-1" });
	});
});
