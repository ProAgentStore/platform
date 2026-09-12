import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logError, runnerUpgradeRefusal, runnerUpgradeClause, callRunner, readRepoSync } = vi.hoisted(() => ({
	logError: vi.fn(),
	runnerUpgradeRefusal: vi.fn(),
	runnerUpgradeClause: vi.fn(),
	callRunner: vi.fn(),
	readRepoSync: vi.fn(),
}));
vi.mock("./error-log.js", () => ({ logError }));
vi.mock("./runner-upgrade.js", () => ({ runnerUpgradeRefusal, runnerUpgradeClause }));
vi.mock("./runner-client.js", () => ({ callRunner }));
vi.mock("./repo-sync.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./repo-sync.js")>()), readRepoSync }));

import {
	attemptSyncSelfHeal,
	describeSyncHeal,
	FAST_FORWARD_MIN_CLI,
	gateRunOnSync,
	REPAIR_RUN_HINT,
	REPAIR_RUN_OBJECTIVE,
	repairCheckoutObjective,
	skippedSyncHeal,
	syncFailureIsOldRunner,
	syncGateArmed,
	syncGateDecision,
	syncSelfHealEligible,
	SYNC_GATE_SOURCE,
	SYNC_HEAL_TIMEOUT_MS,
	type SyncHealOutcome,
} from "./repo-sync-gate.js";
import { REPO_SYNC_MIN_CLI, verdictFromSync } from "./repo-sync.js";
import type { RepoWorkingState } from "./repo-observation.js";
import type { RunnerConn } from "./runner-client.js";
import type { CodingRepo } from "./coding-types.js";
import type { Env } from "../types.js";

/** The string `runner-client.ts` builds for an endpoint a pre-0.4.58 CLI does not serve. */
const OLD_RUNNER = { error: 'Runner /coding/sync → 404: {"error":"Not found"}' };
const FRESH = { checked: true, branch: "main", upstream: "origin/main", localHead: "28057e13abcdef", remoteHead: "6da7c9a1abcdef", fetched: true, fetchedAt: 1, fetchError: null };

const ctx = { instanceId: "inst_1", userId: "user_1", sessionId: "csess_1", node: "mbp", repo: "ProAgentStore/platform" };
const env = {} as Env;

beforeEach(() => {
	logError.mockReset().mockResolvedValue(undefined);
	runnerUpgradeRefusal.mockReset().mockResolvedValue(`\`mbp\` needs a newer runner to check whether this checkout is up to date (it has 0.4.57) — this needs CLI ${REPO_SYNC_MIN_CLI} or newer.`);
	runnerUpgradeClause.mockReset().mockImplementation((f: { what: string; minCli: string; node?: string | null }) => `\`${f.node}\` cannot ${f.what} — it needs CLI ${f.minCli} or newer`);
	callRunner.mockReset();
	readRepoSync.mockReset();
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

const CLEAN: RepoWorkingState = { branch: "main", dirty: false, changedFiles: 0 };
const BEHIND = verdictFromSync({ ...FRESH, ahead: 0, behind: 19 });
const conn = { instanceId: "inst_1", userId: "user_1", runnerNode: "mbp" } as unknown as RunnerConn;
const repo = { id: "repo_1", workdir: "~/dev/stores/pags/platform", branch: "main" } as unknown as CodingRepo;

describe("syncSelfHealEligible — the ONE case a fast-forward is safe unattended (#802)", () => {
	it("is eligible for a clean checkout, behind, on its configured branch", () => {
		expect(syncSelfHealEligible(BEHIND, CLEAN, "main")).toEqual({ eligible: true, branch: "main", why: "" });
	});

	it("falls back to the branch the verdict is about when none is configured", () => {
		expect(syncSelfHealEligible(BEHIND, CLEAN, null)).toMatchObject({ eligible: true, branch: "main" });
	});

	it("is NOT eligible for anything but `behind` — in sync, ahead, diverged, unverified, or no verdict", () => {
		for (const v of [
			verdictFromSync({ ...FRESH, ahead: 0, behind: 0 }),
			verdictFromSync({ ...FRESH, ahead: 2, behind: 0 }),
			verdictFromSync({ ...FRESH, ahead: 1, behind: 2 }),
			verdictFromSync(OLD_RUNNER),
			null,
		]) {
			expect(syncSelfHealEligible(v, CLEAN, "main").eligible).toBe(false);
		}
		// Diverged in particular: a merge or rebase is a decision about somebody's commits.
		expect(syncSelfHealEligible(verdictFromSync({ ...FRESH, ahead: 1, behind: 2 }), CLEAN, "main").why).toBe("");
	});

	it("IS eligible on a dirty tree — git's own overwrite guard decides, not a count of porcelain lines (#804)", () => {
		// The Heartfull block: 18 commits behind, one untracked tooling folder, refused as "dirty".
		// A fast-forward carries nothing across, and git aborts by name if an incoming commit would
		// overwrite a local change — so the machine is asked and git answers.
		expect(syncSelfHealEligible(BEHIND, { ...CLEAN, dirty: true, changedFiles: 3 }, "main")).toEqual({ eligible: true, branch: "main", why: "" });
	});

	it("is NOT eligible off its branch, and names both branches", () => {
		const e = syncSelfHealEligible(BEHIND, { ...CLEAN, branch: "fix/1" }, "main");
		expect(e.eligible).toBe(false);
		expect(e.why).toContain("`fix/1`");
		expect(e.why).toContain("`main`");
	});

	it("is NOT eligible when the tree's state is unknown — unknown is not clean", () => {
		expect(syncSelfHealEligible(BEHIND, null, "main")).toMatchObject({ eligible: false });
		expect(syncSelfHealEligible(BEHIND, { ...CLEAN, branch: null }, "main").eligible).toBe(false);
		expect(syncSelfHealEligible(BEHIND, { branch: null, dirty: false, changedFiles: 0, notAGitRepo: true }, "main").eligible).toBe(false);
	});

	it("skippedSyncHeal turns an ineligible-with-reason into a recorded outcome, and nothing else", () => {
		expect(skippedSyncHeal(syncSelfHealEligible(BEHIND, { ...CLEAN, branch: "fix/1" }, "main"))).toMatchObject({ status: "skipped", branch: "main" });
		expect(skippedSyncHeal(syncSelfHealEligible(BEHIND, CLEAN, "main"))).toBeNull();
		// Not behind → nothing to say → nothing recorded.
		expect(skippedSyncHeal(syncSelfHealEligible(verdictFromSync({ ...FRESH, ahead: 0, behind: 0 }), CLEAN, "main"))).toBeNull();
	});
});

describe("attemptSyncSelfHeal — ask the machine, then believe only the re-read (#802)", () => {
	const wireOk = { ok: true, changed: true, branch: "main", upstream: "origin/main", from: "5b671b23aaaaaaaa", to: "0af538acbbbbbbbb", commits: 19, dirty: false };

	it("HEALED: the pull ran and an independent re-read says in sync — the gate then passes", async () => {
		callRunner.mockResolvedValue(wireOk);
		readRepoSync.mockResolvedValue(verdictFromSync({ ...FRESH, ahead: 0, behind: 0 }));
		const h = await attemptSyncSelfHeal(conn, { repo, sessionId: "csess_1", branch: "main" });
		expect(h).toMatchObject({ status: "healed", branch: "main", from: "5b671b23", to: "0af538ac", commits: 19 });
		expect(h.sync?.state).toBe("in_sync");
		expect(callRunner).toHaveBeenCalledWith(conn, "/coding/git-write", { sessionId: "csess_1", workDir: repo.workdir, cmd: "fast-forward", branch: "main" }, { timeoutMs: SYNC_HEAL_TIMEOUT_MS });
		const out = await gateRunOnSync(env, { ...ctx, heal: h }, h.sync);
		expect(out.blocked).toBe(false);
		expect(logError).not.toHaveBeenCalled();
	});

	it("UNCONFIRMED when the pull says it ran but the re-read still says behind — the writer's own account is not enough", async () => {
		callRunner.mockResolvedValue(wireOk);
		readRepoSync.mockResolvedValue(BEHIND);
		const h = await attemptSyncSelfHeal(conn, { repo, sessionId: null, branch: "main" });
		expect(h.status).toBe("unconfirmed");
		expect(h.detail).toContain("still reads");
		expect(h.sync?.state).toBe("behind");
	});

	it("UNCONFIRMED when the re-read itself failed", async () => {
		callRunner.mockResolvedValue(wireOk);
		readRepoSync.mockRejectedValue(new Error("relay closed"));
		expect((await attemptSyncSelfHeal(conn, { repo, sessionId: null, branch: "main" })).status).toBe("unconfirmed");
	});

	it("NOOP when the machine found nothing to bring in and the re-read agrees", async () => {
		callRunner.mockResolvedValue({ ...wireOk, changed: false, commits: 0, to: wireOk.from });
		readRepoSync.mockResolvedValue(verdictFromSync({ ...FRESH, ahead: 0, behind: 0 }));
		expect((await attemptSyncSelfHeal(conn, { repo, sessionId: null, branch: "main" })).status).toBe("noop");
	});

	it("REFUSED by the machine's own precondition, in the owner's language, and no re-read is attempted", async () => {
		callRunner.mockResolvedValue({ ok: false, changed: false, branch: "main", refused: "dirty", dirty: true });
		const h = await attemptSyncSelfHeal(conn, { repo, sessionId: null, branch: "main" });
		expect(h.status).toBe("refused");
		expect(h.detail).toContain("uncommitted changes");
		expect(readRepoSync).not.toHaveBeenCalled();
	});

	it("FAILED with git's own sentence when --ff-only refused a divergence", async () => {
		callRunner.mockResolvedValue({ ok: false, changed: false, branch: "main", upstream: "origin/main", from: "5b671b23aaaaaaaa", to: "5b671b23aaaaaaaa", error: "Not possible to fast-forward, aborting." });
		const h = await attemptSyncSelfHeal(conn, { repo, sessionId: null, branch: "main" });
		expect(h.status).toBe("failed");
		expect(h.detail).toContain("Not possible to fast-forward");
	});

	it("UNSUPPORTED on a runner without the verb — whether it 404s the endpoint or 400s the verb — naming the machine and the floor", async () => {
		for (const msg of ['Runner /coding/git-write → 404: {"error":"Not found"}', 'Runner /coding/git-write → 400: {"error":"unsupported git write command: fast-forward"}']) {
			callRunner.mockRejectedValue(new Error(msg));
			const h = await attemptSyncSelfHeal(conn, { repo, sessionId: null, branch: "main" });
			expect(h.status).toBe("unsupported");
			expect(h.detail).toContain("mbp");
			expect(h.detail).toContain(FAST_FORWARD_MIN_CLI);
		}
	});

	it("never throws — a heal that crashed the run it was rescuing would be worse than the block", async () => {
		callRunner.mockRejectedValue(new Error("Runner /coding/git-write → 500: boom"));
		await expect(attemptSyncSelfHeal(conn, { repo, sessionId: null, branch: "main" })).resolves.toMatchObject({ status: "failed" });
	});
});

describe("the refusal carries the heal's story (#802)", () => {
	const skipped: SyncHealOutcome = { status: "skipped", detail: "it was not fast-forwarded because the working tree has 2 uncommitted files — commit or move that work first", branch: "main", from: null, to: null, commits: null, sync: null };

	it("a heal that was not attempted says so, BEFORE the remedy, and is on the record", async () => {
		const out = await gateRunOnSync(env, { ...ctx, heal: skipped }, BEHIND);
		expect(out.blocked).toBe(true);
		expect(out.message).toContain("A fast-forward was not attempted: it was not fast-forwarded because the working tree has 2 uncommitted files");
		expect(out.message.indexOf("not attempted")).toBeLessThan(out.message.indexOf("git pull --ff-only"));
		expect(logError.mock.calls[0][1].context.heal).toEqual({ status: "skipped", detail: skipped.detail });
	});

	it("a heal that failed says what git said", async () => {
		const failed: SyncHealOutcome = { ...skipped, status: "failed", detail: "the fast-forward failed: Not possible to fast-forward, aborting." };
		const out = await gateRunOnSync(env, { ...ctx, heal: failed }, BEHIND);
		expect(out.message).toContain("attempted first and did not happen: the fast-forward failed: Not possible to fast-forward");
	});

	it("a heal that happened is not in the refusal — there is no refusal", async () => {
		const healed: SyncHealOutcome = { ...skipped, status: "healed", detail: "", from: "5b671b23", to: "0af538ac", commits: 19, sync: verdictFromSync({ ...FRESH, ahead: 0, behind: 0 }) };
		const out = await gateRunOnSync(env, { ...ctx, heal: healed }, healed.sync);
		expect(out.blocked).toBe(false);
		expect(out.message).toBe("");
	});

	it("describeSyncHeal — the timeline sentence names what arrived and the undo", () => {
		const healed: SyncHealOutcome = { ...skipped, status: "healed", detail: "", from: "5b671b23", to: "0af538ac", commits: 19, sync: null };
		const s = describeSyncHeal(healed);
		expect(s).toContain("Fast-forwarded `main` by 19 commits (5b671b23 → 0af538ac)");
		expect(s).toContain("Undo: `git reset --keep 5b671b23`");
		expect(describeSyncHeal({ ...healed, commits: 1 })).toContain("by 1 commit (");
		expect(describeSyncHeal({ ...healed, status: "noop" })).toContain("already current");
		expect(describeSyncHeal(skipped)).toMatch(/^A fast-forward was not attempted: /);
	});
});

describe("the repair run — the way out that needs no hands on the machine (#804)", () => {
	it("a block for a BEHIND or DIVERGED checkout ends by naming the repair run", async () => {
		for (const v of [BEHIND, verdictFromSync({ ...FRESH, ahead: 1, behind: 2 })]) {
			const out = await gateRunOnSync(env, ctx, v);
			expect(out.blocked).toBe(true);
			expect(out.message).toContain("repair_checkout: true");
			expect(out.message.endsWith(REPAIR_RUN_HINT)).toBe(true);
		}
	});

	it("a block an old or unreachable runner caused does NOT — a run cannot upgrade a CLI or wake a machine", async () => {
		for (const v of [verdictFromSync(OLD_RUNNER), verdictFromSync({ error: "Runner /coding/sync → 504: Runner disconnected" }), null]) {
			const out = await gateRunOnSync(env, ctx, v);
			expect(out.blocked).toBe(true);
			expect(out.message).not.toContain("repair_checkout");
		}
	});

	it("a REPAIR run is let through with the verdict stated, and nothing is filed to error_log", async () => {
		const out = await gateRunOnSync(env, { ...ctx, repair: true }, verdictFromSync({ ...FRESH, ahead: 1, behind: 2 }));
		expect(out.blocked).toBe(false);
		expect(out.decision.block).toBe(true);
		expect(out.message).toContain("REPAIR run");
		expect(out.message).toContain("DIVERGED");
		expect(logError).not.toHaveBeenCalled();
	});

	it("a repair run on a checkout that is fine simply passes", async () => {
		const out = await gateRunOnSync(env, { ...ctx, repair: true }, verdictFromSync({ ...FRESH, ahead: 0, behind: 0 }));
		expect(out).toMatchObject({ blocked: false, message: "" });
	});

	describe("repairCheckoutObjective — the brief the Pilot gets instead of an objective", () => {
		const base = { repoLabel: "ProAgentStore/platform", branch: "main", heal: null, state: CLEAN };

		it("states the goal against the real upstream, the facts just read, and the one invariant", () => {
			const o = repairCheckoutObjective({ ...base, sync: BEHIND, state: { ...CLEAN, dirty: true, changedFiles: 1 } });
			expect(o).toMatch(/^REPAIR THE CHECKOUT/);
			expect(o).toContain("`main...origin/main`");
			expect(o).toContain("19 commits BEHIND origin/main");
			expect(o).toContain("1 uncommitted file ");
			expect(o).toContain("every commit and every uncommitted change that exists now must still exist somewhere");
		});

		it("forbids every discarding command and any push, by name", () => {
			const o = repairCheckoutObjective({ ...base, sync: BEHIND });
			for (const cmd of ["git reset --hard", "git checkout .", "git restore", "git clean", "git stash drop", "git branch -D", "--force", "git push"]) {
				expect(o).toContain(cmd);
			}
			expect(o).toContain("No feature or ticket work");
		});

		it("parks rather than deletes — wip/ branches for uncommitted work AND for diverged commits, with --keep not --hard", () => {
			const o = repairCheckoutObjective({ ...base, sync: verdictFromSync({ ...FRESH, ahead: 1, behind: 2 }) });
			expect(o).toContain("git checkout -b wip/");
			expect(o).toContain("git branch wip/");
			expect(o).toContain("git reset --keep origin/main");
			expect(o).toContain("Never merge or rebase them on your own initiative");
		});

		it("carries a failed self-heal's sentence, so the run knows what was already tried", () => {
			const heal: SyncHealOutcome = { status: "failed", detail: "the fast-forward failed: Your local changes to the following files would be overwritten by merge: a.txt", branch: "main", from: null, to: null, commits: null, sync: null };
			expect(repairCheckoutObjective({ ...base, sync: BEHIND, heal })).toContain("would be overwritten by merge: a.txt");
		});

		it("names the branch the checkout is on when it is the wrong one", () => {
			expect(repairCheckoutObjective({ ...base, sync: BEHIND, state: { ...CLEAN, branch: "fix/1" } })).toContain("It is on branch `fix/1`, not `main`.");
		});

		it("the owner's words ride along as a NOTE, and the fixed label does not", () => {
			expect(repairCheckoutObjective({ ...base, sync: BEHIND, ownerNote: "the .claude folder is cruft, park it" })).toContain("OWNER'S NOTE (context only");
			expect(repairCheckoutObjective({ ...base, sync: BEHIND, ownerNote: REPAIR_RUN_OBJECTIVE })).not.toContain("OWNER'S NOTE");
		});

		it("finishes only on a confirmed-clean status line, and never by guessing", () => {
			const o = repairCheckoutObjective({ ...base, sync: BEHIND });
			expect(o).toContain("finish(status:'done') ONLY when");
			expect(o).toContain("do not guess");
		});
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

	it("tries the self-heal in its own step, BETWEEN the read and the gate, and gates on the re-read (#802)", () => {
		expect(source).toContain('step.do("repo-self-heal"');
		expect(source.indexOf('step.do("repo-state-start"')).toBeLessThan(source.indexOf('step.do("repo-self-heal"'));
		expect(source.indexOf('step.do("repo-self-heal"')).toBeLessThan(source.indexOf('step.do("repo-sync-gate"'));
		// The verdict the gate sees is the checkout as it IS after the heal, never the pre-heal read.
		expect(source).toContain("const syncAtStart = heal?.sync ?? repoStart.sync;");
		expect(source).toContain("heal, repair }, syncAtStart)");
	});

	it("a repair run gets the brief INSTEAD of its objective, and not the advisory notes that would tell it to stop (#804)", () => {
		expect(source).toContain("const repair = goal.repairCheckout === true;");
		expect(source).toContain("goal.objective = repairCheckoutObjective({");
		expect(source).toContain("if (!repair && (stateNote || syncNote))");
		// The brief is composed BEFORE the gate reads `repair`, and the gate is told.
		expect(source.indexOf("const repair = goal.repairCheckout")).toBeLessThan(source.indexOf('step.do("repo-sync-gate"'));
	});

	it("tells the owner a pointer moved on their checkout, with the undo, on every surface (#802)", () => {
		expect(source).toContain("describeSyncHeal(heal)");
		expect(source).toContain('"coding.run.self_heal"');
		expect(source).toContain("**Repository fast-forwarded**");
	});

	it("tells the owner on every surface, not just in the outcome field", () => {
		// #800's whole failure mode was that the fact existed only in a raw log nobody read.
		expect(source).toContain("content: syncGate.message");
		expect(source).toContain('"coding.run.blocked"');
		expect(source).toContain("**Run stopped — unconfirmed base**");
	});
});
