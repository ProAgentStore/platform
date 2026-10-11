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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
