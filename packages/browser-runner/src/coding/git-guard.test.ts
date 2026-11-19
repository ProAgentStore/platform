import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { engineSpawnEnv } from "./engine-env.js";
import { findRealGit, GIT_REFUSED_EXIT, GIT_REFUSED_MARKER, gitGuardEnv, gitGuardRoot, installGitGuard, renderGitShim } from "./git-guard.js";

/**
 * #1021, on isolated temporary repositories only — never a live checkout or a real stash. These run
 * the GENERATED shim against real git. Strings named `INCIDENT_*` are the commands under test: they
 * are executed, but only inside the temporary repository each test creates.
 */
const tmp = mkdtempSync(join(tmpdir(), "pags-gitguard-"));
const root = join(tmp, "guard");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// No owner config, hooks, signing or editor can reach these repositories.
/**
 * Real, UNGUARDED git: the inherited PATH minus any installed git guard. Inside a coder session the
 * runner's own guard is first on PATH, so "without the guard" was guarded there and the fail-before
 * could not reproduce the incident.
 */
const BASE_ENV: NodeJS.ProcessEnv = {
	...process.env,
	PATH: (process.env.PATH ?? "").split(":").filter((d) => !d.startsWith(gitGuardRoot())).join(":"),
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

/**
 * #1489 — another actor's uncommitted work in a shared checkout survives an automated reset/clean/restore, and every
 * mutating command is recorded. Same temporary repositories as above: `a.txt` (tracked edit), `b.txt` (staged then edited
 * again) and `new.txt` (untracked) are the OTHER actor's work.
 *
 * These run the GENERATED shim text directly (`sh <shim> <git args>`), not through a PATH lookup: the PATH route needs a
 * POSIX `exec` of an extensionless script and is already covered above for the stash guard. Running the text itself
 * checks the same script on any host that has `sh`, and keeps these from depending on how the host resolves PATH.
 */
describe("a shared checkout's uncommitted work survives repo-wide discards (#1489)", () => {
	const shim = shimRunner();
	const WIPE = [["reset", "--hard"], ["clean", "-fd"]] as const;

	it("FAIL-BEFORE: without the guard `reset --hard` and `clean -fd` erase the tracked edits and the untracked file", () => {
		const before = snapshot();
		expect(before.files["a.txt"]).toContain("owned tracked edit");
		for (const args of WIPE) expect(git([...args]).status).toBe(0);
		const after = snapshot();
		expect(after.files["a.txt"]).toBe("a.txt base\n");
		expect(after.files["new.txt"]).toBeNull();
		expect(after).not.toEqual(before);
	});

	it("PASS-AFTER: through the shim the same commands are refused and nothing moves", () => {
		const before = snapshot();
		for (const args of WIPE) {
			const r = shim([...args]);
			expect(r.status, args.join(" ")).toBe(GIT_REFUSED_EXIT);
			expect(r.stderr).toContain(GIT_REFUSED_MARKER);
			expect(r.stderr).toMatch(/shared checkout|worktree add --detach/);
		}
		expect(snapshot()).toEqual(before);
	});

	it.runIf(process.platform !== "win32")("PASS-AFTER through the Engine's spawn env, where the real PATH lookup finds the shim", () => {
		const env = { ...engineSpawnEnv(undefined, undefined, undefined, root), ...pick(BASE_ENV) };
		const before = snapshot();
		const r = sh("bash", "git reset --hard; git clean -fd", env);
		expect(r.stderr).toContain(GIT_REFUSED_MARKER);
		expect(snapshot()).toEqual(before);
	});

	it("refuses every repo-wide discard in every spelling, before git runs", () => {
		const before = snapshot();
		for (const args of [
			["reset", "--hard"],
			["reset", "--hard", "HEAD"],
			["-C", repo, "reset", "--hard"],
			["-c", "core.pager=cat", "reset", "-q", "--hard"],
			["clean", "-f"],
			["clean", "-fd"],
			["clean", "-fdx"],
			["clean", "--force", "-d"],
			["checkout", "-f"],
			["checkout", "--force", "main"],
			["checkout", "."],
			["checkout", "--", "."],
			["checkout", "HEAD", "--", "."],
			["checkout", ":/"],
			["restore", "."],
			["restore", "--worktree", "."],
			["restore", "--source=HEAD", "--", "."],
			["restore", "--staged", "--worktree", "."],
			["switch", "-f", "main"],
			["switch", "--discard-changes", "main"],
		]) {
			const r = shim(args);
			expect(r.status, args.join(" ")).toBe(GIT_REFUSED_EXIT);
			expect(r.stderr).toContain(GIT_REFUSED_MARKER);
		}
		expect(snapshot()).toEqual(before);
	});

	it("CONTROL: staging, targeted restores, branch switches and a dry-run clean still work — the guard is not a blanket", () => {
		for (const args of [
			["status", "--porcelain"],
			["diff", "--stat"],
			["reset", "--soft", "HEAD"],
			["reset", "HEAD", "b.txt"],
			["clean", "-n"],
			["clean", "-nd"],
			["clean", "--dry-run"],
			["restore", "--staged", "."],
			["restore", "--staged", "b.txt"],
			["add", "b.txt"],
			["checkout", "-b", "side"],
			["checkout", "main"],
		]) {
			const r = shim(args);
			expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
		}
		// The untracked file and the tracked edit were never at risk from any of the above.
		expect(snapshot().files["new.txt"]).toBe("owned untracked\n");
		expect(snapshot().files["a.txt"]).toBe("a.txt owned tracked edit\n");
	});

	it("CONTROL: discarding ONE named file, and a rebase onto another branch, are untouched", () => {
		expect(shim(["checkout", "HEAD", "--", "a.txt"]).status).toBe(0);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a.txt base\n");
		expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("owned untracked\n");
		git(["stash", "push", "-q", "-u", "-m", "park"]);
		expect(shim(["checkout", "-q", "-b", "feature"]).status).toBe(0);
		writeFileSync(join(repo, "f.txt"), "feature\n");
		shim(["add", "f.txt"]);
		expect(shim(["commit", "-qm", "feature"]).status).toBe(0);
		shim(["checkout", "-q", "main"]);
		writeFileSync(join(repo, "m.txt"), "main\n");
		shim(["add", "m.txt"]);
		shim(["commit", "-qm", "main moved"]);
		shim(["checkout", "-q", "feature"]);
		expect(shim(["rebase", "main"]).status).toBe(0);
	});
});

describe("every mutating command through the shim leaves an audit line (#1489)", () => {
	const shim = shimRunner();
	let log: string;
	let n2 = 0;
	const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
	const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => shim(args, { PAGS_SESSION_ID: "csess_test_1489", PAGS_GIT_AUDIT_LOG: log, ...extra });

	beforeEach(() => {
		log = join(tmp, `audit-${n2++}.log`).replaceAll("\\", "/");
	});

	it("records a refused discard and an allowed mutation with time, decision, session, pid, cwd and the whole command", () => {
		expect(run(["reset", "--hard"]).status).toBe(GIT_REFUSED_EXIT);
		expect(run(["reset", "HEAD", "b.txt"]).status).toBe(0);
		const [refused, allowed] = lines();
		expect(refused).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\trefused\treset\tsession=csess_test_1489\tpid=\d+\tppid=\d+\tcwd=/);
		expect(refused).toContain("reset --hard");
		expect(allowed).toMatch(/\tallowed\treset\tsession=csess_test_1489\t/);
		expect(allowed).toContain("reset HEAD b.txt");
	});

	it("records stash refusals too, and every other mutating subcommand it is asked to cover", () => {
		run(["stash", "pop"]);
		run(["checkout", "HEAD", "--", "a.txt"]);
		run(["restore", "--staged", "b.txt"]);
		run(["clean", "-n"]);
		expect(lines().map((l) => l.split("\t")[2])).toEqual(["stash", "checkout", "restore", "clean"]);
		expect(lines().map((l) => l.split("\t")[1])).toEqual(["refused", "allowed", "allowed", "allowed"]);
	});

	it("does not record reads", () => {
		run(["status", "--porcelain"]);
		run(["diff", "--stat"]);
		run(["log", "--oneline"]);
		expect(lines()).toEqual([]);
		run(["stash", "list"]); // stash IS a mutating subcommand by name, so this one is recorded
		expect(lines().map((l) => l.split("\t")[2])).toEqual(["stash"]);
	});

	it("names the actor 'unknown' rather than inventing one when no session id was given", () => {
		shim(["reset", "--hard"], { PAGS_GIT_AUDIT_LOG: log });
		expect(lines()[0]).toContain("session=unknown");
	});

	it("keeps a command's own tabs and newlines from forging another record", () => {
		run(["checkout", "-q", "-b", "a\tb\nrefused\tfake\tsession=forged"]);
		expect(lines()).toHaveLength(1);
		expect(lines()[0]).not.toContain("session=forged\t");
	});

	it("an audit log that cannot be written never stops git, and never turns a refusal into an allow", () => {
		writeFileSync(join(tmp, "plain-file"), "x");
		const unwritable = join(tmp, "plain-file", "x", "audit.log").replaceAll("\\", "/");
		expect(run(["reset", "HEAD", "b.txt"], { PAGS_GIT_AUDIT_LOG: unwritable }).status).toBe(0);
		expect(run(["reset", "--hard"], { PAGS_GIT_AUDIT_LOG: unwritable }).status).toBe(GIT_REFUSED_EXIT);
	});

	it("the runner puts the session's id in the engine's environment, so the line can name it", () => {
		const src = readFileSync(new URL("./headless.ts", import.meta.url), "utf8");
		expect(src).toMatch(/PAGS_SESSION_ID: this\.config\.id/);
	});
});

/** Runs the generated shim text as `sh <file> <git args>` against the current `repo`, with real git behind it. */
function shimRunner() {
	let file: string | null = null;
	return (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
		if (!file) {
			const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
			file = join(tmp, "shim-under-test.sh");
			writeFileSync(file, renderGitShim(realGit, join(tmp, "default-audit.log").replaceAll("\\", "/")));
		}
		// A session id inherited from whoever runs the suite (a coder session sets one) must not stand in for the actor.
		const env = { ...BASE_ENV, ...extraEnv };
		if (!("PAGS_SESSION_ID" in extraEnv)) delete env.PAGS_SESSION_ID;
		return spawnSync("sh", [file.replaceAll("\\", "/"), ...args], { cwd: repo, env, encoding: "utf8" });
	};
}

/** The git identity/config isolation, layered over an env built by production code. */
function pick(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { PATH: _path, ...rest } = env;
	return rest;
}
