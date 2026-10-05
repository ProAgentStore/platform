import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDuplicateObjective, referencedIssue } from "./objective-dedupe.js";
import { cancelQueueEntry, enqueueObjective } from "./objective-queue.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

describe("referencedIssue — which GitHub issue an objective is about (#925)", () => {
	it.each([
		["Work issue #925 on ProAgentStore/platform.", 925],
		["fix issue 925", 925],
		["Implement https://github.com/ProAgentStore/platform/issues/925 end to end", 925],
		["ProAgentStore/platform#925: add the guard", 925],
		["#925 — duplicate guard", 925],
		["Fix the flaky test (#925)", 925],
	])("%s → %s", (objective, issue) => {
		expect(referencedIssue(objective)).toBe(issue);
	});

	it("takes the issue the objective LEADS with, preferring an explicit reference over a passing #N", () => {
		expect(referencedIssue("Work issue #920. The prior #919 run pushed without a green suite.")).toBe(920);
		expect(referencedIssue("Following up #919 context: now work issue #920")).toBe(920);
		expect(referencedIssue("Fix #12, then #13")).toBe(12);
	});

	it("names no issue for an objective that has none, or only a pull request", () => {
		expect(referencedIssue("Refactor the console header")).toBeNull();
		expect(referencedIssue("Rebase PR #44 onto main")).toBeNull();
		expect(referencedIssue("Review https://github.com/o/r/pull/44")).toBeNull();
		expect(referencedIssue("Bump to v1.2.3 and color #fff")).toBeNull();
	});
});

describe("findDuplicateObjective — the same issue already waiting or running on this repo (#925)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
		seedTenant(d1, { userId: "u2", instanceIds: ["x1"] });
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'platform'), ('r2', 'i1', 'u1', 'other')`);
		env = { DB: d1.DB } as unknown as Env;
	});
	afterEach(() => d1.close());

	const find = (objective: string, repoId: string | undefined = "r1", instanceId = "i1", userId = "u1") =>
		findDuplicateObjective(env, { userId, instanceId, repoId, objective });
	const running = (runId: string, objective: string, repoId: string, sessionId = `s-${runId}`) => {
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('${sessionId}', 'i1', '${repoId}', 'u1')`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('${runId}', 'u1', 'i1', '${objective}', 'running', 10, 1, '${sessionId}')`);
	};

	it("finds a pending entry for the same issue on the same repo, however it is phrased", async () => {
		const first = await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "Work issue #925 on ProAgentStore/platform." });
		expect(await find("Implement #925: server-side duplicate guard")).toEqual({ kind: "queued", entry: expect.objectContaining({ id: first.id }) });
	});

	it("does not match a different issue, a different repo, another instance or another owner", async () => {
		await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "Work issue #925" });
		expect(await find("Work issue #926")).toBeNull();
		expect(await find("Work issue #925", "r2")).toBeNull();
		expect(await find("Work issue #925", "r1", "i2")).toBeNull();
		expect(await find("Work issue #925", "r1", "x1", "u2")).toBeNull();
	});

	it("ignores terminal entries — a cancelled #925 does not block queueing #925 again", async () => {
		const e = await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "Work issue #925" });
		await cancelQueueEntry(env, e.id, "u1");
		expect(await find("Work issue #925")).toBeNull();
	});

	it("never matches an objective that names no issue — no text hashing, no guessing", async () => {
		await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "Refactor the header" });
		expect(await find("Refactor the header")).toBeNull();
	});

	it("finds the RUN holding the repo when it is on the same issue, and only on that repo", async () => {
		running("run-a", "Work issue #925", "r1");
		expect(await find("Retry: issue #925")).toEqual({ kind: "running", runId: "run-a", objective: "Work issue #925" });
		expect(await find("Retry: issue #925", "r2")).toBeNull();
		expect(await find("Work issue #7")).toBeNull();
	});

	it("prefers a waiting entry over the running run, since the entry is what a queued answer names", async () => {
		running("run-a", "Work issue #925", "r1");
		const e = await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "Work issue #925" });
		expect(await find("issue #925")).toEqual({ kind: "queued", entry: expect.objectContaining({ id: e.id }) });
	});

	it("an any-repo entry (no repo_id) counts for a named repo, as the queue itself reads it", async () => {
		const e = await enqueueObjective(env, { instanceId: "i1", userId: "u1", objective: "Work issue #925" });
		expect(await find("Work issue #925", "r1")).toEqual({ kind: "queued", entry: expect.objectContaining({ id: e.id }) });
	});
});
