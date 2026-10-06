import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeBusyHolder } from "./loop-busy.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const NOW = 1_800_000_000_000;

describe("describeBusyHolder — what a busy repo is busy WITH (#886)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'platform'), ('r2', 'i1', 'u1', 'other')`);
		env = { DB: d1.DB } as unknown as Env;
	});
	afterEach(() => d1.close());

	const run = (runId: string, repoId: string, status = "running") => {
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s-${runId}', 'i1', '${repoId}', 'u1')`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id)
		  VALUES ('${runId}', 'u1', 'i1', 'Work issue #48', '${status}', 10, ${NOW - 60_000}, 's-${runId}')`);
	};
	const receipt = (requestId: string, state: string, opts: { repoId?: string; runId?: string; ageMs?: number } = {}) => {
		const input = JSON.stringify({ objective: `objective of ${requestId}`, repoId: opts.repoId ?? null });
		const response = opts.runId ? `'${JSON.stringify({ runId: opts.runId })}'` : "NULL";
		const at = NOW - (opts.ageMs ?? 10_000);
		d1.exec(`INSERT INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, response_json, created_at, updated_at)
		  VALUES ('u1', 'i1', '${requestId}', '${input}', '${state}', ${response}, ${at}, ${at})`);
	};
	const holder = (repoId: string | undefined = "r1", excludeRequestId?: string) =>
		describeBusyHolder(env, { userId: "u1", instanceId: "i1", repoId, excludeRequestId, now: NOW });

	it("names the run holding the repo and the request id that started it", async () => {
		run("run-1", "r1");
		receipt("req-A", "started", { repoId: "r1", runId: "run-1" });
		expect(await holder()).toEqual({
			// `sessionId` is the run's live view — what the console links the refusal to (#931).
			activeRun: { runId: "run-1", objective: "Work issue #48", startedAt: NOW - 60_000, requestId: "req-A", sessionId: "s-run-1" },
			inFlightStarts: [],
		});
	});

	it("says a run was started without a request id rather than guessing one", async () => {
		run("run-1", "r1");
		expect((await holder()).activeRun?.requestId).toBeNull();
	});

	it("lists an accepted start still provisioning — the window before its run row exists", async () => {
		receipt("req-A", "provisioning", { repoId: "r1" });
		expect(await holder()).toEqual({ activeRun: null, inFlightStarts: [{ requestId: "req-A", objective: "objective of req-A", ageMs: 10_000 }] });
	});

	it("never lists the asking start's own receipt, a stale one, a settled one, or another repo's", async () => {
		receipt("req-self", "provisioning", { repoId: "r1" });
		receipt("req-stale", "provisioning", { repoId: "r1", ageMs: 6 * 60_000 });
		receipt("req-done", "started", { repoId: "r1", runId: "run-x" });
		receipt("req-other", "provisioning", { repoId: "r2" });
		expect((await holder("r1", "req-self")).inFlightStarts).toEqual([]);
	});

	it("ignores a running run on another repo and a finished run on this one", async () => {
		run("run-2", "r2");
		run("run-old", "r1", "completed");
		expect((await holder()).activeRun).toBeNull();
	});
});
