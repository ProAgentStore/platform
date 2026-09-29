import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDefaultCodingEngineToIdle } from "./coding-default-engine-apply.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { CodingClientType, CodingSessionRecord } from "./coding-types.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["idle", "explicit", "running", "busy"] });
	env = { DB: d1.DB } as unknown as Env;
	d1.exec(`UPDATE users SET preferences = '{"coding":{"defaultEngineId":"codex"}}' WHERE id = 'u1'`);
});

afterEach(() => d1.close());

function q(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

function repo(instanceId: string): string {
	const id = `repo-${instanceId}`;
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, default_client) VALUES (${q(id)}, ${q(instanceId)}, 'u1', ${q(instanceId)}, 'claude')`);
	return id;
}

function session(instanceId: string, opts: { driver?: boolean } = {}): string {
	const repoId = repo(instanceId);
	const id = `sess-${instanceId}`;
	d1.exec(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, tmux_session, launch_command, driver_id, last_activity_at)
		 VALUES (${q(id)}, ${q(instanceId)}, ${q(repoId)}, 'u1', 'claude', 'active', ${q(`pags-${id}`)}, 'claude --dangerously-skip-permissions', ${opts.driver ? "'driver-1'" : "NULL"}, 1)`,
	);
	return id;
}

describe("applyDefaultCodingEngineToIdle (#879)", () => {
	it("restarts inherited idle sessions and skips explicit, running and busy sessions", async () => {
		const idle = session("idle");
		session("explicit");
		d1.exec(`UPDATE agent_instances SET config = '{"defaultEngineId":"gemini"}' WHERE id = 'explicit'`);
		const running = session("running");
		d1.exec(
			`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id)
			 VALUES ('run-1', 'u1', 'running', 'ship', 'running', 10, 1, ${q(running)})`,
		);
		session("busy");

		const restarted: Array<{ sessionId: string; command: string; clientType: CodingClientType }> = [];
		const result = await applyDefaultCodingEngineToIdle(env, "u1", {
			captureRunState: async (s: CodingSessionRecord) => ({ reachable: true, runState: s.instanceId === "busy" ? "thinking" : "idle" }),
			restartSession: async ({ session, command, clientType }) => {
				restarted.push({ sessionId: session.id, command, clientType });
				return { ok: true, newSessionId: `new-${session.id}` };
			},
		});

		expect(result.defaultEngineId).toBe("codex");
		expect(restarted).toEqual([{ sessionId: idle, command: "codex exec --json --sandbox danger-full-access", clientType: "codex" }]);
		expect(result.restarted).toBe(1);
		expect(result.skipped["explicit-instance-default"]).toBe(1);
		expect(result.skipped["active-run"]).toBe(1);
		expect(result.skipped.busy).toBe(1);
		expect(result.items.find((i) => i.sessionId === idle)?.newSessionId).toBe(`new-${idle}`);
	});
});
