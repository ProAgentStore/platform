import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { engineSpawnEnv } from "./engine-env.js";
import { findRealGit, GIT_REFUSED_EXIT, GIT_REFUSED_MARKER, gitGuardEnv, installGitGuard } from "./git-guard.js";

/**
 * #1021, on isolated temporary repositories only — never a live checkout or a real stash. These run
 * the GENERATED shim against real git. Strings named `INCIDENT_*` are the commands under test: they
 * are executed, but only inside the temporary repository each test creates.
 */
const tmp = mkdtempSync(join(tmpdir(), "pags-gitguard-"));
const root = join(tmp, "guard");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// No owner config, hooks, signing or editor can reach these repositories.
const BASE_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
	GIT_EDITOR: "true",
};

/** The incident: a space-joined path list makes the save fail, and the chained pop runs anyway. */
const INCIDENT_BASH = `SRC="a.txt b.txt"; git stash push -- "$SRC"; git stash pop`;
const INCIDENT_ZSH = `SRC="a.txt b.txt"; git stash push -- $SRC; git stash pop`;

let repo: string;
let n = 0;
const git = (args: string[], env = BASE_ENV) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
const sh = (shell: string, script: string, env: NodeJS.ProcessEnv) => spawnSync(shell, ["-c", script], { cwd: repo, env, encoding: "utf8" });
const installed = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

/** Everything foreign or owned that must not move: object identities, the index, and file bytes. */
function snapshot() {
	const read = (f: string) => {
		try {
			return readFileSync(join(repo, f), "utf8");
		} catch {
			return null;
		}
	};
	return {
		stash: git(["rev-parse", "refs/stash"]).stdout.trim(),
		stashList: git(["stash", "list", "--format=%H %s"]).stdout,
		recovery: git(["rev-parse", "refs/heads/recovery/foreign"]).stdout.trim(),
		head: git(["rev-parse", "HEAD"]).stdout.trim(),
		index: git(["ls-files", "-s"]).stdout,
		files: Object.fromEntries(["a.txt", "b.txt", "c.txt", "new.txt"].map((f) => [f, read(f)])),
	};
}

beforeEach(() => {
	repo = mkdtempSync(join(tmp, `repo-${n++}-`));
	git(["init", "-q", "-b", "main"]);
	for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, f), `${f} base\n`);
	git(["add", "."]);
	git(["commit", "-qm", "base"]);
	// Someone else's retained recovery state: a stash and a branch.
	writeFileSync(join(repo, "c.txt"), "c.txt FOREIGN recovery work\n");
	git(["stash", "push", "-qm", "foreign recovery"]);
	git(["branch", "recovery/foreign"]);
	// This run's own edits: tracked, staged-then-edited-again, and untracked.
	writeFileSync(join(repo, "a.txt"), "a.txt owned tracked edit\n");
	writeFileSync(join(repo, "b.txt"), "b.txt owned staged edit\n");
	git(["add", "b.txt"]);
	writeFileSync(join(repo, "b.txt"), "b.txt owned staged edit + unstaged\n");
	writeFileSync(join(repo, "new.txt"), "owned untracked\n");
});

describe("the #1021 incident, fail-before / pass-after", () => {
	it("FAIL-BEFORE: without the guard the failed save is followed by a pop that consumes the foreign stash", () => {
		const before = snapshot();
		const r = sh("bash", INCIDENT_BASH, BASE_ENV);
		expect(r.stderr).toMatch(/did not match any file|pathspec/i);
		const after = snapshot();
		expect(after.stashList).toBe(""); // the foreign entry was popped off the stack
		expect(after.stash).not.toBe(before.stash);
	});

	it("PASS-AFTER: through the Engine's spawn env the pop is refused and nothing foreign or owned moves", () => {
		const env = { ...engineSpawnEnv(undefined, undefined, undefined, root), ...pick(BASE_ENV) };
		const before = snapshot();
		const r = sh("bash", INCIDENT_BASH, env);
		expect(r.status).toBe(GIT_REFUSED_EXIT); // the last command's real status, not relabelled
		expect(r.stderr).toContain(GIT_REFUSED_MARKER);
		expect(snapshot()).toEqual(before);
	});

	it.runIf(installed("zsh") || process.env.PAGS_REQUIRE_SHELLS)("PASS-AFTER under zsh, where the unquoted variable is one pathspec", () => {
		const env = gitGuardEnv(BASE_ENV, root);
		const before = snapshot();
		const r = sh("zsh", INCIDENT_ZSH, env);
		expect(r.status).toBe(GIT_REFUSED_EXIT);
		expect(snapshot()).toEqual(before);
	});
});

describe("what the guard refuses and allows (#1021)", () => {
	const guarded = () => gitGuardEnv(BASE_ENV, root);

	it("refuses every by-position restore or discard, in any spelling, before git runs", () => {
		const before = snapshot();
		for (const args of [
			["stash", "pop"],
			["stash", "pop", "--index", "stash@{0}"],
			["-C", repo, "stash", "pop"],
			["-c", "core.pager=cat", "stash", "-q", "pop"],
			["stash", "apply"],
			["stash", "apply", "stash@{0}"],
			["stash", "apply", "0"],
			["stash", "drop"],
			["stash", "clear"],
			["stash", "branch", "b", "stash@{0}"],
		]) {
			const r = git(args, guarded());
			expect(r.status, args.join(" ")).toBe(GIT_REFUSED_EXIT);
			expect(r.stderr).toContain(GIT_REFUSED_MARKER);
		}
		expect(snapshot()).toEqual(before);
	});

	it("CONTROL: a save and a restore of the exact object this command created works, and the foreign stash is untouched", () => {
		const env = guarded();
		const foreign = snapshot().stash;
		const created = git(["stash", "create"], env).stdout.trim();
		expect(created).toMatch(/^[0-9a-f]{40}$/);
		const owned = snapshot();
		// The comparison: the tracked files back at the base, the test would run here.
		expect(git(["checkout", "HEAD", "--", "a.txt", "b.txt"], env).status).toBe(0);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a.txt base\n");
		const r = git(["stash", "apply", "--index", created], env);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		// The owned tracked, staged and unstaged edits are back exactly, index included.
		expect(snapshot()).toEqual(owned);
		expect(snapshot().stash).toBe(foreign);
	});

	it("CONTROL: everything else passes straight through with git's own exit status", () => {
		const env = guarded();
		expect(git(["status", "--porcelain"], env).status).toBe(0);
		expect(git(["stash", "list"], env).stdout).toContain("foreign recovery");
		expect(git(["rev-parse", "--verify", "no-such-ref"], env).status).toBe(128);
		const pushed = git(["stash", "push", "-m", "mine", "--", "a.txt"], env);
		expect(pushed.status).toBe(0);
		expect(git(["stash", "list"], env).stdout.split("\n").filter(Boolean)).toHaveLength(2);
	});

	it("never resolves its own shim as the real git, so a reinstall cannot loop", () => {
		const env = guarded();
		expect(findRealGit(env.PATH, root)).not.toContain(root);
		expect(installGitGuard(env, root)).toBe(installGitGuard(BASE_ENV, root));
	});
});

/** The git identity/config isolation, layered over an env built by production code. */
function pick(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { PATH: _path, ...rest } = env;
	return rest;
}
