import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logError, runnerUpgradeRefusal } = vi.hoisted(() => ({ logError: vi.fn(), runnerUpgradeRefusal: vi.fn() }));
vi.mock("./error-log.js", () => ({ logError }));
vi.mock("./runner-upgrade.js", () => ({ runnerUpgradeRefusal }));

import { gateRunOnSync, syncFailureIsOldRunner, syncGateArmed, syncGateDecision, SYNC_GATE_SOURCE } from "./repo-sync-gate.js";
import { REPO_SYNC_MIN_CLI, verdictFromSync } from "./repo-sync.js";
import type { Env } from "../types.js";

/** The string `runner-client.ts` builds for an endpoint a pre-0.4.58 CLI does not serve. */
const OLD_RUNNER = { error: 'Runner /coding/sync → 404: {"error":"Not found"}' };
const FRESH = { checked: true, branch: "main", upstream: "origin/main", localHead: "28057e13abcdef", remoteHead: "6da7c9a1abcdef", fetched: true, fetchedAt: 1, fetchError: null };

const ctx = { instanceId: "inst_1", userId: "user_1", sessionId: "csess_1", node: "mbp", repo: "ProAgentStore/platform" };
const env = {} as Env;

beforeEach(() => {
	logError.mockReset().mockResolvedValue(undefined);
	runnerUpgradeRefusal.mockReset().mockResolvedValue(`\`mbp\` needs a newer runner to check whether this checkout is up to date (it has 0.4.57) — this needs CLI ${REPO_SYNC_MIN_CLI} or newer.`);
});

describe("syncGateDecision — which verdicts may start a run (#801)", () => {
	it("passes a checkout confirmed current", () => {
		expect(syncGateDecision(verdictFromSync({ ...FRESH, ahead: 0, behind: 0 })).block).toBe(false);
	});

	it("passes a checkout that is AHEAD — unpushed work does not make the base stale", () => {
		expect(syncGateDecision(verdictFromSync({ ...FRESH, ahead: 2, behind: 0 })).block).toBe(false);
	});

	it("passes a checkout with NO UPSTREAM — there is no remote it could be behind", () => {
		// The alternative blocks every local-only repo forever, to protect it from a staleness that
		// cannot exist.
		expect(syncGateDecision(verdictFromSync({ ...FRESH, upstream: null, ahead: null, behind: null })).block).toBe(false);
	});

	it("BLOCKS a checkout that is behind, and the remedy is a fast-forward", () => {
		const d = syncGateDecision(verdictFromSync({ ...FRESH, ahead: 0, behind: 6 }));
		expect(d.block).toBe(true);
		expect(d.reason).toBe("behind");
		expect(d.detail).toContain("6 commits BEHIND origin/main");
		expect(d.remedy).toContain("git pull --ff-only");
	});

	it("BLOCKS a diverged checkout and does NOT offer a fast-forward that cannot work", () => {
		const d = syncGateDecision(verdictFromSync({ ...FRESH, ahead: 1, behind: 2 }));
		expect(d.block).toBe(true);
		expect(d.reason).toBe("diverged");
		expect(d.remedy).not.toContain("--ff-only");
	});

	it("BLOCKS an old runner's 404 and marks it as version skew, not as an unreachable machine", () => {
		const d = syncGateDecision(verdictFromSync(OLD_RUNNER));
		expect(d.block).toBe(true);
		expect(d.reason).toBe("old_runner");
		// The remedy is left to `runner-upgrade.ts`, which is the only thing that knows the machine.
		expect(d.remedy).toBe("");
	});

	it("BLOCKS a machine that did not answer at all, separately from one that is merely old", () => {
		const d = syncGateDecision(verdictFromSync({ error: "Runner /coding/sync → 504: Runner disconnected" }));
		expect(d.block).toBe(true);
		expect(d.reason).toBe("unverified");
	});

	it("BLOCKS when the check itself threw and there is no verdict at all", () => {
		// `coding-session.ts` reads the sync inside `.catch(() => null)`.
		expect(syncGateDecision(null).block).toBe(true);
		expect(syncGateDecision(null).reason).toBe("unverified");
	});
});

describe("syncFailureIsOldRunner — a 404 is version skew; everything else is not", () => {
	it.each([
		['Runner /coding/sync → 404: {"error":"Not found"}', true],
		["Runner /coding/sync → 404: not found", true],
		["Runner /coding/sync → 504: Runner disconnected", false],
		["Runner /coding/sync → 503: no socket", false],
		["", false],
	])("%s -> %s", (msg, expected) => {
		expect(syncFailureIsOldRunner(msg)).toBe(expected);
	});

	it("is false for a missing error, so an answered check is never read as skew", () => {
		expect(syncFailureIsOldRunner(null)).toBe(false);
		expect(syncFailureIsOldRunner(undefined)).toBe(false);
	});
});

describe("syncGateArmed — on by default, one variable to stand it down", () => {
	it("is armed when nothing is set", () => {
		expect(syncGateArmed({})).toBe(true);
	});

	it.each(["off", "OFF", "0", "false", " off "])("is disarmed by %s", (v) => {
		expect(syncGateArmed({ CODING_SYNC_GATE: v })).toBe(false);
	});

	it("stays armed for any other value — a typo must not silently disarm it", () => {
		expect(syncGateArmed({ CODING_SYNC_GATE: "on" })).toBe(true);
		expect(syncGateArmed({ CODING_SYNC_GATE: "no" })).toBe(true);
	});
});

describe("gateRunOnSync — the sentence and the operator's record (#801)", () => {
	it("a 404 blocks the run and the message NAMES the machine and the minimum CLI", async () => {
		const out = await gateRunOnSync(env, ctx, verdictFromSync(OLD_RUNNER));
		expect(out.blocked).toBe(true);
		expect(out.message).toContain("stopped before it started");
		expect(out.message).toContain(REPO_SYNC_MIN_CLI);
		expect(out.message).toContain("mbp");
		// The whole defect: the owner used to get this and nothing else.
		expect(out.message).not.toBe('Whether this checkout is up to date could not be checked: Runner /coding/sync → 404: {"error":"Not found"}');
		expect(runnerUpgradeRefusal).toHaveBeenCalledWith(env, "inst_1", "user_1", { what: "check whether this checkout is up to date", minCli: REPO_SYNC_MIN_CLI });
	});

	it("still says something useful when the machine cannot be named", async () => {
		runnerUpgradeRefusal.mockRejectedValue(new Error("D1 unavailable"));
		const out = await gateRunOnSync(env, ctx, verdictFromSync(OLD_RUNNER));
		expect(out.blocked).toBe(true);
		expect(out.message).toContain(REPO_SYNC_MIN_CLI);
	});

	it("a confirmed-behind checkout blocks, and the message tells the owner to pull", async () => {
		const out = await gateRunOnSync(env, ctx, verdictFromSync({ ...FRESH, ahead: 0, behind: 6 }));
		expect(out.blocked).toBe(true);
		expect(out.message).toContain("6 commits BEHIND origin/main");
		expect(out.message).toContain("git pull --ff-only");
		// Not a version problem, so it must not send the owner to upgrade a CLI that is fine.
		expect(runnerUpgradeRefusal).not.toHaveBeenCalled();
	});

	it("a confirmed-current checkout proceeds, silently and with nothing logged", async () => {
		const out = await gateRunOnSync(env, ctx, verdictFromSync({ ...FRESH, ahead: 0, behind: 0 }));
		expect(out.blocked).toBe(false);
		expect(out.message).toBe("");
		expect(logError).not.toHaveBeenCalled();
	});

	it("files the 404 at ERROR under one source, with the node and the raw error kept verbatim", async () => {
		await gateRunOnSync(env, ctx, verdictFromSync(OLD_RUNNER));
		expect(logError).toHaveBeenCalledTimes(1);
		const row = logError.mock.calls[0][1];
		expect(row.source).toBe(SYNC_GATE_SOURCE);
		expect(row.level).toBe("error");
		expect(row.status).toBe(404);
		expect(row.userId).toBe("user_1");
		expect(row.context.node).toBe("mbp");
		expect(row.context.reason).toBe("old_runner");
		expect(row.context.error).toContain("404");
		expect(row.context.minCli).toBe(REPO_SYNC_MIN_CLI);
	});

	it("files a merely-behind checkout at WARN, so it cannot drown the 404s in the same query", async () => {
		await gateRunOnSync(env, ctx, verdictFromSync({ ...FRESH, ahead: 0, behind: 6 }));
		const row = logError.mock.calls[0][1];
		expect(row.level).toBe("warn");
		expect(row.status).toBeUndefined();
	});

	it("REPEATED 404s from one machine land in the same collapse bucket, which is what makes them visible", async () => {
		// `logError` keys a repeat on source + message + level + status + user. Three runs on the
		// same broken machine must therefore produce ONE row with repeat_count 3 — the operator's
		// view #801 asks for. Asserted as "the key is identical", since the collapse itself is
		// `error-log.ts`'s behaviour and is tested there.
		const v = verdictFromSync(OLD_RUNNER);
		await gateRunOnSync(env, ctx, v);
		await gateRunOnSync(env, ctx, v);
		await gateRunOnSync(env, ctx, v);
		expect(logError).toHaveBeenCalledTimes(3);
		const keys = logError.mock.calls.map(([, e]) => [e.source, e.message, e.level, e.status, e.userId].join("|"));
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toContain("old_runner");
	});

	it("DISARMED: the run proceeds, the message says so, and the record is still written", async () => {
		const out = await gateRunOnSync({ CODING_SYNC_GATE: "off" } as Env, ctx, verdictFromSync(OLD_RUNNER));
		expect(out.blocked).toBe(false);
		// The decision is unchanged — only the enforcement is off, which is what makes the row
		// worth keeping rather than reverting the whole gate.
		expect(out.decision.block).toBe(true);
		expect(out.message).toContain("proceeding anyway");
		expect(logError).toHaveBeenCalledTimes(1);
		expect(logError.mock.calls[0][1].context.armed).toBe(false);
	});

	it("never throws when the record cannot be written — bookkeeping does not fail runs", async () => {
		logError.mockRejectedValue(new Error("D1 down"));
		await expect(gateRunOnSync(env, ctx, verdictFromSync({ ...FRESH, ahead: 0, behind: 1 }))).resolves.toMatchObject({ blocked: true });
	});
});

/**
 * The WIRING, asserted from source.
 *
 * `coding-session.ts` is a Cloudflare Workflow and a Workflow can only be tested by running one,
 * so the call shape is read off the file — the way `coding-resume-note.test.ts` and
 * `coding-run-report.test.ts` assert theirs. Everything above proves the gate DECIDES correctly;
 * this is the half that proves the run actually obeys it, which is the entire point of #801 and
 * the thing #785 was missing.
 */
describe("the wiring — a blocked run does not reach the loop (#801)", () => {
	const source = readFileSync(join(__dirname, "..", "workflows", "coding-session.ts"), "utf8");

	it("read the workflow at all — so a rename fails loudly instead of passing empty", () => {
		expect(source.length, "read no workflow source — this guard is measuring nothing").toBeGreaterThan(10_000);
	});

	it("asks the gate in its own durable step, against the start-of-run verdict", () => {
		expect(source).toContain('step.do("repo-sync-gate"');
		expect(source).toContain("repoStart.sync");
	});

	it("SETS the result rather than throwing — a thrown gate would read as a crash and be replayed", () => {
		// `codingCrashReport` turns a thrown error into "run error:", which is exactly the
		// indistinguishable-from-a-real-failure problem #523 closed. And `driverResumePlan` would
		// replay the run against the same unconfirmed base it was just stopped for.
		expect(source).toContain('if (syncGate.blocked) result = { outcome: "failed", detail: syncGate.message, steps: 0 };');
		expect(source).not.toContain("throw new SyncGate");
	});

	it("stops the round loop from running at all", () => {
		// The assignment alone is not the fix: without this the loop overwrites `result` on its
		// first round and the run proceeds exactly as #800 did.
		expect(source).toContain("for (let round = 0; round < 12 && !syncGate.blocked; round++)");
	});

	it("decides BEFORE the loop, not inside it", () => {
		expect(source.indexOf('step.do("repo-sync-gate"')).toBeLessThan(source.indexOf("for (let round = 0; round < 12"));
	});

	it("tells the owner on every surface, not just in the outcome field", () => {
		// #800's whole failure mode was that the fact existed only in a raw log nobody read.
		expect(source).toContain("content: syncGate.message");
		expect(source).toContain('"coding.run.blocked"');
		expect(source).toContain("**Run stopped — unconfirmed base**");
	});
});
