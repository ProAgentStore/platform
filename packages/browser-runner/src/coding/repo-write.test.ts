import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InspectError } from "./inspect.js";
import { gitWriteArgv, isSwitchableBranchName, switchRepoBranch } from "./repo-write.js";

/**
 * The write surface, exercised against a REAL git repo.
 *
 * The blind spot this suite does NOT cover, stated rather than discovered: it proves that the one
 * verb behaves, and that every refusal path leaves the checkout untouched. It cannot prove there is
 * no OTHER way to reach git from the runner — that is the job of the vocabulary being one member
 * wide, and of the argv test below, which fails the moment a second verb appears without one.
 */

function git(dir: string, ...argv: string[]): string {
	return execFileSync("git", argv, { cwd: dir, encoding: "utf-8" }).toString();
}

describe("isSwitchableBranchName (the only caller-supplied token)", () => {
	it("accepts the branch names people actually use", () => {
		for (const n of ["main", "master", "develop", "release/2.1", "fix-36", "v1.2.3"]) {
			expect(isSwitchableBranchName(n)).toBe(true);
		}
	});

	it("refuses anything that could be read as an OPTION", () => {
		// The one injection this argv shape is open to: there is no shell, but git parses a leading
		// dash as a flag, and `--force`-shaped flags are how a pointer move becomes a data loss.
		expect(isSwitchableBranchName("-f")).toBe(false);
		expect(isSwitchableBranchName("--force")).toBe(false);
		expect(isSwitchableBranchName("-B main")).toBe(false);
	});

	it("refuses shell metacharacters, spaces and git's own reserved shapes", () => {
		for (const n of ["main; rm -rf /", "a b", "a..b", "refs//heads", "main/", "x.lock", "a@{0}", "a~1", "a^", "a:b", "a?", "a*", "a[b]", "a\\b", ""]) {
			expect(isSwitchableBranchName(n)).toBe(false);
		}
		expect(isSwitchableBranchName(null)).toBe(false);
		expect(isSwitchableBranchName(42)).toBe(false);
	});
});

describe("gitWriteArgv (the closed vocabulary, at the hands)", () => {
	it("maps the one verb to a fixed argv, terminated by --", () => {
		// `--` says "this is a ref, not a path". Without it a branch that shares a name with a file
		// makes this a FILE checkout, which discards uncommitted work — the one thing no policy may
		// ever do.
		expect(gitWriteArgv("switch-branch", { branch: "main" })).toEqual(["checkout", "main", "--"]);
	});

	it("has exactly one verb — a second one is a code review, not a string", () => {
		for (const verb of ["commit", "reset", "clean", "stash", "push", "checkout"]) {
			expect(() => gitWriteArgv(verb as never, { branch: "main" })).toThrow(InspectError);
		}
	});

	it("refuses to build an argv around an unusable branch name", () => {
		expect(() => gitWriteArgv("switch-branch", { branch: "--force" })).toThrow(InspectError);
		expect(() => gitWriteArgv("switch-branch", {})).toThrow(InspectError);
	});
});

describe("switchRepoBranch (on a real temp repo)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-repo-write-"));
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "T");
		writeFileSync(join(dir, "a.txt"), "one\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "first");
		git(dir, "checkout", "-q", "-b", "fix/36");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("switches a clean checkout back, and reports where it came from", () => {
		const r = switchRepoBranch(dir, "main");
		expect(r).toMatchObject({ ok: true, changed: true, from: "fix/36", to: "main", branch: "main", dirty: false });
		// Read from git, not from the return value: the point of the whole exercise is that the
		// checkout really moved.
		expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
	});

	it("the undo the card prints actually undoes it", () => {
		const r = switchRepoBranch(dir, "main");
		git(dir, "checkout", "-q", r.from as string);
		expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("fix/36");
	});

	it("REFUSES a dirty tree and changes nothing", () => {
		// git carries uncommitted changes across a checkout, so acting here would relocate work
		// somebody left deliberately (#276) onto a branch they never put it on. There is no version
		// of this that stashes: the stash is repo-global across worktrees.
		writeFileSync(join(dir, "a.txt"), "edited\n");
		const r = switchRepoBranch(dir, "main");
		expect(r.refused).toBe("dirty");
		expect(r.ok).toBe(false);
		expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("fix/36");
		expect(git(dir, "status", "--porcelain").trim()).toContain("a.txt");
	});

	it("counts an UNTRACKED file as dirty", () => {
		// The files a checkout silently carries across are exactly the ones git was never told
		// about, so `--porcelain` without `-uno` is the load-bearing choice.
		writeFileSync(join(dir, "scratch.env"), "SECRET=1\n");
		expect(switchRepoBranch(dir, "main").refused).toBe("dirty");
	});

	it("REFUSES a branch that does not exist — it never creates one", () => {
		const r = switchRepoBranch(dir, "does-not-exist");
		expect(r.refused).toBe("unknown-branch");
		expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("fix/36");
	});

	it("refuses a path that is not a checkout", () => {
		const empty = mkdtempSync(join(tmpdir(), "pags-not-a-repo-"));
		try {
			expect(switchRepoBranch(empty, "main").refused).toBe("not-a-repo");
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("is a no-op success when the checkout is already there", () => {
		const r = switchRepoBranch(dir, "fix/36");
		expect(r).toMatchObject({ ok: true, changed: false, from: "fix/36", branch: "fix/36" });
	});

	it("does not let a branch named like a file become a file checkout", () => {
		// `git checkout a.txt` discards a.txt. With `--` in the argv, a branch called `a.txt` is
		// resolved as a ref and the edit survives — as an unknown-branch refusal, since no such
		// branch exists.
		writeFileSync(join(dir, "a.txt"), "precious\n");
		const r = switchRepoBranch(dir, "a.txt");
		// Dirty is checked first and is itself a refusal, so the file is safe twice over.
		expect(r.ok).toBe(false);
		expect(git(dir, "status", "--porcelain").trim()).toContain("a.txt");
	});

	it("switches out of a detached HEAD and names the commit it came from", () => {
		const sha = git(dir, "rev-parse", "--short", "HEAD").trim();
		git(dir, "checkout", "-q", "--detach");
		const r = switchRepoBranch(dir, "main");
		expect(r.ok).toBe(true);
		expect(r.from).toBe(sha);
	});

	it("throws rather than shelling out when the name is unusable", () => {
		expect(() => switchRepoBranch(dir, "--force")).toThrow(InspectError);
	});
});
