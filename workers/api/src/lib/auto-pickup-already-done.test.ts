/**
 * #1407 — an already_done, still-open issue is closed (citing the finishing run) when CI is green on
 * the commit it delivered, else flagged `needs-human` for a person. GitHub itself is faked through
 * `AlreadyDoneDeps`, the same injection shape `AutoPickupDeps` uses for its own GitHub calls — not by
 * mocking `fetch` through a real GitHub App installation this test has no reason to stand up. The
 * commit-finding read (`runDeliveredSha`) IS run for real, against the real schema's `agent_events`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { ciStatusFromRuns, handleAlreadyDoneOpenIssue, runDeliveredSha, type AlreadyDoneDeps } from "./auto-pickup-already-done.js";
import type { Env } from "../types.js";

describe("ciStatusFromRuns", () => {
	it("unknown when the body carries no workflow_runs array", () => {
		expect(ciStatusFromRuns(null)).toBe("unknown");
		expect(ciStatusFromRuns({})).toBe("unknown");
	});
	it("pending when there are no runs yet for the commit", () => {
		expect(ciStatusFromRuns({ workflow_runs: [] })).toBe("pending");
	});
	it("failure when any completed run did not succeed, skip, or stay neutral", () => {
		expect(ciStatusFromRuns({ workflow_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] })).toBe("failure");
	});
	it("pending while something is still running, even beside a success", () => {
		expect(ciStatusFromRuns({ workflow_runs: [{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }] })).toBe("pending");
	});
	it("success once every run has completed and none failed", () => {
		expect(ciStatusFromRuns({ workflow_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }, { status: "completed", conclusion: "neutral" }] })).toBe("success");
	});
});

describe("runDeliveredSha", () => {
	let d1: RealSchemaD1;
	let env: Env;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
		env = { DB: d1.DB } as unknown as Env;
	});
	afterEach(() => d1.close());

	const act = (seq: number, context: unknown) =>
		d1.exec(`INSERT INTO agent_events (id, instance_id, user_id, trace_id, event, source, ts, context) VALUES ('ev-${seq}', 'coder', 'u1', 'run-1', 'act.consequential', 'coding', ${seq}, '${JSON.stringify(context).replace(/'/g, "''")}')`);

	it("the newest successful push.trunk's commit", async () => {
		act(1, { act: "push.trunk", ok: true, pushedSha: "a".repeat(40) });
		act(2, { act: "push.trunk", ok: true, pushedSha: "b".repeat(40) });
		expect(await runDeliveredSha(env, { instanceId: "coder", userId: "u1", runId: "run-1" })).toBe("b".repeat(40));
	});

	it("a refused push (ok: false) is not evidence of a delivered commit", async () => {
		act(1, { act: "push.trunk", ok: false, pushedSha: "a".repeat(40) });
		expect(await runDeliveredSha(env, { instanceId: "coder", userId: "u1", runId: "run-1" })).toBeNull();
	});

	it("a verified pr.merge's afterSha counts", async () => {
		act(1, { act: "pr.merge", ok: true, merge: { v: 1, repo: "acme/app", pr: 1, baseRef: "main", method: "squash", beforeSha: "a".repeat(40), afterSha: "c".repeat(40), mergedAt: "2026-01-01T00:00:00Z", mergedBy: "owner", actor: "owner" } });
		expect(await runDeliveredSha(env, { instanceId: "coder", userId: "u1", runId: "run-1" })).toBe("c".repeat(40));
	});

	it("no recorded act, or none that is a delivered push/merge, is null — never guessed", async () => {
		expect(await runDeliveredSha(env, { instanceId: "coder", userId: "u1", runId: "run-1" })).toBeNull();
		act(1, { act: "read", ok: true });
		expect(await runDeliveredSha(env, { instanceId: "coder", userId: "u1", runId: "run-1" })).toBeNull();
	});

	it("an unreadable act row is skipped, not thrown on", async () => {
		d1.exec(`INSERT INTO agent_events (id, instance_id, user_id, trace_id, event, source, ts, context) VALUES ('ev-bad', 'coder', 'u1', 'run-1', 'act.consequential', 'coding', 1, 'not json')`);
		act(2, { act: "push.trunk", ok: true, pushedSha: "d".repeat(40) });
		expect(await runDeliveredSha(env, { instanceId: "coder", userId: "u1", runId: "run-1" })).toBe("d".repeat(40));
	});
});

describe("handleAlreadyDoneOpenIssue (#1407)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	const base = { userId: "u1", instanceId: "coder", githubRepo: "acme/app", issue: 9, issueLabels: [] as string[], runId: "run-1" };

	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
		env = { DB: d1.DB } as unknown as Env;
	});
	afterEach(() => d1.close());

	const act = (context: unknown) => d1.exec(`INSERT INTO agent_events (id, instance_id, user_id, trace_id, event, source, ts, context) VALUES ('ev-h', 'coder', 'u1', 'run-1', 'act.consequential', 'coding', 1, '${JSON.stringify(context).replace(/'/g, "''")}')`);
	const open = { state: "open" };
	const noop = async () => true;

	it("closes, citing the run and commit, when CI is green on what it delivered", async () => {
		act({ act: "push.trunk", ok: true, pushedSha: "e".repeat(40) });
		let closed: unknown;
		const deps: AlreadyDoneDeps = { readIssueState: async () => open, ciStatusForCommit: async () => "success", close: async (a) => { closed = a; return true; }, flag: noop };
		const result = await handleAlreadyDoneOpenIssue(env, base, deps);
		expect(result).toEqual({ action: "closed", runId: "run-1", sha: "e".repeat(40) });
		expect(closed).toMatchObject({ githubRepo: "acme/app", issue: 9, runId: "run-1", sha: "e".repeat(40) });
	});

	it("flags, never closes, when CI failed on the delivered commit", async () => {
		act({ act: "push.trunk", ok: true, pushedSha: "e".repeat(40) });
		let flaggedReason = "";
		const deps: AlreadyDoneDeps = { readIssueState: async () => open, ciStatusForCommit: async () => "failure", close: async () => true, flag: async (a) => { flaggedReason = a.reason; return true; } };
		const result = await handleAlreadyDoneOpenIssue(env, base, deps);
		expect(result).toEqual({ action: "flagged", reason: expect.stringContaining("CI failed") });
		expect(flaggedReason).toContain("eeeeeee");
	});

	it("flags, never closes, when CI is pending or unreadable on the delivered commit", async () => {
		act({ act: "push.trunk", ok: true, pushedSha: "e".repeat(40) });
		for (const ci of ["pending", "unknown"] as const) {
			const deps: AlreadyDoneDeps = { readIssueState: async () => open, ciStatusForCommit: async () => ci, close: async () => true, flag: async () => true };
			const result = await handleAlreadyDoneOpenIssue(env, base, deps);
			expect(result.action, ci).toBe("flagged");
		}
	});

	it("flags, never closes, when no commit can be found for the finishing run", async () => {
		let flaggedReason = "";
		const deps: AlreadyDoneDeps = { readIssueState: async () => open, ciStatusForCommit: async () => "success", close: async () => true, flag: async (a) => { flaggedReason = a.reason; return true; } };
		const result = await handleAlreadyDoneOpenIssue(env, base, deps);
		expect(result.action).toBe("flagged");
		expect(flaggedReason).toContain("no delivered commit");
	});

	it("skips, writing nothing, when the issue is already closed on GitHub by the time it's checked", async () => {
		let flagCalled = false;
		const deps: AlreadyDoneDeps = { readIssueState: async () => ({ state: "closed" }), ciStatusForCommit: async () => "success", close: async () => true, flag: async () => { flagCalled = true; return true; } };
		expect(await handleAlreadyDoneOpenIssue(env, base, deps)).toEqual({ action: "skipped", reason: "already closed on GitHub" });
		expect(flagCalled).toBe(false);
	});

	it("reports skipped, not closed, when CI is green but the close write itself fails", async () => {
		act({ act: "push.trunk", ok: true, pushedSha: "e".repeat(40) });
		const deps: AlreadyDoneDeps = { readIssueState: async () => open, ciStatusForCommit: async () => "success", close: async () => false, flag: async () => false };
		expect(await handleAlreadyDoneOpenIssue(env, base, deps)).toEqual({ action: "skipped", reason: "CI is green but closing the issue failed" });
	});

	it("never throws: a dep that throws degrades to skipped", async () => {
		const deps: AlreadyDoneDeps = { readIssueState: async () => { throw new Error("network down"); } };
		const result = await handleAlreadyDoneOpenIssue(env, base, deps);
		expect(result.action).toBe("skipped");
	});
});
