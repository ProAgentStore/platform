/**
 * fail-before (#1021), on isolated temporary git repositories only — never the live checkout or its stashes.
 *
 * Each fixture holds a pre-existing UNRELATED stash and a recovery branch (foreign work), plus owned
 * edits of every kind: a tracked edit, a staged edit with a further unstaged edit, and an untracked new
 * file. Every test asserts what must not move: the stash object, the recovery ref, foreign files and the index.
 *
 * Strings named `INERT_*` are fixture data. The one shell sequence that IS executed (`OBSERVED_UNSAFE`)
 * runs only inside a temp repository, to reproduce the defect the helper exists to prevent.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, failBefore, pendingJournals, quoteForShell, restoreFromJournal } from "./fail-before.mjs";

const CLI = resolve(import.meta.dirname, "..", "fail-before.mjs");
const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const repos = [];
afterEach(() => {
	for (const d of repos.splice(0)) rmSync(d, { recursive: true, force: true });
});

function g(dir, ...args) {
	const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}
const put = (dir, f, text) => writeFileSync(join(dir, f), text);
const read = (dir, f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);

/** A temp repo with foreign recovery state and owned edits of every kind. */
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pags-fail-before-"));
	repos.push(dir);
	g(dir, "init", "-q", "-b", "main");
	g(dir, "config", "user.email", "fixture@example.invalid");
	g(dir, "config", "user.name", "fixture");
	put(dir, "a.txt", "a-base\n");
	put(dir, "b.txt", "b-base\n");
	put(dir, "other.txt", "other-base\n");
	g(dir, "add", ".");
	g(dir, "commit", "-q", "-m", "base");
	// Foreign: a recovery branch, and an unrelated stash someone left behind.
	g(dir, "branch", "wip/recovery");
	put(dir, "other.txt", "other-FOREIGN-STASHED\n");
	g(dir, "stash", "push", "-q", "-m", "foreign recovery work", "--", "other.txt");
	put(dir, "foreign-untracked.txt", "someone else's notes\n");
	// Owned: a tracked edit, a staged edit plus an unstaged one on top, and a new untracked file.
	put(dir, "a.txt", "a-OWNED-edit\n");
	put(dir, "b.txt", "b-OWNED-staged\n");
	g(dir, "add", "b.txt");
	put(dir, "b.txt", "b-OWNED-staged-then-edited\n");
	put(dir, "c.txt", "c-OWNED-new\n");
	return dir;
}

/** Everything that must be identical before and after: identities, files and the index. */
function state(dir) {
	return {
		// null once nothing is stashed — which is exactly what the reproduction below ends with.
		stash: spawnSync("git", ["rev-parse", "--verify", "-q", "refs/stash"], { cwd: dir, encoding: "utf8" }).stdout.trim() || null,
		stashList: g(dir, "stash", "list", "--format=%H %gs"),
		recovery: g(dir, "rev-parse", "wip/recovery"),
		head: g(dir, "rev-parse", "HEAD"),
		index: g(dir, "ls-files", "-s"),
		staged: g(dir, "diff", "--cached"),
		files: Object.fromEntries(["a.txt", "b.txt", "c.txt", "other.txt", "foreign-untracked.txt"].map((f) => [f, read(dir, f)])),
	};
}

describe("the observed defect, reproduced in a temp repo", () => {
	/** The compound command from the incident: an unquoted space-separated variable, then an unconditional pop. */
	const OBSERVED_UNSAFE = 'SRC="a.txt b.txt"; git stash push -q -- $SRC; git stash pop -q';

	it.skipIf(!has("zsh"))("zsh passes the variable as ONE pathspec, the save fails, and the pop consumes the unrelated stash", () => {
		const dir = fixture();
		const before = state(dir);
		spawnSync("zsh", ["-c", OBSERVED_UNSAFE], { cwd: dir, encoding: "utf8" });
		const after = state(dir);
		// The foreign stash was popped: its change is in the working tree and the stash entry is gone.
		expect(after.files["other.txt"]).toBe("other-FOREIGN-STASHED\n");
		expect(before.stash).not.toBeNull();
		expect(after.stash).toBeNull();
		// …and the owned edits the save was meant to protect were never saved at all.
		expect(after.files["a.txt"]).toBe(before.files["a.txt"]);
	});
});

describe("failBefore — the supported comparison never consumes foreign state", () => {
	it("the same joined-path mistake is refused by name, and nothing at all changes", () => {
		const dir = fixture();
		const before = state(dir);
		const INERT_JOINED_PATHS = "a.txt b.txt"; // what an unsplit shell variable delivers
		let ran = false;
		const run = () => {
			ran = true;
			return 0;
		};
		const r = failBefore({ cwd: dir, paths: [INERT_JOINED_PATHS], command: ["test-runner"], run });
		expect(r).toMatchObject({ ok: false, phase: "preflight", exit: EXIT.refused, mutated: false });
		expect(r.detail).toMatch(/2 paths in ONE argument/);
		expect(ran).toBe(false);
		expect(state(dir)).toEqual(before);
		expect(pendingJournals(dir)).toEqual([]);
	});

	it("runs the test against the base bytes of exactly the named files, then restores them — index, stash and foreign work untouched", () => {
		const dir = fixture();
		const before = state(dir);
		let during = null;
		const r = failBefore({
			cwd: dir,
			paths: ["a.txt", "b.txt", "c.txt"],
			command: ["test-runner"],
			run: () => {
				during = state(dir);
				return 0;
			},
		});
		expect(during.files).toEqual({ "a.txt": "a-base\n", "b.txt": "b-base\n", "c.txt": null, "other.txt": "other-base\n", "foreign-untracked.txt": "someone else's notes\n" });
		// The index is not the working tree: the staged edit stays staged while the test runs.
		expect(during.staged).toBe(before.staged);
		expect(during.stash).toBe(before.stash);
		expect(r).toMatchObject({ ok: true, phase: "done", testExit: 0, exit: 0, mutated: false });
		expect(state(dir)).toEqual(before);
		expect(pendingJournals(dir)).toEqual([]);
	});

	it("keeps the test's real failing status — a failed comparison is never relabelled a success", () => {
		const dir = fixture();
		const before = state(dir);
		const r = failBefore({ cwd: dir, paths: ["a.txt"], command: ["test-runner"], run: () => 3 });
		expect(r).toMatchObject({ ok: true, testExit: 3, exit: 3 });
		expect(state(dir)).toEqual(before);
	});

	it("a path with no change from the base still restores only itself, consuming nothing", () => {
		const dir = fixture();
		const before = state(dir);
		const r = failBefore({ cwd: dir, paths: ["other.txt"], command: ["test-runner"], run: () => 0 });
		expect(r).toMatchObject({ ok: true, exit: 0, restored: [] });
		expect(state(dir)).toEqual(before);
	});

	it("a stash pushed by someone else during the run is not popped, and the foreign stash keeps its identity", () => {
		const dir = fixture();
		const before = state(dir);
		const r = failBefore({
			cwd: dir,
			paths: ["a.txt"],
			command: ["test-runner"],
			run: () => {
				put(dir, "foreign-untracked.txt", "someone else's notes, changed\n");
				g(dir, "stash", "push", "-q", "-u", "-m", "another foreign stash", "--", "foreign-untracked.txt");
				return 0;
			},
		});
		expect(r).toMatchObject({ ok: true, exit: 0 });
		const after = state(dir);
		expect(after.files["a.txt"]).toBe(before.files["a.txt"]);
		expect(after.stashList.split("\n")).toHaveLength(2);
		expect(after.stashList).toContain(before.stash);
		expect(after.recovery).toBe(before.recovery);
	});

	it("a file someone else changed during the run is left as it is, reported, and its original kept in the journal", () => {
		const dir = fixture();
		const r = failBefore({
			cwd: dir,
			paths: ["a.txt", "b.txt"],
			command: ["test-runner"],
			run: () => {
				put(dir, "a.txt", "a-changed-by-someone-else\n");
				return 0;
			},
		});
		expect(r).toMatchObject({ ok: false, phase: "restore", exit: EXIT.conflict, conflicts: ["a.txt"], restored: ["b.txt"] });
		expect(read(dir, "a.txt")).toBe("a-changed-by-someone-else\n");
		expect(read(dir, "b.txt")).toBe("b-OWNED-staged-then-edited\n");
		expect(pendingJournals(dir)).toHaveLength(1);
	});

	it("an interrupted run leaves a journal; the next run refuses on unknown state; --restore finishes it exactly", () => {
		const dir = fixture();
		const before = state(dir);
		expect(() =>
			failBefore({
				cwd: dir,
				paths: ["a.txt", "c.txt"],
				command: ["test-runner"],
				run: () => {
					throw new Error("killed mid-run");
				},
			}),
		).toThrow("killed mid-run");
		const [journal] = pendingJournals(dir);
		expect(journal).toBeTruthy();
		expect(read(dir, "a.txt")).toBe("a-base\n");
		const again = failBefore({ cwd: dir, paths: ["b.txt"], command: ["test-runner"], run: () => 0 });
		expect(again).toMatchObject({ ok: false, exit: EXIT.unknownState, mutated: false });
		expect(read(dir, "b.txt")).toBe(before.files["b.txt"]);
		expect(restoreFromJournal(journal, g(dir, "rev-parse", "--show-toplevel"))).toMatchObject({ ok: true });
		expect(state(dir)).toEqual(before);
		expect(pendingJournals(dir)).toEqual([]);
	});

	it("refuses paths outside the repository, missing paths, and an empty command — mutating nothing", () => {
		const dir = fixture();
		const before = state(dir);
		for (const [paths, command, why] of [
			[["../escape.txt"], ["t"], /outside the repository/],
			[["nope.txt"], ["t"], /exists neither/],
			[["a.txt"], [], /no test command/],
		]) {
			const r = failBefore({ cwd: dir, paths, command, run: () => 0 });
			expect(r).toMatchObject({ ok: false, exit: EXIT.refused, mutated: false });
			expect(r.detail).toMatch(why);
		}
		expect(state(dir)).toEqual(before);
	});
});

describe("path arrays reach each supported shell as one word per path", () => {
	const INERT_PATHS = ["src/a b.ts", "it's.ts", "$HOME", "x;rm -rf y", "plain.ts"];
	for (const shell of ["sh", "bash", "zsh"]) {
		it.skipIf(!has(shell))(`${shell}: quoteForShell keeps every path whole and literal`, () => {
			const r = spawnSync(shell, ["-c", `printf '%s\\n' ${quoteForShell(INERT_PATHS, shell)}`], { encoding: "utf8" });
			expect(r.status).toBe(0);
			expect(r.stdout.split("\n").slice(0, -1)).toEqual(INERT_PATHS);
		});
	}

	it.skipIf(!has("zsh") || !has("bash"))("the observed difference: an unquoted variable is ONE word in zsh and split in bash", () => {
		const INERT_VAR = 'P="a.txt b.txt"; printf "%s\\n" $P';
		expect(spawnSync("zsh", ["-c", INERT_VAR], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)).toHaveLength(1);
		expect(spawnSync("bash", ["-c", INERT_VAR], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)).toHaveLength(2);
	});
});

describe("the CLI keeps the real exit status and prints a receipt", () => {
	const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
	const lastJson = (out) => JSON.parse(out.trim().split("\n").at(-1));

	it("passes a failing test's status through, restoring the files", () => {
		const dir = fixture();
		const before = state(dir);
		const r = cli(dir, "--path", "a.txt", "--path", "c.txt", "--", "sh", "-c", "test \"$(cat a.txt)\" = a-base && test ! -e c.txt && exit 5");
		expect(r.status).toBe(5);
		expect(lastJson(r.stdout)).toMatchObject({ ok: true, testExit: 5, exit: 5 });
		expect(state(dir)).toEqual(before);
	});

	it("a joined path argument exits 64 with nothing changed", () => {
		const dir = fixture();
		const before = state(dir);
		const r = cli(dir, "--path", "a.txt b.txt", "--", "true");
		expect(r.status).toBe(EXIT.refused);
		expect(lastJson(r.stdout).detail).toMatch(/ONE argument/);
		expect(state(dir)).toEqual(before);
	});
});

// ── #1021 safety matrix ───────────────────────────────────────────────────────────────────────────────
//
// Each class below was a defect in the first helper (b9fd69a5). Tests marked [seam] drive a fault through
// the `faults` hook the hardened helper adds; on the old helper they fail because that seam did not exist,
// not because of a behaviour they observe. Every other test observes the behaviour directly.

const modeOf = (dir, f) => statSync(join(dir, f)).mode & 0o777;
const isLink = (dir, f) => lstatSync(join(dir, f)).isSymbolicLink();
const outside = () => {
	const d = mkdtempSync(join(tmpdir(), "pags-fail-before-outside-"));
	repos.push(d);
	put(d, "target.txt", "OUTSIDE — must never be written\n");
	return d;
};
/** A fault that throws once, on the nth call matching `step` (and `detail`, when given). */
function faultAt(step, detail, nth = 1) {
	let seen = 0;
	let fired = false;
	return (s, d) => {
		if (fired || s !== step || (detail !== undefined && d !== detail)) return;
		if (++seen === nth) {
			fired = true;
			throw new Error(`injected ${step} fault`);
		}
	};
}
const crashRun = () => {
	throw new Error("killed mid-run");
};
const toplevel = (dir) => g(dir, "rev-parse", "--show-toplevel");

describe("(a) symlinks are refused before anything changes", () => {
	it("an UNTRACKED symlink is not replaced by a regular file", () => {
		const dir = fixture();
		symlinkSync("a.txt", join(dir, "lnk.txt"));
		const before = state(dir);
		let ran = false;
		const r = failBefore({ cwd: dir, paths: ["lnk.txt"], command: ["t"], run: () => {
			ran = true;
			return 0;
		} });
		expect(r).toMatchObject({ ok: false, phase: "preflight", exit: EXIT.refused, mutated: false });
		expect(r.detail).toMatch(/symlink/);
		expect(ran).toBe(false);
		expect(isLink(dir, "lnk.txt")).toBe(true);
		expect(state(dir)).toEqual(before);
	});

	it("a TRACKED symlink is never written through to the file it points at", () => {
		const dir = fixture();
		const out = outside();
		symlinkSync(join(out, "target.txt"), join(dir, "tl.txt"));
		g(dir, "add", "tl.txt");
		g(dir, "commit", "-q", "-m", "a tracked link", "--", "tl.txt");
		const r = failBefore({ cwd: dir, paths: ["tl.txt"], command: ["t"], run: () => 0 });
		expect(r).toMatchObject({ ok: false, exit: EXIT.refused, mutated: false });
		expect(read(out, "target.txt")).toBe("OUTSIDE — must never be written\n");
		expect(isLink(dir, "tl.txt")).toBe(true);
	});

	it("a symlinked parent directory cannot carry a write outside the repository", () => {
		const dir = fixture();
		const out = outside();
		symlinkSync(out, join(dir, "ld"));
		let ran = false;
		const r = failBefore({ cwd: dir, paths: ["ld/target.txt"], command: ["t"], run: () => {
			ran = true;
			return 0;
		} });
		expect(r).toMatchObject({ ok: false, exit: EXIT.refused, mutated: false });
		expect(r.detail).toMatch(/symlink/);
		expect(ran).toBe(false);
		expect(read(out, "target.txt")).toBe("OUTSIDE — must never be written\n");
	});
});

describe("(f) git administrative metadata, nested repositories and escapes are refused up front", () => {
	for (const p of [".git/index", ".git/HEAD", "sub/../.git/config", ".GIT/config"]) {
		it(`${p} is refused, the index stays byte-identical, and the test never runs`, () => {
			const dir = fixture();
			const before = state(dir);
			const index = readFileSync(join(dir, ".git", "index"));
			let ran = false;
			const r = failBefore({ cwd: dir, paths: [p], command: ["t"], run: () => {
			ran = true;
			return 0;
		} });
			expect(r).toMatchObject({ ok: false, phase: "preflight", exit: EXIT.refused, mutated: false });
			expect(ran).toBe(false);
			expect(readFileSync(join(dir, ".git", "index")).equals(index)).toBe(true);
			expect(state(dir)).toEqual(before);
		});
	}

	it("a path inside a nested repository is refused", () => {
		const dir = fixture();
		mkdirSync(join(dir, "nested"));
		g(join(dir, "nested"), "init", "-q");
		put(dir, "nested/n.txt", "nested work\n");
		let ran = false;
		const r = failBefore({ cwd: dir, paths: ["nested/n.txt"], command: ["t"], run: () => {
			ran = true;
			return 0;
		} });
		expect(r).toMatchObject({ ok: false, exit: EXIT.refused, mutated: false });
		expect(r.detail).toMatch(/nested repository/);
		expect(ran).toBe(false);
		expect(read(dir, "nested/n.txt")).toBe("nested work\n");
	});

	it("a linked worktree's own admin files are refused from inside that worktree", () => {
		const dir = fixture();
		const wt = join(mkdtempSync(join(tmpdir(), "pags-fail-before-wt-")), "wt");
		repos.push(dirname(wt));
		g(dir, "worktree", "add", "-q", "--detach", wt, "HEAD");
		const admin = g(wt, "rev-parse", "--absolute-git-dir");
		const r = failBefore({ cwd: wt, paths: [join(admin, "HEAD")], command: ["t"], run: () => 0 });
		expect(r).toMatchObject({ ok: false, exit: EXIT.refused, mutated: false });
	});
});

describe("(b) a journal is bound to its repository", () => {
	it("a journal from repo A is refused in repo B: nothing in B changes, A's journal is kept and still restores A", () => {
		const a = fixture();
		const b = fixture();
		const beforeA = state(a);
		const beforeB = state(b);
		expect(() => failBefore({ cwd: a, paths: ["a.txt", "c.txt"], command: ["t"], run: crashRun })).toThrow("killed mid-run");
		const [journal] = pendingJournals(a);
		const r = restoreFromJournal(journal, toplevel(b));
		expect(r).toMatchObject({ ok: false, exit: EXIT.unknownState });
		expect(r.detail).toMatch(/belongs to/);
		expect(state(b)).toEqual(beforeB);
		expect(existsSync(journal)).toBe(true);
		expect(restoreFromJournal(journal, toplevel(a))).toMatchObject({ ok: true });
		expect(state(a)).toEqual(beforeA);
	});

	it("a journal copied into another repository's git dir is refused there", () => {
		const a = fixture();
		const b = fixture();
		const beforeB = state(b);
		expect(() => failBefore({ cwd: a, paths: ["a.txt"], command: ["t"], run: crashRun })).toThrow();
		const [journal] = pendingJournals(a);
		const copy = join(b, ".git", "pags-fail-before", "copied");
		cpSync(journal, copy, { recursive: true });
		expect(restoreFromJournal(copy, toplevel(b))).toMatchObject({ ok: false, exit: EXIT.unknownState });
		expect(state(b)).toEqual(beforeB);
	});

	it("the CLI's --restore from repo B exits 75 and changes nothing", () => {
		const a = fixture();
		const b = fixture();
		const beforeB = state(b);
		expect(() => failBefore({ cwd: a, paths: ["a.txt"], command: ["t"], run: crashRun })).toThrow();
		const [journal] = pendingJournals(a);
		const r = spawnSync(process.execPath, [CLI, "--restore", journal], { cwd: b, encoding: "utf8" });
		expect(r.status).toBe(EXIT.unknownState);
		expect(state(b)).toEqual(beforeB);
		expect(existsSync(journal)).toBe(true);
	});
});

describe("(c) every backup is verified before any file is written", () => {
	it("a corrupt backup stops the restore before it writes anything — even the files whose backups are fine", () => {
		const dir = fixture();
		expect(() => failBefore({ cwd: dir, paths: ["a.txt", "b.txt"], command: ["t"], run: crashRun })).toThrow();
		const [journal] = pendingJournals(dir);
		writeFileSync(join(journal, "files", "1"), "CORRUPTED\n");
		const r = restoreFromJournal(journal, toplevel(dir));
		expect(r).toMatchObject({ ok: false, exit: EXIT.unknownState, restored: [] });
		expect(r.detail).toMatch(/backup of b\.txt/);
		expect(read(dir, "a.txt")).toBe("a-base\n");
		expect(read(dir, "b.txt")).toBe("b-base\n");
		expect(existsSync(join(journal, "files", "1"))).toBe(true);
	});

	it("a missing backup is the same refusal", () => {
		const dir = fixture();
		expect(() => failBefore({ cwd: dir, paths: ["a.txt"], command: ["t"], run: crashRun })).toThrow();
		const [journal] = pendingJournals(dir);
		rmSync(join(journal, "files", "0"));
		expect(restoreFromJournal(journal, toplevel(dir))).toMatchObject({ ok: false, exit: EXIT.unknownState });
		expect(read(dir, "a.txt")).toBe("a-base\n");
	});

	it("an edited journal manifest does not verify, so it cannot redirect a restore", () => {
		const dir = fixture();
		const before = state(dir);
		expect(() => failBefore({ cwd: dir, paths: ["a.txt"], command: ["t"], run: crashRun })).toThrow();
		const [journal] = pendingJournals(dir);
		const file = join(journal, "journal.json");
		writeFileSync(file, readFileSync(file, "utf8").replace('"path": "a.txt"', '"path": "other.txt"'));
		expect(restoreFromJournal(journal, toplevel(dir))).toMatchObject({ ok: false, exit: EXIT.unknownState });
		expect(read(dir, "other.txt")).toBe(before.files["other.txt"]);
		expect(read(dir, "a.txt")).toBe("a-base\n");
	});
});

describe("(e) content, type and mode are one state", () => {
	it("an owned mode-only change is compared at the base mode, and comes back afterwards", () => {
		const dir = fixture();
		chmodSync(join(dir, "other.txt"), 0o755);
		let during = null;
		const r = failBefore({ cwd: dir, paths: ["other.txt"], command: ["t"], run: () => {
			during = modeOf(dir, "other.txt");
			return 0;
		} });
		expect(r).toMatchObject({ ok: true, exit: 0 });
		expect(during).toBe(0o644);
		expect(modeOf(dir, "other.txt")).toBe(0o755);
	});

	it("an executable at the base is executable while the test runs", () => {
		const dir = fixture();
		put(dir, "run.sh", "#!/bin/sh\nexit 0\n");
		chmodSync(join(dir, "run.sh"), 0o755);
		g(dir, "add", "run.sh");
		g(dir, "commit", "-q", "-m", "exec", "--", "run.sh");
		put(dir, "run.sh", "#!/bin/sh\nexit 1\n");
		chmodSync(join(dir, "run.sh"), 0o644);
		let during = null;
		failBefore({ cwd: dir, paths: ["run.sh"], command: ["t"], run: () => {
			during = modeOf(dir, "run.sh");
			return 0;
		} });
		expect(during).toBe(0o755);
		expect(modeOf(dir, "run.sh")).toBe(0o644);
		expect(read(dir, "run.sh")).toBe("#!/bin/sh\nexit 1\n");
	});

	it("a FOREIGN mode-only change during the run is a conflict: left as it is, reported, journal kept", () => {
		const dir = fixture();
		const r = failBefore({ cwd: dir, paths: ["a.txt"], command: ["t"], run: () => {
			chmodSync(join(dir, "a.txt"), 0o755);
			return 0;
		} });
		expect(r).toMatchObject({ ok: false, phase: "restore", exit: EXIT.conflict, conflicts: ["a.txt"] });
		expect(read(dir, "a.txt")).toBe("a-base\n");
		expect(modeOf(dir, "a.txt")).toBe(0o755);
		expect(pendingJournals(dir)).toHaveLength(1);
	});

	it("a file replaced by a symlink during the run is a conflict, and the link is not followed", () => {
		const dir = fixture();
		const out = outside();
		const r = failBefore({
			cwd: dir,
			paths: ["a.txt"],
			command: ["t"],
			run: () => {
				rmSync(join(dir, "a.txt"));
				symlinkSync(join(out, "target.txt"), join(dir, "a.txt"));
				return 0;
			},
		});
		expect(r).toMatchObject({ ok: false, exit: EXIT.conflict, conflicts: ["a.txt"] });
		expect(read(out, "target.txt")).toBe("OUTSIDE — must never be written\n");
	});
});

describe("(d) setup, journal writes and restores are crash- and error-safe", () => {
	it("a journal directory with no readable journal is unknown state, and stops the next run", () => {
		const dir = fixture();
		const before = state(dir);
		mkdirSync(join(dir, ".git", "pags-fail-before", "crashed-before-first-write"), { recursive: true });
		const r = failBefore({ cwd: dir, paths: ["a.txt"], command: ["t"], run: () => 0 });
		expect(r).toMatchObject({ ok: false, exit: EXIT.unknownState, mutated: false });
		expect(state(dir)).toEqual(before);
	});

	it("[seam] a journal write that fails AFTER a base write leaves that file recognisably ours, and setup rolls it back", () => {
		const dir = fixture();
		const before = state(dir);
		// Journal saves in `applying`: the state change, a.txt's intent, a.txt's done mark (the third).
		const r = failBefore({ cwd: dir, paths: ["a.txt", "b.txt"], command: ["t"], run: () => 0, faults: faultAt("journal", "applying", 3) });
		expect(r).toMatchObject({ ok: false, phase: "apply", exit: EXIT.refused, mutated: false, testExit: null });
		expect(state(dir)).toEqual(before);
		expect(pendingJournals(dir)).toEqual([]);
	});

	it("[seam] a write that fails on the second file rolls back the first exactly, and the test never runs", () => {
		const dir = fixture();
		const before = state(dir);
		let ran = false;
		const r = failBefore({ cwd: dir, paths: ["a.txt", "c.txt", "b.txt"], command: ["t"], run: () => {
			ran = true;
			return 0;
		}, faults: faultAt("apply", "b.txt") });
		expect(r).toMatchObject({ ok: false, phase: "apply", mutated: false });
		expect(ran).toBe(false);
		expect(state(dir)).toEqual(before);
	});

	it("[seam] a rollback that is itself interrupted keeps the journal with a truthful receipt; a retry finishes it", () => {
		const dir = fixture();
		const before = state(dir);
		const apply = faultAt("apply", "b.txt");
		const restore = faultAt("restore", "a.txt");
		const r = failBefore({ cwd: dir, paths: ["a.txt", "b.txt"], command: ["t"], run: () => 0, faults: (s, d) => {
				apply(s, d);
				restore(s, d);
			},
		});
		expect(r).toMatchObject({ ok: false, phase: "apply", mutated: true });
		const [journal] = pendingJournals(dir);
		expect(journal).toBeTruthy();
		expect(restoreFromJournal(journal, toplevel(dir))).toMatchObject({ ok: true });
		expect(state(dir)).toEqual(before);
	});

	it("[seam] a restore interrupted after the first file is fully back resumes from the second", () => {
		const dir = fixture();
		const before = state(dir);
		const r = failBefore({ cwd: dir, paths: ["a.txt", "b.txt"], command: ["t"], run: () => 0, faults: faultAt("restore", "a.txt") });
		expect(r).toMatchObject({ ok: false, phase: "restore", exit: EXIT.unknownState, mutated: true });
		expect(read(dir, "a.txt")).toBe(before.files["a.txt"]);
		expect(read(dir, "b.txt")).toBe("b-base\n");
		const [journal] = pendingJournals(dir);
		expect(restoreFromJournal(journal, toplevel(dir))).toMatchObject({ ok: true, restored: ["b.txt"] });
		expect(state(dir)).toEqual(before);
	});

	it("[seam] a restore interrupted between its temp write and the rename leaves the target untouched, and a retry cleans up after itself", () => {
		const dir = fixture();
		const before = state(dir);
		const r = failBefore({ cwd: dir, paths: ["a.txt"], command: ["t"], run: () => 0, faults: faultAt("rename", join(toplevel(dir), "a.txt"), 2) });
		expect(r).toMatchObject({ ok: false, mutated: true });
		expect(read(dir, "a.txt")).toBe("a-base\n"); // never a torn mix of the two
		expect(readdirSync(dir).filter((f) => f.includes("pags-fb-tmp"))).toHaveLength(1);
		const [journal] = pendingJournals(dir);
		expect(restoreFromJournal(journal, toplevel(dir))).toMatchObject({ ok: true });
		expect(readdirSync(dir).filter((f) => f.includes("pags-fb-tmp"))).toEqual([]);
		expect(state(dir)).toEqual(before);
	});

	it("restoring twice is safe: the second call finds no journal, changes nothing and says so", () => {
		const dir = fixture();
		const before = state(dir);
		expect(() => failBefore({ cwd: dir, paths: ["a.txt"], command: ["t"], run: crashRun })).toThrow();
		const [journal] = pendingJournals(dir);
		expect(restoreFromJournal(journal, toplevel(dir))).toMatchObject({ ok: true });
		expect(restoreFromJournal(journal, toplevel(dir))).toMatchObject({ ok: false, exit: EXIT.unknownState });
		expect(state(dir)).toEqual(before);
	});

	it("a conflict keeps its evidence: the journal and the original bytes survive for a later decision", () => {
		const dir = fixture();
		const r = failBefore({ cwd: dir, paths: ["a.txt"], command: ["t"], run: () => {
			put(dir, "a.txt", "foreign\n");
			return 0;
		} });
		expect(r).toMatchObject({ ok: false, exit: EXIT.conflict });
		const [journal] = pendingJournals(dir);
		expect(readFileSync(join(journal, "files", "0"), "utf8")).toBe("a-OWNED-edit\n");
		expect(restoreFromJournal(journal, toplevel(dir))).toMatchObject({ ok: false, exit: EXIT.conflict });
		expect(existsSync(journal)).toBe(true);
	});
});

describe("the CLI's exit statuses are the test's own, through the hardened restore", () => {
	const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
	it("a missing command is 127, with every file restored", () => {
		const dir = fixture();
		const before = state(dir);
		const r = cli(dir, "--path", "a.txt", "--", "pags-no-such-command-1021");
		expect(r.status).toBe(127);
		expect(state(dir)).toEqual(before);
	});

	it("a signal-killed test is 143 (128+TERM), never a success", () => {
		const dir = fixture();
		const before = state(dir);
		const r = cli(dir, "--path", "a.txt", "--", "sh", "-c", "kill -TERM $$");
		expect(r.status).toBe(143);
		expect(state(dir)).toEqual(before);
	});

	it("the argv reaches the test literally, with no shell in between", () => {
		const dir = fixture();
		const INERT_ARG = "$(touch pwned);*";
		const r = cli(dir, "--path", "a.txt", "--", process.execPath, "-e", "process.exit(process.argv[1] === '$(touch pwned);*' ? 0 : 9)", INERT_ARG);
		expect(r.status).toBe(0);
		expect(existsSync(join(dir, "pwned"))).toBe(false);
	});
});
