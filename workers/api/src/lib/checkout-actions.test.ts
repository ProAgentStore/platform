/**
 * #1324 — stash / discard as runner actions, and the auto-stash on the pull-before-run self-heal,
 * over the real schema with only the runner call faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { AUTO_STASH_HINT, attemptSyncSelfHealWithStash, autoStashApproved, blockedByLocalChanges, CHECKOUT_CLEAN_MIN_CLI, describeCheckoutAction, readAutoStashPolicy, runCheckoutAction, type CheckoutCleanWire } from "./checkout-actions.js";
import { describeSyncHeal, type SyncHealOutcome } from "./repo-sync-gate.js";
import { RunnerUnreachableError } from "./runner-unreachable.js";
import type { RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, branch) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/work/repo', 'main')");
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const conn = { endpointUrl: "x", token: "t", instanceId: "i1", userId: "u1", relayName: "r", runnerNode: "tiny-laptop" } as unknown as RunnerConn;
const stashWire: CheckoutCleanWire = {
	ok: true,
	action: "stash",
	files: 59,
	backup: { kind: "stash", ref: "refs/pags/stash/20261023T195800", commit: "a".repeat(40) },
	head: "1b5192b4".padEnd(40, "0"),
	clean: true,
	pulled: { changed: true, from: "c7ccc582".padEnd(40, "0"), to: "1b5192b4".padEnd(40, "0"), commits: 2 },
};
const discardWire: CheckoutCleanWire = { ...stashWire, action: "discard", backup: { kind: "patch", path: "/work/repo/.git/pags-backups/x.patch", untrackedList: "/work/repo/.git/pags-backups/x.untracked.txt", untracked: 3 } };
const call = (wire: CheckoutCleanWire | Error, seen: Array<{ path: string; body: Record<string, unknown> }> = []) =>
	(async (_c: unknown, path: string, body: Record<string, unknown>) => {
		seen.push({ path, body });
		if (wire instanceof Error) throw wire;
		return wire;
	}) as never;
const base = { instanceId: "i1", userId: "u1", repoId: "r1", label: "run 0c59a0bf" };

describe("runCheckoutAction", () => {
	it("stash: asks the machine for a labelled stash + fast-forward and reports the backup, HEAD and clean state", async () => {
		const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
		const out = await runCheckoutAction(env, { ...base, action: "stash", pull: true }, { conn, call: call(stashWire, seen) });
		expect(out).toMatchObject({ ok: true, action: "stash", machine: "tiny-laptop" });
		expect(seen[0]).toMatchObject({ path: "/coding/checkout-clean", body: { workDir: "/work/repo", action: "stash", label: "run 0c59a0bf", pull: true, branch: "main" } });
		const summary = (out as { summary: string }).summary;
		expect(summary).toContain("Stashed 59 changed files");
		expect(summary).toContain("refs/pags/stash/20261023T195800");
		expect(summary).toContain("fast-forwarded to 1b5192b4");
		expect(summary).toContain("clean at 1b5192b4");
	});

	it("discard: reports the backup patch and says untracked contents were not kept", async () => {
		const out = await runCheckoutAction(env, { ...base, action: "discard", pull: true }, { conn, call: call(discardWire) });
		expect(out.ok).toBe(true);
		expect((out as { summary: string }).summary).toMatch(/Discarded 59 changed files\. Backup patch: .*x\.patch; 3 untracked files listed in .*untracked\.txt \(their contents were not kept\)/);
	});

	it("an unreachable machine is an explicit error naming it — nothing was run", async () => {
		const seen: unknown[] = [];
		const out = await runCheckoutAction(env, { ...base, action: "discard", node: "Macmini.modem" }, { conn: null, call: call(stashWire, seen as never) });
		expect(out).toMatchObject({ ok: false, reason: "unreachable", machine: "Macmini.modem" });
		expect((out as { error: string }).error).toMatch(/Macmini\.modem.*not connected.*nothing was changed/s);
		expect(seen).toEqual([]);
	});

	it("a machine that drops mid-call says it is not known whether the action ran", async () => {
		const out = await runCheckoutAction(env, { ...base, action: "stash" }, { conn, call: call(new RunnerUnreachableError("the relay has no live socket")) });
		expect(out).toMatchObject({ ok: false, reason: "unreachable" });
		expect((out as { error: string }).error).toContain("not known whether the stash ran");
	});

	it("refuses while a live run is working in the checkout, naming it, and calls nothing", async () => {
		d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')");
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-9', 'u1', 'i1', 'x', 'running', 10, ${Date.now()}, 's1')`);
		const seen: unknown[] = [];
		const out = await runCheckoutAction(env, { ...base, action: "discard" }, { conn, call: call(stashWire, seen as never) });
		expect(out).toMatchObject({ ok: false, reason: "busy" });
		expect((out as { error: string }).error).toContain("run run-9");
		expect(seen).toEqual([]);
	});

	it("a runner below the floor is told to upgrade, naming the CLI", async () => {
		const out = await runCheckoutAction(env, { ...base, action: "stash" }, { conn, call: call(new Error('Runner /coding/checkout-clean → 404: {"error":"Not found"}')) });
		expect(out).toMatchObject({ ok: false, reason: "old_runner" });
		expect((out as { error: string }).error).toContain(CHECKOUT_CLEAN_MIN_CLI);
	});

	it("a failure the machine reports comes back as failed, with what it did", async () => {
		const out = await runCheckoutAction(env, { ...base, action: "discard" }, { conn, call: call({ ...discardWire, ok: false, clean: false, error: "discard failed: index.lock exists" }) });
		expect(out).toMatchObject({ ok: false, reason: "failed" });
		expect((out as { error: string }).error).toContain("index.lock exists");
	});

	it("an unknown repo is a named 404-class failure", async () => {
		expect(await runCheckoutAction(env, { ...base, repoId: "nope", action: "stash" }, { conn, call: call(stashWire) })).toMatchObject({ ok: false, reason: "no_repo" });
	});

	it("a clean checkout has nothing to keep", () => {
		expect(describeCheckoutAction("stash", { ...stashWire, files: 0, backup: null, pulled: { changed: false, from: null, to: null, commits: 0 } })).toMatch(/no local changes/);
	});
});

describe("auto-stash on the pull-before-run self-heal", () => {
	const repo = { id: "r1", workdir: "/work/repo" } as never;
	const blocked: SyncHealOutcome = { status: "failed", detail: "the fast-forward failed: Your local changes to the following files would be overwritten by merge: docs/cli-overview.md", branch: "main", from: "c7ccc582", to: "c7ccc582", commits: null, sync: null };
	const healed: SyncHealOutcome = { status: "healed", detail: "", branch: "main", from: "c7ccc582", to: "1b5192b4", commits: 2, sync: null };
	const heals = (...outcomes: SyncHealOutcome[]) => {
		let i = 0;
		return (async () => outcomes[Math.min(i++, outcomes.length - 1)]) as never;
	};
	const input = { repo, sessionId: "s1", branch: "main", runLabel: "run 0c59a0bf" };

	it("detects a pull blocked by local changes (git's wording and the runner's dirty refusal), and nothing else", () => {
		expect(blockedByLocalChanges(blocked)).toBe(true);
		expect(blockedByLocalChanges({ ...blocked, status: "refused", detail: "the fast-forward was refused: the working tree has uncommitted changes — commit or move that work first" })).toBe(true);
		expect(blockedByLocalChanges({ ...blocked, detail: "the fast-forward failed: could not resolve host" })).toBe(false);
		expect(blockedByLocalChanges(healed)).toBe(false);
	});

	it("approved: stashes with a backup, tries again, proceeds — and records what was stashed", async () => {
		const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
		const out = await attemptSyncSelfHealWithStash(conn, { ...input, approved: true }, { heal: heals(blocked, healed), call: call(stashWire, seen) });
		expect(out.status).toBe("healed");
		expect(seen).toHaveLength(1);
		expect(seen[0].body).toMatchObject({ action: "stash", pull: false, label: "auto run 0c59a0bf" });
		expect(out.stashed).toMatchObject({ ref: "refs/pags/stash/20261023T195800", commit: "a".repeat(40), files: 59 });
		expect(describeSyncHeal(out)).toMatch(/Auto-stashed local changes first \(approved\): Stashed 59 changed files.*Fast-forwarded `main` by 2 commits.*because the checkout was behind\./s);
	});

	it("not approved: escalates with an actionable message and touches nothing", async () => {
		const seen: unknown[] = [];
		const out = await attemptSyncSelfHealWithStash(conn, { ...input, approved: false }, { heal: heals(blocked), call: call(stashWire, seen as never) });
		expect(out.status).toBe("failed");
		expect(out.detail).toContain("would be overwritten");
		expect(out.detail).toContain(AUTO_STASH_HINT);
		expect(out.detail).toMatch(/stash_checkout.*discard_checkout/s);
		expect(seen).toEqual([]);
	});

	it("approved but the machine cannot stash: the original refusal stands, plus why", async () => {
		const old = await attemptSyncSelfHealWithStash(conn, { ...input, approved: true }, { heal: heals(blocked), call: call(new Error("Runner /coding/checkout-clean → 404: nope")) });
		expect(old.status).toBe("failed");
		expect(old.detail).toContain(CHECKOUT_CLEAN_MIN_CLI);
		const failed = await attemptSyncSelfHealWithStash(conn, { ...input, approved: true }, { heal: heals(blocked), call: call({ ...stashWire, ok: false, error: "stash failed: index.lock" }) });
		expect(failed.detail).toContain("did not complete: stash failed: index.lock");
		expect(failed.stashed).toBeUndefined();
	});

	it("a heal that was not blocked by local changes passes through untouched", async () => {
		const seen: unknown[] = [];
		const out = await attemptSyncSelfHealWithStash(conn, { ...input, approved: true }, { heal: heals(healed), call: call(stashWire, seen as never) });
		expect(out).toBe(healed);
		expect(seen).toEqual([]);
	});
});

describe("the approval", () => {
	it("is off by default, on per instance or once per run", async () => {
		expect(autoStashApproved({})).toBe(false);
		expect(autoStashApproved('{"autoStashDirty":true}')).toBe(true);
		expect(autoStashApproved({}, true)).toBe(true);
		expect(await readAutoStashPolicy(env, "i1", "u1")).toBe(false);
		d1.exec(`UPDATE agent_instances SET config = '{"autoStashDirty":true}' WHERE id = 'i1'`);
		expect(await readAutoStashPolicy(env, "i1", "u1")).toBe(true);
		expect(await readAutoStashPolicy(env, "i1", "someone-else")).toBe(false);
	});
});
