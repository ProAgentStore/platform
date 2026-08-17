import { describe, expect, it } from "vitest";
import { listIdleSessions, listInstancesWithQuietSessions } from "./coding-sweep-queries.js";
import type { Env } from "../types.js";

interface Read { sql: string; args: unknown[] }

function readEnv(rows: unknown[] = []): { env: Env; reads: Read[] } {
	const reads: Read[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() { reads.push({ sql, args }); return { results: rows }; },
						async first() { return null; },
						async run() { return { meta: { changes: 0 } }; },
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, reads };
}

describe("listIdleSessions — the sweep's input (#275)", () => {
	it("refuses to hand the sweeper a session whose driver claim is still fresh", async () => {
		// Reaping a session out from under a live Pilot is the one outcome strictly worse than the
		// leak: the run loses its engine mid-step with no explanation anywhere.
		const { env, reads } = readEnv();
		await listIdleSessions(env, 123, 50);
		expect(reads[0].sql).toContain("s.driver_at IS NULL OR s.driver_at < ?2");
		expect(reads[0].args).toEqual([123, 123, 50]);
	});

	it("falls back to updated_at for a row written before the backfill", async () => {
		// A session created by an in-flight isolate mid-deploy has a NULL stamp. Comparing NULL
		// against the cutoff is never true, so without the COALESCE that row would be immortal.
		const { env, reads } = readEnv();
		await listIdleSessions(env, 1, 1);
		expect(reads[0].sql).toContain("COALESCE(s.last_activity_at, CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000)");
	});

	it("LEFT-joins the labels, so a deleted repo still gets its engine released (#698)", async () => {
		// The joins are for the notification's prose. An INNER join would drop the row instead —
		// trading a cosmetic gap for the resident process this whole sweep exists to kill.
		const { env, reads } = readEnv();
		await listIdleSessions(env, 1, 1);
		for (const t of ["LEFT JOIN coding_repos", "LEFT JOIN agent_instances", "LEFT JOIN agents"]) {
			expect(reads[0].sql).toContain(t);
		}
		expect(reads[0].sql).not.toMatch(/\bINNER JOIN\b/);
	});

	it("prefers the owner's own rename over the agent's name (#698)", async () => {
		// The notification says "Chess coder 2 went to sleep", and that is the name the OWNER gave
		// this instance in the console — an agent-name fallback is for an instance never renamed.
		const { env, reads } = readEnv([
			{ id: "csess_1", instance_id: "i", user_id: "u", repo_id: "r", runner_node: null, client_type: "claude", last_activity_at: 42, repo_name: "chess-academy", instance_name: "Chess coder 2" },
		]);
		expect(reads.length).toBe(0);
		const [row] = await listIdleSessions(env, 1, 1);
		expect(reads[0].sql).toContain("json_extract(i.config, '$.displayName')");
		expect(row).toMatchObject({ instanceName: "Chess coder 2", repoName: "chess-academy", clientType: "claude", lastActivityAt: 42 });
	});

	it("normalises an unknown engine rather than passing it through", async () => {
		// `clientType` decides whether the sleep notification may promise the conversation at all.
		// An unrecognised value must land on the same default `createSession` would have written.
		const { env } = readEnv([
			{ id: "csess_1", instance_id: "i", user_id: "u", repo_id: "r", runner_node: null, client_type: "wat", last_activity_at: null, repo_name: null, instance_name: null },
		]);
		const [row] = await listIdleSessions(env, 1, 1);
		expect(row).toMatchObject({ clientType: "claude", lastActivityAt: null, repoName: null, instanceName: null });
	});
});

describe("listInstancesWithQuietSessions — the reconcile's input (#275)", () => {
	it("is quiet-gated, because reconciling costs a relay round trip per instance", async () => {
		// A session being captured every 3 seconds is self-evidently not orphaned, so the common
		// case — somebody actually working — must cost nothing.
		const { env, reads } = readEnv();
		await listInstancesWithQuietSessions(env, 99, 25);
		expect(reads[0].sql).toContain("status = 'active'");
		expect(reads[0].args).toEqual([99, 25]);
	});
});
