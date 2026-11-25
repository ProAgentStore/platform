import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunWorktree, discardWorktree, discardedRef, isPublished, publishDirect, publishRunBranch, reconcileWorktrees, removeCleanWorktree, repoKey, runBranch, verifyManaged, worktreeStatus } from "./run-worktree.js";

/**
 * #1670 — isolated per-run worktrees, on REAL temporary repositories only: a bare "origin", the runner's shared checkout
 * of it, and a second clone that plays "somebody else pushed to the target". Nothing here touches a live checkout.
 */

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const C = "cccccccc-3333-4333-8333-cccccccccccc";

function git(dir: string, ...argv: string[]): string {
	return execFileSync("git", argv, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}
const write = (dir: string, p: string, body: string) => {
	mkdirSync(join(dir, p, ".."), { recursive: true });
	writeFileSync(join(dir, p), body);
};
const identity = (dir: string) => {
	git(dir, "config", "core.autocrlf", "false"); // a Windows runner's global autocrlf=true would turn fixture "\n" into "\r\n" on checkout (#1715)
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
};

describe("runner-managed worktrees (#1670)", () => {
	let base: string;
	let origin: string;
	let shared: string;
	let other: string;
	let root: string;
	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "pags-wt-")));
		origin = join(base, "origin.git");
		shared = join(base, "shared");
		other = join(base, "other");
		root = join(base, "managed");
		git(base, "init", "-q", "--bare", "-b", "main", origin);
		git(base, "clone", "-q", origin, shared);
		identity(shared);
		git(shared, "checkout", "-q", "-b", "main");
		write(shared, "a.txt", "one\n");
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "first");
		git(shared, "push", "-q", "origin", "main");
		git(base, "clone", "-q", origin, other);
		identity(other);
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	const advanceTarget = (file: string, body: string) => {
		git(other, "pull", "-q", "--ff-only", "origin", "main");
		write(other, file, body);
		git(other, "add", "-A");
		git(other, "commit", "-qm", `touch ${file}`);
		git(other, "push", "-q", "origin", "main");
		return git(other, "rev-parse", "HEAD").trim();
	};
	const originTip = () => git(origin, "rev-parse", "refs/heads/main").trim();
	const commitIn = (dir: string, file: string, body: string) => {
		identity(dir);
		write(dir, file, body);
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", `run ${file}`);
		return git(dir, "rev-parse", "HEAD").trim();
	};

	it("creates each run's worktree at the LATEST target commit and leaves the shared checkout's unrelated edits alone", () => {
		write(shared, "unrelated.txt", "someone else's work\n");
		write(shared, "a.txt", "one\nedited by someone\n");
		const tip = advanceTarget("later.txt", "newer\n");
		const r = createRunWorktree(shared, { root, runId: A, target: "main" });
		expect(r).toMatchObject({ ok: true, created: true, base: tip });
		expect(readFileSync(join(r.path as string, "later.txt"), "utf-8")).toBe("newer\n");
		// The shared checkout was not fetched into, reset, stashed or cleaned.
		expect(readFileSync(join(shared, "unrelated.txt"), "utf-8")).toBe("someone else's work\n");
		expect(readFileSync(join(shared, "a.txt"), "utf-8")).toBe("one\nedited by someone\n");
		expect(existsSync(join(shared, "later.txt"))).toBe(false);
		expect(verifyManaged(shared, root, A)?.marker).toMatchObject({ runId: A, target: "main", base: tip });
	});

	it("is idempotent for a run and refuses a path it does not manage", () => {
		const first = createRunWorktree(shared, { root, runId: A, target: "main" });
		expect(createRunWorktree(shared, { root, runId: A, target: "main" })).toMatchObject({ ok: true, created: false, path: first.path });
		// A directory at B's path that git does not know: never adopted, never deleted.
		const squatter = join(root, repoKey(shared), B);
		write(squatter, "mine.txt", "not yours\n");
		expect(createRunWorktree(shared, { root, runId: B, target: "main" })).toMatchObject({ ok: false, created: false });
		expect(readFileSync(join(squatter, "mine.txt"), "utf-8")).toBe("not yours\n");
		expect(verifyManaged(shared, root, B)).toBeNull();
		expect(removeCleanWorktree(shared, root, B).removed).toBe(false);
		expect(discardWorktree(shared, root, B, { authorized: true }).discarded).toBe(false);
		expect(existsSync(join(squatter, "mine.txt"))).toBe(true);
	});

	it("parking one run's edits in its own worktree never affects another run (untracked edits included)", () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		const b = createRunWorktree(shared, { root, runId: B, target: "main" }).path as string;
		write(a, "a-new.ts", "export const a = 1;\n");
		write(a, "a.txt", "one\nA\n");
		write(b, "b-new.ts", "export const b = 1;\n");
		// "Parking" A is simply stopping: its edits stay put, attributed, and visible.
		const sa = worktreeStatus(shared, root, A);
		expect(sa?.files.sort()).toEqual([" M a.txt", "?? a-new.ts"].sort());
		expect(readFileSync(join(b, "b-new.ts"), "utf-8")).toBe("export const b = 1;\n");
		expect(worktreeStatus(shared, root, B)?.files).toEqual(["?? b-new.ts"]);
		expect(git(shared, "status", "--porcelain")).toBe("");
	});

	it("publishes directly: rechecks the target, never forces, and reads the remote back", () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		const sha = commitIn(a, "feature.txt", "feature\n");
		expect(publishDirect(shared, root, A)).toEqual({ ok: true, sha });
		expect(originTip()).toBe(sha);
		expect(isPublished(shared, root, A)).toEqual({ published: true });
	});

	it("reports a target that moved since the run started instead of pushing over it", () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		commitIn(a, "mine.txt", "mine\n");
		const moved = advanceTarget("theirs.txt", "theirs\n");
		const r = publishDirect(shared, root, A);
		expect(r).toMatchObject({ ok: false, reason: "target_moved", targetTip: moved });
		expect(originTip()).toBe(moved);
		// The run's commit is still there, unpublished and untouched.
		expect(isPublished(shared, root, A).published).toBe(false);
		expect(readFileSync(join(a, "mine.txt"), "utf-8")).toBe("mine\n");
	});

	it("refuses to publish uncommitted edits, and reports a remote that rejects (branch protection) without losing the run", () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		write(a, "wip.txt", "uncommitted\n");
		expect(publishDirect(shared, root, A)).toMatchObject({ ok: false, reason: "dirty" });
		rmSync(join(a, "wip.txt"));
		commitIn(a, "ok.txt", "ok\n");
		// A protected target: the remote's own hook refuses the update.
		const hook = join(origin, "hooks", "pre-receive");
		writeFileSync(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n", { mode: 0o755 });
		const r = publishDirect(shared, root, A);
		expect(r).toMatchObject({ ok: false, reason: "rejected" });
		expect(r.error).toContain("protected branch");
		expect(originTip()).not.toBe(git(a, "rev-parse", "HEAD").trim());
		expect(existsSync(join(a, "ok.txt"))).toBe(true);
	});

	it("serializes publication per repository and target: a held lock times out rather than racing", () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		commitIn(a, "x.txt", "x\n");
		const lock = readdirLock(shared);
		writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() }));
		expect(publishDirect(shared, root, A, { lockWaitMs: 100 })).toMatchObject({ ok: false, reason: "lock_timeout" });
		rmSync(lock);
		expect(publishDirect(shared, root, A).ok).toBe(true);
	});

	it("two runs publishing in turn: the second sees the first's commit as the moved target", () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		const b = createRunWorktree(shared, { root, runId: B, target: "main" }).path as string;
		const sa = commitIn(a, "a-only.txt", "a\n");
		commitIn(b, "b-only.txt", "b\n");
		expect(publishDirect(shared, root, A)).toEqual({ ok: true, sha: sa });
		expect(publishDirect(shared, root, B)).toMatchObject({ ok: false, reason: "target_moved", targetTip: sa });
		expect(originTip()).toBe(sa);
	});

	it("PR mode pushes only the run branch and leaves the target alone", () => {
		const before = originTip();
		const r = createRunWorktree(shared, { root, runId: A, target: "main", branch: true });
		const a = r.path as string;
		expect(git(a, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(runBranch(A));
		const sha = commitIn(a, "pr.txt", "pr\n");
		expect(publishRunBranch(shared, root, A)).toEqual({ ok: true, sha, branch: runBranch(A) });
		expect(originTip()).toBe(before);
		expect(git(origin, "rev-parse", `refs/heads/${runBranch(A)}`).trim()).toBe(sha);
		// A detached (direct-mode) worktree has no run branch to publish.
		const b = createRunWorktree(shared, { root, runId: B, target: "main" });
		expect(b.ok).toBe(true);
		expect(publishRunBranch(shared, root, B)).toMatchObject({ ok: false, reason: "not_managed" });
	});

	it("removes a terminal worktree only when it is clean AND its publication is verified", () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		const sha = commitIn(a, "f.txt", "f\n");
		// Committed and clean, but not on the remote yet: kept.
		expect(removeCleanWorktree(shared, root, A)).toMatchObject({ removed: false, refused: expect.stringContaining("publication is not verified") });
		expect(publishDirect(shared, root, A).ok).toBe(true);
		write(a, "scratch.txt", "untracked only\n");
		expect(removeCleanWorktree(shared, root, A)).toMatchObject({ removed: false, refused: expect.stringContaining("uncommitted") });
		expect(existsSync(join(a, "scratch.txt"))).toBe(true);
		rmSync(join(a, "scratch.txt"));
		expect(removeCleanWorktree(shared, root, A)).toEqual({ removed: true });
		expect(existsSync(a)).toBe(false);
		expect(originTip()).toBe(sha);
		expect(git(shared, "worktree", "list")).not.toContain(A);
	});

	it("reconciles leftovers after a crash: removes clean published ones, keeps and attributes the rest, spares live runs and the shared checkout", () => {
		write(shared, "shared-edit.txt", "untouched\n");
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		const b = createRunWorktree(shared, { root, runId: B, target: "main" }).path as string;
		const c = createRunWorktree(shared, { root, runId: C, target: "main" }).path as string;
		commitIn(a, "a.ts", "a\n");
		publishDirect(shared, root, A); // clean + published
		write(b, "unsaved.ts", "never lose me\n"); // dirty
		commitIn(c, "c.ts", "c\n"); // clean but unpublished
		const live = new Set<string>([C]);
		const report = reconcileWorktrees(shared, root, live);
		expect(report.removed).toEqual([A]);
		expect(report.kept).toEqual([expect.objectContaining({ runId: B, files: 1 })]);
		expect(existsSync(a)).toBe(false);
		expect(readFileSync(join(b, "unsaved.ts"), "utf-8")).toBe("never lose me\n");
		expect(existsSync(c)).toBe(true); // live: skipped entirely
		expect(readFileSync(join(shared, "shared-edit.txt"), "utf-8")).toBe("untouched\n");
		// Not-live and unpublished: kept too, with the reason.
		expect(reconcileWorktrees(shared, root, new Set()).kept.map((k) => k.runId).sort()).toEqual([B, C].sort());
	});

	it("discards one run's worktree only with explicit authorization, commits nothing, and pins commits that exist nowhere else", () => {
		const a = createRunWorktree(shared, { root, runId: A, target: "main" }).path as string;
		const b = createRunWorktree(shared, { root, runId: B, target: "main" }).path as string;
		const sha = commitIn(a, "kept-commit.txt", "committed\n");
		write(a, "edit.txt", "uncommitted\n");
		write(b, "other.txt", "other run\n");
		expect(discardWorktree(shared, root, A, { authorized: false as unknown as true })).toMatchObject({ discarded: false });
		expect(existsSync(a)).toBe(true);
		const reachableBefore = git(shared, "rev-list", "--all", "--count");
		const r = discardWorktree(shared, root, A, { authorized: true });
		expect(r).toMatchObject({ discarded: true, files: 1, pinned: discardedRef(A) });
		expect(existsSync(a)).toBe(false);
		expect(git(shared, "rev-parse", discardedRef(A)).trim()).toBe(sha);
		expect(Number(git(shared, "rev-list", "--all", "--count"))).toBeGreaterThanOrEqual(Number(reachableBefore));
		// Nothing was committed on the run's behalf, and the other run is intact.
		expect(git(shared, "log", "--all", "--format=%s")).not.toContain("edit.txt");
		expect(readFileSync(join(b, "other.txt"), "utf-8")).toBe("other run\n");
		expect(originTip()).not.toBe(sha);
	});

	it("never acts outside the managed root, even for a path git lists as a worktree", () => {
		const outsider = join(base, "outsider");
		git(shared, "worktree", "add", "-q", "--detach", outsider);
		write(outsider, "precious.txt", "mine\n");
		expect(reconcileWorktrees(shared, root, new Set())).toEqual({ removed: [], kept: [] });
		expect(verifyManaged(shared, root, A)).toBeNull();
		expect(readFileSync(join(outsider, "precious.txt"), "utf-8")).toBe("mine\n");
	});
});

function readdirLock(repo: string): string {
	const common = git(repo, "rev-parse", "--git-common-dir").trim();
	const dir = common.startsWith("/") || /^[A-Za-z]:/.test(common) ? common : join(repo, common);
	// Same name the module derives: pags-publish-<sha1("origin/main")[:12]>.lock
	const { createHash } = require("node:crypto") as typeof import("node:crypto");
	return join(dir, `pags-publish-${createHash("sha1").update("origin/main").digest("hex").slice(0, 12)}.lock`);
}
