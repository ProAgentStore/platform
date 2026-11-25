import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parkSnapshot } from "./park-snapshot.js";
import { namedInCommand, ShellEditTracker } from "./shell-edits.js";

/**
 * #1717 — shell edits (`sed -i`, `git mv`) are attributed to the run only on evidence: clean before the command, different after it, and named
 * by it. Real temporary repositories; a dirty tree alone proves nothing, and anything that is not provable stays exactly where it is.
 */

const RUN = "11111111-2222-4333-8444-555555555555";
let dir: string;
const git = (...argv: string[]) => execFileSync("git", argv, { cwd: dir, encoding: "utf-8" });
const write = (p: string, body: string) => writeFileSync(join(dir, p), body);
const sh = (...argv: string[]) => execFileSync(argv[0], argv.slice(1), { cwd: dir });
/** Run one "shell command" the way the session sees it: begin, do the work, result. */
function run(tracker: ShellEditTracker, id: string, command: string, work: () => void) {
	tracker.begin(id, { command });
	work();
	tracker.end(id);
}

beforeEach(() => {
	// The long path: Windows temp dirs come back as 8.3 names (RUNNER~1), and `~` is a glob character namedInCommand skips.
	dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pags-shell-")));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	mkdirSync(join(dir, "src"));
	write("src/a.ts", "export const a = 1;\n");
	write("src/b.ts", "export const b = 1;\n");
	write("src/c.ts", "export const c = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "first");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("namedInCommand", () => {
	it("names whole arguments and containing directories, never globs, the root or outside paths", () => {
		expect(namedInCommand("src/a.ts", "sed -i 's/1/2/' src/a.ts", dir)).toBe(true);
		expect(namedInCommand("src/a.ts", "sed -i s/1/2/ ./src/a.ts", dir)).toBe(true);
		expect(namedInCommand("src/a.ts", `git mv src lib`, dir)).toBe(true);
		expect(namedInCommand("src/a.ts", `sed -i s/1/2/ ${join(dir, "src/a.ts").replaceAll("\\", "/")}`, dir)).toBe(true);
		expect(namedInCommand("src/a.ts", "sed -i s/1/2/ src/*.ts", dir)).toBe(false);
		expect(namedInCommand("src/a.ts", "biome format --write .", dir)).toBe(false);
		expect(namedInCommand("src/a.ts", "sed -i s/1/2/ ../src/a.ts", dir)).toBe(false);
		expect(namedInCommand("src/ab.ts", "sed -i s/1/2/ src/a", dir)).toBe(false); // a prefix of the NAME is not the directory
	});
});

describe("ShellEditTracker + parkSnapshot", () => {
	it("a `sed -i` on a named, clean file is the run's: the park sets it aside and nothing else", () => {
		const owned = new Set<string>();
		const t = new ShellEditTracker(dir, owned);
		write("src/c.ts", "export const c = 'someone else';\n"); // an unrelated edit, there before the command
		run(t, "t1", "sed -i s/1/2/ src/a.ts", () => sh("sed", "-i.bak", "s/1/2/", "src/a.ts"));
		sh("rm", join(dir, "src/a.ts.bak"));
		expect([...owned]).toEqual(["src/a.ts"]);
		const r = parkSnapshot(dir, RUN, { owned: [...owned] });
		expect(r.snapshot).toBeTruthy();
		expect(r.unowned).toEqual(["src/c.ts"]); // untouched, not stashed
		expect(git("status", "--porcelain").trim()).toBe("M src/c.ts");
	});

	it("`git mv` is the run's, source and target both, and the park leaves the tree clean", () => {
		const owned = new Set<string>();
		const t = new ShellEditTracker(dir, owned);
		run(t, "t1", "git mv src/a.ts src/renamed.ts", () => git("mv", "src/a.ts", "src/renamed.ts"));
		expect([...owned].sort()).toEqual(["src/a.ts", "src/renamed.ts"]);
		const r = parkSnapshot(dir, RUN, { owned: [...owned] });
		expect(r.clean).toBe(true);
		expect(git("status", "--porcelain").trim()).toBe("");
	});

	it("a file somebody else had already left dirty is never claimed, even when the command then edits it", () => {
		const owned = new Set<string>();
		const t = new ShellEditTracker(dir, owned);
		write("src/b.ts", "export const b = 'human';\n");
		run(t, "t1", "sed -i s/human/robot/ src/b.ts", () => sh("sed", "-i.bak", "s/human/robot/", "src/b.ts"));
		sh("rm", join(dir, "src/b.ts.bak"));
		expect(owned.size).toBe(0);
		const r = parkSnapshot(dir, RUN, { owned: [...owned] });
		expect(r.snapshot).toBeNull();
		expect(r.clean).toBe(false);
	});

	it("changes the command does not name are not claimed (a glob, a formatter over the whole tree)", () => {
		const owned = new Set<string>();
		const t = new ShellEditTracker(dir, owned);
		run(t, "t1", "sed -i s/1/2/ src/*.ts", () => {
			write("src/a.ts", "export const a = 2;\n");
			write("src/b.ts", "export const b = 2;\n");
		});
		expect(owned.size).toBe(0);
		const r = parkSnapshot(dir, RUN, { owned: [] });
		expect(r.conflict).toBeUndefined();
		expect(r.unowned?.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(git("status", "--porcelain").trim().split("\n")).toHaveLength(2); // exactly as they were
	});

	it("a command that changed nothing, or whose result never came, claims nothing", () => {
		const owned = new Set<string>();
		const t = new ShellEditTracker(dir, owned);
		run(t, "t1", "cat src/a.ts", () => undefined);
		t.begin("t2", { command: "sed -i s/1/2/ src/a.ts" });
		write("src/a.ts", "export const a = 2;\n");
		t.clear(); // the turn ended with no result for t2
		t.end("t2");
		expect(owned.size).toBe(0);
	});

	it("without the tracker nothing is attributed: a repository that asked for no tracking behaves as before", () => {
		write("src/a.ts", "export const a = 2;\n");
		const r = parkSnapshot(dir, RUN, {});
		expect(r.conflict).toBe("ownership_unknown");
		expect(r.snapshot).toBeNull();
	});
});
