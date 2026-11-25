import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchInventory, compareBranch, deleteBranch, integrateBranch, isProtectedName, readChecks } from "./branches.js";
import type { GhRunner } from "./merge-evidence.js";

/** One spelling of a path for comparison: real (macOS /private, Windows 8.3 names), forward slashes, case-folded on Windows. git prints worktrees as C:/... where tmpdir() gives C:\\... (#1715). */
const samePath = (p: string) => {
	const real = realpathSync.native(p).replace(/\\/g, "/");
	return process.platform === "win32" ? real.toLowerCase() : real;
};
const git = (dir: string, ...argv: string[]) => execFileSync("git", argv, { cwd: dir, encoding: "utf-8" }).trim();
const ident = (dir: string) => {
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
};

let root: string;
let origin: string;
let work: string;

/** A bare origin with `main`, a clone of it as `work`, and a feature branch with one unique commit pushed nowhere. */
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pags-branches-"));
	origin = join(root, "origin.git");
	work = join(root, "work");
	execFileSync("git", ["init", "--bare", "-b", "main", origin]);
	const seed = join(root, "seed");
	execFileSync("git", ["clone", "-q", origin, seed]);
	ident(seed);
	writeFileSync(join(seed, "a.txt"), "one\n");
	git(seed, "add", ".");
	git(seed, "commit", "-q", "-m", "init");
	git(seed, "push", "-q", "origin", "HEAD:main");
	execFileSync("git", ["clone", "-q", origin, work]);
	ident(work);
	git(work, "checkout", "-q", "-b", "feature");
	writeFileSync(join(work, "b.txt"), "feature\n");
	git(work, "add", ".");
	git(work, "commit", "-q", "-m", "add b");
	git(work, "checkout", "-q", "main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const tipOf = (b: string) => git(work, "rev-parse", `refs/heads/${b}`);
const remoteTip = (b: string) => git(origin, "rev-parse", `refs/heads/${b}`);

/** A `gh` that answers the three reads with the given check situation. */
const fakeGh = (opts: { contexts?: string[]; runs?: { name: string; status: string; conclusion: string | null }[]; statuses?: { context: string; state: string }[]; fail?: boolean; protectedNames?: string[] } = {}): GhRunner => async (args) => {
	if (opts.fail) return { code: 1, stdout: "" };
	const ep = args[1];
	if (ep.includes("branches?protected")) return { code: 0, stdout: JSON.stringify(opts.protectedNames ?? []) };
	if (/\/branches\/[^/]+$/.test(ep)) return { code: 0, stdout: JSON.stringify({ protected: !!opts.contexts?.length, contexts: opts.contexts ?? [] }) };
	if (ep.includes("/check-runs")) return { code: 0, stdout: JSON.stringify(opts.runs ?? []) };
	if (ep.endsWith("/status")) return { code: 0, stdout: JSON.stringify(opts.statuses ?? []) };
	return { code: 1, stdout: "" };
};

describe("branchInventory", () => {
	it("lists local branches with tip, default and checked-out status, and the live remote", async () => {
		const inv = await branchInventory(work);
		expect(inv.defaultBranch).toEqual({ name: "main", source: "live" });
		expect(inv.remote.live).toBe(true);
		const feature = inv.local.find((b) => b.name === "feature")!;
		expect(feature.tip).toBe(tipOf("feature"));
		expect(feature.aheadOfDefault).toBe(1);
		expect(feature.behindDefault).toBe(0);
		expect(feature.checkedOutAt).toEqual([]);
		expect(feature.upstream).toBeNull();
		const main = inv.local.find((b) => b.name === "main")!;
		expect(main.isDefault).toBe(true);
		expect(main.checkedOutAt).toHaveLength(1);
		expect(main.upstream).toBe("origin/main");
		expect(inv.current).toEqual({ branch: "main", detached: false });
		expect(inv.protectionKnown).toBe(false);
		expect(feature.protected).toEqual({ byName: false, onRemote: null });
	});

	it("sees a branch checked out in a LINKED worktree", async () => {
		const linked = join(root, "linked");
		git(work, "worktree", "add", "-q", linked, "feature");
		const inv = await branchInventory(work);
		expect(inv.local.find((b) => b.name === "feature")!.checkedOutAt.map(samePath)).toEqual([samePath(linked)]);
		// and the same answer from inside the linked tree
		const fromLinked = await branchInventory(linked);
		expect(fromLinked.local.find((b) => b.name === "main")!.checkedOutAt).toHaveLength(1);
	});

	it("distinguishes live remote heads from cached tracking refs, and flags a stale cache", async () => {
		git(work, "push", "-q", "origin", "feature");
		// another clone moves origin/feature and deletes nothing; our tracking ref stays behind
		const other = join(root, "other");
		execFileSync("git", ["clone", "-q", origin, other]);
		ident(other);
		git(other, "push", "-q", "origin", "HEAD:refs/heads/gone");
		git(work, "fetch", "-q", "origin");
		git(other, "push", "-q", "origin", ":refs/heads/gone");
		git(other, "checkout", "-q", "feature");
		writeFileSync(join(other, "c.txt"), "c\n");
		git(other, "add", ".");
		git(other, "commit", "-q", "-m", "c");
		git(other, "push", "-q", "origin", "feature");
		const inv = await branchInventory(work);
		const f = inv.remoteBranches.find((b) => b.name === "feature")!;
		expect(f.source).toBe("live");
		expect(f.tip).toBe(remoteTip("feature"));
		expect(f.cachedTip).not.toBe(f.tip);
		expect(f.cacheStale).toBe(true);
		const gone = inv.remoteBranches.find((b) => b.name === "gone")!;
		expect(gone.source).toBe("cached-only");
		expect(gone.cacheStale).toBe(true);
	});

	it("reports an unreachable remote explicitly and falls back to cached refs", async () => {
		git(work, "remote", "set-url", "origin", join(root, "nowhere.git"));
		const inv = await branchInventory(work);
		expect(inv.remote.live).toBe(false);
		expect(inv.remote.error).toBeTruthy();
		expect(inv.defaultBranch?.source).toBe("cached");
		expect(inv.remoteBranches.every((b) => b.source === "cached-only")).toBe(true);
	});

	it("reads GitHub's protection list when gh can answer, and names it unknown when it cannot", async () => {
		git(work, "remote", "set-url", "origin", `https://github.com/acme/widgets.git`);
		const known = await branchInventory(work, { gh: fakeGh({ protectedNames: ["feature"] }) });
		expect(known.protectionKnown).toBe(true);
		expect(known.local.find((b) => b.name === "feature")!.protected.onRemote).toBe(true);
		expect(known.local.find((b) => b.name === "main")!.protected.onRemote).toBe(false);
		const unknown = await branchInventory(work, { gh: fakeGh({ fail: true }) });
		expect(unknown.protectionKnown).toBe(false);
	});

	it("refuses a non-checkout", async () => {
		await expect(branchInventory(root)).rejects.toThrow(/not a git checkout/);
	});
});

describe("compareBranch", () => {
	it("lists the branch's unique commits and files against the freshly fetched default", () => {
		const c = compareBranch(work, { branch: "feature" });
		expect(c.baseFetched).toBe(true);
		expect(c.ahead).toBe(1);
		expect(c.behind).toBe(0);
		expect(c.commits.map((x) => x.subject)).toEqual(["add b"]);
		expect(c.files).toEqual([{ status: "A", path: "b.txt" }]);
		expect(c.merged).toBe(false);
		expect(c.resolvedFrom).toBe("local");
	});

	it("says when the base could not be refreshed", () => {
		git(work, "remote", "set-url", "origin", join(root, "nowhere.git"));
		const c = compareBranch(work, { branch: "feature" });
		expect(c.baseFetched).toBe(false);
		expect(c.baseFetchError).toBeTruthy();
	});

	it("rejects an unknown branch and a malformed name", () => {
		expect(() => compareBranch(work, { branch: "nope" })).toThrow(/no branch/);
		expect(() => compareBranch(work, { branch: "a..b" })).toThrow(/usable branch name/);
		expect(() => compareBranch(work, { branch: "--delete" })).toThrow(/usable branch name/);
	});
});

describe("integrateBranch", () => {
	// The remote reads as a GitHub URL (so a slug exists for `gh`) while git itself rewrites it to the local bare repo.
	beforeEach(() => {
		git(work, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
		git(work, "config", `url.${origin}.insteadOf`, "https://github.com/acme/widgets.git");
	});
	const green = fakeGh({ runs: [{ name: "ci", status: "completed", conclusion: "success" }] });

	it("previews the unique changes without touching the remote", async () => {
		const r = await integrateBranch(work, { branch: "feature", dryRun: true }, { gh: green });
		expect(r.ok).toBe(true);
		expect(r.dryRun).toBe(true);
		expect(r.unique?.commits.map((c) => c.subject)).toEqual(["add b"]);
		expect(r.unique?.files).toEqual([{ status: "A", path: "b.txt" }]);
		expect(r.checks?.state).toBe("passed");
		expect(r.tip).toBe(tipOf("feature"));
		expect(remoteTip("main")).not.toBe(tipOf("feature"));
	});

	it("fast-forwards the default branch to the previewed tip and reads it back", async () => {
		const tip = tipOf("feature");
		const r = await integrateBranch(work, { branch: "feature", expectedTip: tip, dryRun: false }, { gh: green, now: () => new Date("2026-01-01T00:00:00Z") });
		expect(r.ok).toBe(true);
		expect(remoteTip("main")).toBe(tip);
		expect(r.remoteTipAfter).toBe(tip);
		expect(r.receipt).toMatchObject({ to: tip, at: "2026-01-01T00:00:00.000Z" });
	});

	it("requires the expected tip to execute", async () => {
		await expect(integrateBranch(work, { branch: "feature", dryRun: false }, { gh: green })).rejects.toThrow(/expected_tip/);
	});

	it("refuses when the branch moved between preview and execution", async () => {
		const previewed = tipOf("feature");
		git(work, "checkout", "-q", "feature");
		writeFileSync(join(work, "late.txt"), "late\n");
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "late");
		git(work, "checkout", "-q", "main");
		const r = await integrateBranch(work, { branch: "feature", expectedTip: previewed, dryRun: false }, { gh: green });
		expect(r).toMatchObject({ ok: false, reason: "stale_tip" });
		expect(remoteTip("main")).not.toBe(tipOf("feature"));
	});

	it("refuses a diverged branch instead of merging or forcing", async () => {
		const other = join(root, "other");
		execFileSync("git", ["clone", "-q", origin, other]);
		ident(other);
		writeFileSync(join(other, "m.txt"), "m\n");
		git(other, "add", ".");
		git(other, "commit", "-q", "-m", "main moved");
		git(other, "push", "-q", "origin", "HEAD:main");
		const before = remoteTip("main");
		const r = await integrateBranch(work, { branch: "feature", dryRun: true }, { gh: green });
		expect(r).toMatchObject({ ok: false, reason: "diverged" });
		expect(r.unique?.commitsTotal).toBe(1);
		expect(remoteTip("main")).toBe(before);
	});

	it("refuses integrating the default branch, and a branch already on it", async () => {
		expect(await integrateBranch(work, { branch: "main", dryRun: true }, { gh: green })).toMatchObject({ reason: "default_branch" });
		git(work, "branch", "same", "main");
		expect(await integrateBranch(work, { branch: "same", dryRun: true }, { gh: green })).toMatchObject({ reason: "nothing_to_integrate" });
	});

	it("refuses failing, pending and unverifiable checks, and never pushes", async () => {
		const before = remoteTip("main");
		const failing = fakeGh({ runs: [{ name: "ci", status: "completed", conclusion: "failure" }] });
		const pending = fakeGh({ runs: [{ name: "ci", status: "in_progress", conclusion: null }] });
		expect(await integrateBranch(work, { branch: "feature", expectedTip: tipOf("feature"), dryRun: false }, { gh: failing })).toMatchObject({ reason: "checks_failed" });
		expect(await integrateBranch(work, { branch: "feature", expectedTip: tipOf("feature"), dryRun: false }, { gh: pending })).toMatchObject({ reason: "checks_pending" });
		expect(await integrateBranch(work, { branch: "feature", expectedTip: tipOf("feature"), dryRun: false }, { gh: fakeGh({ fail: true }) })).toMatchObject({ reason: "checks_unverifiable" });
		expect(await integrateBranch(work, { branch: "feature", expectedTip: tipOf("feature"), dryRun: false }, {})).toMatchObject({ reason: "checks_unverifiable" });
		expect(remoteTip("main")).toBe(before);
	});

	it("reports an unreachable remote rather than guessing the default's tip", async () => {
		git(work, "config", `url.${join(root, "nowhere.git")}.insteadOf`, "https://github.com/acme/widgets.git");
		git(work, "config", "--unset", `url.${origin}.insteadOf`);
		expect(await integrateBranch(work, { branch: "feature", dryRun: true }, { gh: green })).toMatchObject({ ok: false, reason: "remote_unreachable" });
	});

	it("passes the remote's own rejection through (a pre-receive hook standing in for branch protection)", async () => {
		writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'protected: pull request required' >&2\nexit 1\n", { mode: 0o755 });
		const r = await integrateBranch(work, { branch: "feature", expectedTip: tipOf("feature"), dryRun: false }, { gh: green });
		expect(r).toMatchObject({ ok: false, reason: "push_rejected" });
		expect(r.error).toMatch(/pull request required|declined/);
	});
});

describe("readChecks", () => {
	it("requires each protected context, and a missing one is pending, not passed", async () => {
		const gh = fakeGh({ contexts: ["ci", "lint"], runs: [{ name: "ci", status: "completed", conclusion: "success" }] });
		expect((await readChecks(gh, "a/b", "abc", "main")).state).toBe("pending");
		const ok = fakeGh({ contexts: ["ci"], runs: [{ name: "ci", status: "completed", conclusion: "success" }, { name: "extra", status: "completed", conclusion: "failure" }] });
		expect((await readChecks(ok, "a/b", "abc", "main")).state).toBe("passed");
	});
	it("treats no checks and no protection as none_required, and statuses as checks", async () => {
		expect((await readChecks(fakeGh(), "a/b", "abc", "main")).state).toBe("none_required");
		expect((await readChecks(fakeGh({ statuses: [{ context: "x", state: "failure" }] }), "a/b", "abc", "main")).state).toBe("failed");
	});
});

describe("deleteBranch", () => {
	it("previews a local delete with the unique work and the unpushed count, then deletes by exact tip and reads back", async () => {
		const tip = tipOf("feature");
		const p = await deleteBranch(work, { scope: "local", branch: "feature", dryRun: true });
		expect(p).toMatchObject({ ok: true, dryRun: true, tip, unpushed: 1 });
		expect(p.unique?.commits.map((c) => c.subject)).toEqual(["add b"]);
		expect(tipOf("feature")).toBe(tip);
		const r = await deleteBranch(work, { scope: "local", branch: "feature", expectedTip: tip, dryRun: false });
		expect(r.ok).toBe(true);
		expect(r.receipt?.recover).toBe(`git branch feature ${tip}`);
		expect(() => git(work, "rev-parse", "--verify", "--quiet", "refs/heads/feature")).toThrow();
	});

	it("refuses a local delete when the tip moved after the preview", async () => {
		const previewed = tipOf("feature");
		git(work, "checkout", "-q", "feature");
		writeFileSync(join(work, "late.txt"), "late\n");
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "late");
		git(work, "checkout", "-q", "main");
		const r = await deleteBranch(work, { scope: "local", branch: "feature", expectedTip: previewed, dryRun: false });
		expect(r).toMatchObject({ ok: false, reason: "stale_tip" });
		expect(tipOf("feature")).not.toBe(previewed);
	});

	it("refuses the default, a protected name, a checked-out branch (main work tree and linked), and a GitHub-protected one", async () => {
		expect(await deleteBranch(work, { scope: "local", branch: "main", dryRun: true })).toMatchObject({ reason: "default_branch" });
		git(work, "branch", "release/1.0", "main");
		expect(await deleteBranch(work, { scope: "local", branch: "release/1.0", dryRun: true })).toMatchObject({ reason: "protected" });
		const linked = join(root, "linked");
		git(work, "worktree", "add", "-q", linked, "feature");
		expect(await deleteBranch(work, { scope: "local", branch: "feature", dryRun: true })).toMatchObject({ reason: "checked_out" });
		expect(await deleteBranch(work, { scope: "remote", branch: "feature", dryRun: true })).toMatchObject({ reason: "checked_out" });
		git(work, "worktree", "remove", "--force", linked);
		git(work, "remote", "set-url", "origin", origin); // unchanged; slug stays null so gh cannot be asked
		git(work, "branch", "guarded", "main");
		const asGithub = deleteBranch(work, { scope: "local", branch: "guarded", dryRun: true }, { gh: fakeGh({ protectedNames: ["guarded"] }) });
		// no GitHub slug for a file remote: protection stays unknown rather than invented
		expect((await asGithub).ok).toBe(true);
		expect(isProtectedName("develop")).toBe(true);
	});

	it("deletes a remote branch by exact live tip and verifies it is gone on the remote", async () => {
		git(work, "push", "-q", "origin", "feature");
		const tip = remoteTip("feature");
		const p = await deleteBranch(work, { scope: "remote", branch: "feature", dryRun: true });
		expect(p).toMatchObject({ ok: true, tip });
		expect(p.unique?.commitsTotal).toBe(1);
		const r = await deleteBranch(work, { scope: "remote", branch: "feature", expectedTip: tip, dryRun: false });
		expect(r.ok).toBe(true);
		expect(r.receipt?.recover).toBe(`git push origin ${tip}:refs/heads/feature`);
		expect(() => remoteTip("feature")).toThrow();
		expect(git(work, "for-each-ref", "refs/remotes/origin/feature")).toBe("");
	});

	it("refuses a remote delete when the remote tip moved, or the branch only exists as a stale cached ref", async () => {
		git(work, "push", "-q", "origin", "feature");
		const previewed = remoteTip("feature");
		const other = join(root, "other");
		execFileSync("git", ["clone", "-q", origin, other]);
		ident(other);
		git(other, "checkout", "-q", "feature");
		writeFileSync(join(other, "c.txt"), "c\n");
		git(other, "add", ".");
		git(other, "commit", "-q", "-m", "c");
		git(other, "push", "-q", "origin", "feature");
		expect(await deleteBranch(work, { scope: "remote", branch: "feature", expectedTip: previewed, dryRun: false })).toMatchObject({ ok: false, reason: "stale_tip" });
		expect(remoteTip("feature")).not.toBe(previewed);
		git(other, "push", "-q", "origin", ":refs/heads/feature");
		const r = await deleteBranch(work, { scope: "remote", branch: "feature", dryRun: true });
		expect(r).toMatchObject({ ok: false, reason: "not_found" });
	});

	it("requires the expected tip to execute", async () => {
		await expect(deleteBranch(work, { scope: "local", branch: "feature", dryRun: false })).rejects.toThrow(/expected_tip/);
	});

	it("rejects a full-ref or option-looking branch and a short sha", async () => {
		await expect(deleteBranch(work, { scope: "local", branch: "-D", dryRun: true })).rejects.toThrow(/usable branch name/);
		await expect(deleteBranch(work, { scope: "local", branch: "feature", expectedTip: "abc123", dryRun: false })).rejects.toThrow(/40-character/);
	});
});

describe("multiple repositories", () => {
	it("keeps two checkouts' branches apart", async () => {
		const second = join(root, "second");
		execFileSync("git", ["clone", "-q", origin, second]);
		ident(second);
		git(second, "checkout", "-q", "-b", "only-in-second");
		const a = await branchInventory(work);
		const b = await branchInventory(second);
		expect(a.local.map((x) => x.name)).not.toContain("only-in-second");
		expect(b.local.map((x) => x.name)).toContain("only-in-second");
		expect(b.local.map((x) => x.name)).not.toContain("feature");
	});
});
