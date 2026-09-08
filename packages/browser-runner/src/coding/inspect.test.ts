import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	gitArgv,
	InspectError,
	insideWorkTree,
	readGitRemoteOrigin,
	readRepoFile,
	repoSearch,
	repoSync,
	repoTree,
	resetSyncCache,
	resolveInside,
	runRepoGit,
	SEARCH_MAX_RESULTS,
	SYNC_FETCH_TTL_MS,
	TREE_MAX_DEPTH,
	validateRef,
} from "./inspect.js";

describe("resolveInside (traversal guard)", () => {
	const root = "/home/u/repo";
	it("accepts paths inside the repo", () => {
		expect(resolveInside(root, "src/a.ts")).toBe("/home/u/repo/src/a.ts");
		expect(resolveInside(root, "./README.md")).toBe("/home/u/repo/README.md");
		expect(resolveInside(root, ".")).toBe(root);
	});
	it("rejects ../ traversal, absolute escape, and sibling-prefix", () => {
		expect(() => resolveInside(root, "../etc/passwd")).toThrow(InspectError);
		expect(() => resolveInside(root, "../../../../etc/passwd")).toThrow(InspectError);
		expect(() => resolveInside(root, "/etc/passwd")).toThrow(InspectError);
		// /home/u/repo-secrets must NOT be reachable from /home/u/repo
		expect(() => resolveInside("/home/u/repo", "../repo-secrets/x")).toThrow(InspectError);
	});
});

describe("gitArgv (whitelist)", () => {
	it("maps each command to a fixed argv", () => {
		// `--branch` is load-bearing, not cosmetic: the cloud parses the `## <branch>` header to
		// report which branch a subordinate is parked on (#276). Dropping it would silently turn
		// every branch report into "unknown" with nothing failing.
		expect(gitArgv("status")).toEqual(["status", "--short", "--branch"]);
		expect(gitArgv("diff")).toEqual(["diff"]);
		expect(gitArgv("diff-stat")).toEqual(["diff", "--stat"]);
		expect(gitArgv("ls-files")).toEqual(["ls-files"]);
	});
	it("clamps -n for log", () => {
		expect(gitArgv("log", { n: 5 })).toEqual(["log", "--oneline", "-n", "5"]);
		expect(gitArgv("log", { n: 99999 })).toEqual(["log", "--oneline", "-n", "200"]);
		expect(gitArgv("log", { n: -3 })).toEqual(["log", "--oneline", "-n", "1"]);
	});
	it("only appends a path after a literal -- separator", () => {
		expect(gitArgv("diff", { relPath: "src/a.ts" })).toEqual(["diff", "--", "src/a.ts"]);
	});
	it("honours `path` on EVERY command, not just diff (#508)", () => {
		// This assertion is the bug. `path` is advertised on the tool, resolved by runRepoGit and
		// validated by resolveInside — and four of the five branches then dropped it, so
		// `repo_git {cmd:"ls-files", path:"admin/lib/features/events"}` answered with every tracked
		// file in the repository, truncated mid-list at 12KB. The old test covered only `diff`,
		// which is exactly why nothing failed.
		expect(gitArgv("ls-files", { relPath: "src" })).toEqual(["ls-files", "--", "src"]);
		expect(gitArgv("diff-stat", { relPath: "src" })).toEqual(["diff", "--stat", "--", "src"]);
		expect(gitArgv("log", { n: 5, relPath: "src" })).toEqual(["log", "--oneline", "-n", "5", "--", "src"]);
		expect(gitArgv("status", { relPath: "src" })).toEqual(["status", "--short", "--branch", "--", "src"]);
	});
	it("keeps the path AFTER the separator in every one of them", () => {
		// The safety property the connector's header promises: no user string becomes a git token
		// except a validated path after a literal `--`. Adding four call sites is four chances to
		// put it in front of the separator, where git would read `-foo` as a flag.
		for (const cmd of ["status", "diff", "diff-stat", "log", "ls-files"] as const) {
			const argv = gitArgv(cmd, { relPath: "src" });
			expect(argv.indexOf("--"), cmd).toBeGreaterThan(-1);
			expect(argv.indexOf("src"), cmd).toBe(argv.indexOf("--") + 1);
		}
	});
	it("throws on an unknown command", () => {
		expect(() => gitArgv("rm" as never)).toThrow(InspectError);
	});

	describe("`ref` — the argument #785 tried and found silently ignored", () => {
		it("puts a ref where git expects a revision: before `--`, after the fixed flags", () => {
			expect(gitArgv("log", { n: 1, ref: "abc123" })).toEqual(["log", "--oneline", "-n", "1", "abc123"]);
			expect(gitArgv("log", { n: 1, ref: "abc123", relPath: "src" })).toEqual(["log", "--oneline", "-n", "1", "abc123", "--", "src"]);
			expect(gitArgv("diff", { ref: "origin/main" })).toEqual(["diff", "origin/main"]);
			expect(gitArgv("diff-stat", { ref: "HEAD~3", relPath: "src" })).toEqual(["diff", "--stat", "HEAD~3", "--", "src"]);
		});

		it("`show` is `--stat <sha>` and REQUIRES the sha — HEAD would be a guess dressed as an answer", () => {
			expect(gitArgv("show", { ref: "abc123" })).toEqual(["show", "--stat", "--format=medium", "abc123"]);
			expect(() => gitArgv("show")).toThrow(/needs a `ref`/);
		});

		it("ignores a ref on the commands that have no revision to take", () => {
			expect(gitArgv("status", { ref: "abc123" })).toEqual(["status", "--short", "--branch"]);
			expect(gitArgv("ls-files", { ref: "abc123" })).toEqual(["ls-files"]);
		});
	});
});

describe("validateRef — a revision may never become a flag (#785)", () => {
	it("accepts the revisions git itself accepts", () => {
		for (const ok of ["abc123", "6da7c9a1", "HEAD", "HEAD~3", "origin/main", "v1.2.0", "main..feature", "@{u}", "feature/x-1"]) {
			expect(validateRef(ok), ok).toBe(ok);
		}
	});
	it("refuses anything that starts with a dash, and anything with whitespace or shell noise", () => {
		// `--format=%H` was one of the three things #785 tried. It is refused by NAME, not silently
		// dropped, which is the whole difference between this and the bug.
		for (const bad of ["--format=%H", "-1", " ", "", "a b", "abc;rm", "$(x)", "a\nb"]) {
			expect(() => validateRef(bad), JSON.stringify(bad)).toThrow(InspectError);
		}
	});
});

describe("readRepoFile / runRepoGit / repoTree (on a real temp repo)", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-inspect-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;\n");
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("reads a file inside the repo", () => {
		const r = readRepoFile(dir, "src/app.ts");
		expect(r.content).toContain("export const x = 1;");
		expect(r.binary).toBeUndefined();
	});
	it("refuses traversal on read", () => {
		expect(() => readRepoFile(dir, "../../../etc/passwd")).toThrow(InspectError);
	});
	it("refuses a symlink that escapes the repo", () => {
		symlinkSync("/etc/passwd", join(dir, "escape"));
		expect(() => readRepoFile(dir, "escape")).toThrow(InspectError);
	});
	it("git diff reflects an uncommitted change; git status too", () => {
		writeFileSync(join(dir, "src", "app.ts"), "export const x = 2; // changed\n");
		expect(runRepoGit(dir, "diff").output).toMatch(/changed/);
		expect(runRepoGit(dir, "status").output).toMatch(/app\.ts/);
	});
	it("reports whether the `path` actually reached git, so an old runner can be caught (#508)", () => {
		// A runner is a separate release from the cloud that calls it. Before this, a machine that
		// ignored `path` returned the whole repository and the answer was indistinguishable from a
		// correct one; the cloud now says so instead of relaying it.
		expect(runRepoGit(dir, "ls-files", { path: "src" }).pathApplied).toBe(true);
		expect(runRepoGit(dir, "ls-files").pathApplied).toBe(false);
	});
	it("ls-files narrowed to a folder returns THAT folder, not the whole repo (#508)", () => {
		mkdirSync(join(dir, "other"), { recursive: true });
		writeFileSync(join(dir, "other", "elsewhere.ts"), "export const y = 2;\n");
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["commit", "-q", "-m", "other"], { cwd: dir });
		const out = runRepoGit(dir, "ls-files", { path: "src" }).output;
		expect(out).toContain("src/app.ts");
		expect(out).not.toContain("other/elsewhere.ts");
	});
	it("tree lists files, respects entry cap, skips ignored dirs", () => {
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "node_modules", "junk.js"), "x");
		const t = repoTree(dir);
		const paths = t.entries.map((e) => e.path);
		expect(paths).toContain("src");
		expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
		expect(paths.some((p) => p.startsWith("."))).toBe(false);
	});

	describe("a depth stop is VISIBLE (#508)", () => {
		// The failure this encodes: `truncated` was set by the ENTRY cap only, so a directory left
		// unwalked by the DEPTH cap was emitted as a plain entry with `truncated:false`. "This
		// folder is empty" and "this folder is deeper than I may look" were the same observation,
		// and the model resolved the ambiguity by calling repo_read_file on a directory.
		beforeAll(() => {
			mkdirSync(join(dir, "a", "b", "c", "d", "e"), { recursive: true });
			writeFileSync(join(dir, "a", "b", "c", "d", "e", "deep.ts"), "export const deep = 1;\n");
		});

		it("marks the directory whose contents were not listed, and says so at the top level", () => {
			const t = repoTree(dir, ".", 2);
			const stopped = t.entries.find((e) => e.path === join("a", "b"));
			expect(stopped, "a/b should be listed as a directory").toBeTruthy();
			expect(stopped?.deeper).toBe(true);
			expect(t.truncatedByDepth).toBe(true);
			// And the entry cap's flag is untouched — they are different facts.
			expect(t.truncated).toBe(false);
		});

		it("does NOT mark a directory it fully walked", () => {
			// The half that stops the marker from being decoration. `src` has no subdirectories, so
			// at any depth its contents ARE listed.
			const t = repoTree(dir, "src", 3);
			expect(t.entries.every((e) => !e.deeper)).toBe(true);
			expect(t.truncatedByDepth).toBe(false);
		});

		it("clamps maxDepth to the documented ceiling and reports which one it used", () => {
			// The tool advertised `maxDepth` with no ceiling, so a model asking for 10 got 4 and had
			// no way to learn that. The cap is now a named export the tool description interpolates.
			expect(repoTree(dir, ".", 99).depthCap).toBe(TREE_MAX_DEPTH);
			expect(repoTree(dir, ".", 2).depthCap).toBe(2);
		});
	});

	describe("repoSearch — the capability that did not exist (#508)", () => {
		beforeAll(() => {
			mkdirSync(join(dir, "a", "b", "c", "d", "e"), { recursive: true });
			writeFileSync(join(dir, "a", "b", "c", "d", "e", "event_form_dialog.ts"), "export class EventFormDialog {}\n");
		});

		it("finds a file SEVEN segments down, which no number of repo_tree calls could reach", () => {
			// The measured case. `a/b/c/d/e/event_form_dialog.ts` is deeper than the tree's four-level
			// cap, so browsing could never surface it without already knowing where it was.
			const r = repoSearch(dir, { pattern: "event_form", mode: "path" });
			expect(r.matches.map((m) => m.path)).toContain(join("a", "b", "c", "d", "e", "event_form_dialog.ts"));
			expect(r.mode).toBe("path");
		});

		it("finds it by CONTENT too, with file and line number", () => {
			const r = repoSearch(dir, { pattern: "class EventFormDialog", mode: "content" });
			expect(r.matches.length).toBeGreaterThan(0);
			expect(r.matches[0]?.path).toContain("event_form_dialog.ts");
			expect(r.matches[0]?.line).toBe(1);
			expect(r.matches[0]?.text).toContain("EventFormDialog");
		});

		it("matches a literal string, not a regex — `foo(` must not be a syntax error", () => {
			// A model searching code writes `foo(` or `a.b` without thinking about regex syntax. `-F`
			// makes that work AND removes any pathological pattern from the owner's own machine.
			writeFileSync(join(dir, "src", "call.ts"), "export const z = compute(1);\n");
			expect(repoSearch(dir, { pattern: "compute(", mode: "content" }).matches.length).toBe(1);
			expect(repoSearch(dir, { pattern: "compute(1).x", mode: "content" }).matches.length).toBe(0);
		});

		it("finds a file that is not committed yet", () => {
			// The one somebody is most likely to be looking for. `git ls-files` alone would deny it
			// exists, and `git grep` without --untracked would not read it.
			writeFileSync(join(dir, "src", "brand_new_thing.ts"), "export const brandNew = 1;\n");
			expect(repoSearch(dir, { pattern: "brand_new", mode: "path" }).matches.length).toBe(1);
			expect(repoSearch(dir, { pattern: "brandNew", mode: "content" }).matches.length).toBe(1);
		});

		it("narrows to a folder, and the pattern never becomes a git token in path mode", () => {
			expect(repoSearch(dir, { pattern: "app", mode: "path", path: "src" }).matches.every((m) => m.path.startsWith("src"))).toBe(true);
			// A pathspec-looking pattern is filtered in JS here, so it can neither escape nor match.
			expect(repoSearch(dir, { pattern: ":(exclude)src", mode: "path" }).matches).toEqual([]);
		});

		it("refuses a path that escapes the repo, in both modes", () => {
			for (const mode of ["path", "content"] as const) {
				expect(() => repoSearch(dir, { pattern: "x", mode, path: "../../../etc" })).toThrow(InspectError);
			}
		});

		it("reports a cut list by COUNT rather than slicing bytes off the end", () => {
			// #503's lesson: an arbitrary prefix with no statement that it IS a prefix reads to the
			// model as the complete answer. `total` is what tells it to narrow instead of conclude.
			mkdirSync(join(dir, "many"), { recursive: true });
			for (let i = 0; i < SEARCH_MAX_RESULTS + 12; i++) writeFileSync(join(dir, "many", `needle_${i}.ts`), "export const n = 1;\n");
			const r = repoSearch(dir, { pattern: "needle_", mode: "path" });
			expect(r.total).toBe(SEARCH_MAX_RESULTS + 12);
			expect(r.shown).toBe(SEARCH_MAX_RESULTS);
			expect(r.matches.length).toBe(SEARCH_MAX_RESULTS);
			expect(r.truncated).toBe(true);
		});

		it("an empty result is an ANSWER, not an error — git grep exits 1 for no matches", () => {
			const r = repoSearch(dir, { pattern: "nothing_here_at_all_xyzzy", mode: "content" });
			expect(r.matches).toEqual([]);
			expect(r.total).toBe(0);
			expect(r.truncated).toBe(false);
		});

		it("refuses an empty or oversize pattern rather than searching for everything", () => {
			expect(() => repoSearch(dir, { pattern: "   ", mode: "content" })).toThrow(InspectError);
			expect(() => repoSearch(dir, { pattern: "x".repeat(201), mode: "content" })).toThrow(InspectError);
		});
	});

	describe("a SUBDIRECTORY of a checkout is a checkout (#785, the `.git` gate)", () => {
		// `checkWorkdir` (repo.ts) says `~/monorepo/apps/thing` is inside a work tree because it asks
		// `git rev-parse`; three functions here asked `existsSync(".git")` and said the opposite. So
		// the staleness verdict called the folder healthy and `repo_git` in it answered "not a git
		// repo". Same folder, two answers — this pins the one that is true.
		it("runRepoGit, repoSearch and readGitRemoteOrigin all work from `src/`", () => {
			const sub = join(dir, "src");
			expect(insideWorkTree(sub)).toBe(true);
			expect(runRepoGit(sub, "status").output).toContain("##");
			expect(repoSearch(sub, { pattern: "app", mode: "path" }).matches.length).toBeGreaterThan(0);
			// No origin on this repo, so null — but no throw, and not because the gate refused.
			expect(readGitRemoteOrigin(sub)).toBeNull();
		});

		it("still refuses a plain folder and a missing path with the message the cloud matches", () => {
			mkdirSync(join(dir, "..", "plain-folder-785"), { recursive: true });
			expect(() => runRepoGit(join(dir, "..", "plain-folder-785"), "status")).toThrow(/not a git repo/);
			expect(() => runRepoGit(join(dir, "does-not-exist"), "status")).toThrow(/not a git repo/);
			expect(insideWorkTree(join(dir, "does-not-exist"))).toBe(false);
		});
	});

	describe("runRepoGit honours `ref` (#785)", () => {
		it("`log` with a ref and n:1 answers with THAT commit, and says the ref reached git", () => {
			const first = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
			const r = runRepoGit(dir, "log", { n: 1, ref: first });
			expect(r.refApplied).toBe(true);
			expect(r.output.trim().split("\n")).toHaveLength(1);
			expect(r.output).toContain("init");
		});
		it("`show` lists what one commit changed", () => {
			const first = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
			const r = runRepoGit(dir, "show", { ref: first });
			expect(r.output).toContain("src/app.ts");
			expect(r.output).toContain("1 file changed");
		});
		it("reports refApplied:false when no ref was given, so the cloud can tell 'ignored' from 'none'", () => {
			expect(runRepoGit(dir, "log", { n: 1 }).refApplied).toBe(false);
		});
		it("refuses a ref that would be read as a flag, before git ever sees it", () => {
			expect(() => runRepoGit(dir, "log", { ref: "--format=%H" })).toThrow(InspectError);
		});
	});
});

describe("repoSync — where a checkout stands against its upstream (#785)", () => {
	let base: string;
	let origin: string;
	let a: string;
	let b: string;
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const commit = (cwd: string, file: string, msg: string) => {
		writeFileSync(join(cwd, file), `${msg}\n`);
		git(cwd, "add", "-A");
		git(cwd, "commit", "-q", "-m", msg);
	};

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "pags-sync-"));
		origin = join(base, "origin.git");
		a = join(base, "a");
		b = join(base, "b");
		git(base, "init", "-q", "--bare", "-b", "main", origin);
		git(base, "clone", "-q", origin, a);
		git(a, "config", "user.email", "t@t.co");
		git(a, "config", "user.name", "t");
		git(a, "checkout", "-q", "-b", "main");
		mkdirSync(join(a, "src"));
		commit(a, "src/one.ts", "one");
		git(a, "push", "-q", "-u", "origin", "main");
		git(base, "clone", "-q", origin, b);
		git(b, "config", "user.email", "t@t.co");
		git(b, "config", "user.name", "t");
		resetSyncCache();
	});
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	it("is in sync right after a push", () => {
		const s = repoSync(a, { forceFetch: true });
		expect(s.checked).toBe(true);
		expect(s.branch).toBe("main");
		expect(s.upstream).toBe("origin/main");
		expect(s.ahead).toBe(0);
		expect(s.behind).toBe(0);
		expect(s.fetched).toBe(true);
		expect(s.fetchError).toBeNull();
		expect(s.localHead).toBe(s.remoteHead);
	});

	it("reports BEHIND after somebody else pushes — the incident, reproduced", () => {
		// 6da7c9a1 from the other machine. Nothing on disk in `a` changes; `behind` is what says
		// the reads that follow are reads of an old tree.
		commit(b, "src/two.ts", "two");
		git(b, "push", "-q", "origin", "main");
		const s = repoSync(a, { forceFetch: true });
		expect(s.behind).toBe(1);
		expect(s.ahead).toBe(0);
		expect(s.localHead).not.toBe(s.remoteHead);
		// And the file the other machine shipped is still not here — a pull is the caller's call.
		expect(existsSync(join(a, "src", "two.ts"))).toBe(false);
	});

	it("counts AHEAD from a local commit WITHOUT a new fetch — counts are fresh, the fetch is cached", () => {
		const before = repoSync(a);
		commit(a, "src/three.ts", "three");
		const after = repoSync(a);
		expect(after.ahead).toBe(1);
		expect(after.behind).toBe(1);
		expect(after.fetchedAt).toBe(before.fetchedAt);
	});

	it("fetches again once the TTL has passed", () => {
		const t0 = repoSync(a).fetchedAt ?? 0;
		const later = repoSync(a, { now: () => t0 + SYNC_FETCH_TTL_MS + 1 });
		expect(later.fetchedAt).toBeGreaterThan(t0);
	});

	it("answers the same from a subdirectory, keyed on the work-tree root", () => {
		const s = repoSync(join(a, "src"));
		expect(s.path).toBe(git(a, "rev-parse", "--show-toplevel"));
		expect(s.behind).toBe(1);
	});

	it("reports a fetch failure by NAME and keeps the last known counts, rather than saying in-sync", () => {
		git(a, "remote", "set-url", "origin", join(base, "nowhere.git"));
		resetSyncCache();
		const s = repoSync(a, { forceFetch: true });
		expect(s.fetched).toBe(false);
		expect(s.fetchError).toMatch(/nowhere|does not appear|not found|No such/i);
		// `origin/main` is still the ref the last successful fetch left, so the counts still hold.
		expect(s.behind).toBe(1);
		git(a, "remote", "set-url", "origin", origin);
		resetSyncCache();
	});

	it("falls back to origin/<configured branch> when HEAD is detached", () => {
		git(a, "checkout", "-q", "--detach", "HEAD");
		const s = repoSync(a, { branch: "main", forceFetch: true });
		expect(s.branch).toBeNull();
		expect(s.upstream).toBe("origin/main");
		expect(s.behind).toBe(1);
		git(a, "checkout", "-q", "main");
	});

	it("refuses a folder that is not a checkout", () => {
		expect(() => repoSync(base)).toThrow(/not a git repo/);
	});
});
