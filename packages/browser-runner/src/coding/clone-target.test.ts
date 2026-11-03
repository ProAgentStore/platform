/** Clone destinations must never become a repository inside another repository's metadata. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { confineCloneTarget } from "./clone-target.js";

const home = realpathSync(mkdtempSync(join(tmpdir(), "pags-clone-target-")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: home, stdio: "pipe" });
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe("Git administration outside a .git-named directory", () => {
	it.each(["bare", "separate"])("refuses a missing child inside %s repository metadata", (kind) => {
		const metadata = join(home, `${kind}-metadata`);
		if (kind === "bare") git("init", "--bare", metadata);
		else git("init", "--separate-git-dir", metadata, join(home, "checkout"));
		const target = join(metadata, "objects", "new", "repo");
		expect(() => confineCloneTarget(target, { home, roots: [] })).toThrow(/git (administration|checkout)/i);
		expect(existsSync(target)).toBe(false);
	});

	it("allows an empty ordinary folder that happens to be named objects", () => {
		const target = join(home, "objects", "ordinary");
		mkdirSync(target, { recursive: true });
		expect(confineCloneTarget(target, { home, roots: [] })).toBe(target);
	});

	it("ignores inherited Git repository selection when refusing metadata and admitting an ordinary folder", () => {
		const other = join(home, "other-checkout");
		const metadata = join(home, "environment-metadata");
		git("init", other);
		git("init", "--bare", metadata);
		vi.stubEnv("GIT_DIR", join(other, ".git"));
		vi.stubEnv("GIT_WORK_TREE", other);
		vi.stubEnv("GIT_COMMON_DIR", join(other, ".git"));
		vi.stubEnv("GIT_CEILING_DIRECTORIES", metadata);
		expect(() => confineCloneTarget(join(metadata, "objects", "new"), { home, roots: [] })).toThrow(/git administration/);
		const ordinary = join(home, "environment-ordinary");
		expect(confineCloneTarget(ordinary, { home, roots: [] })).toBe(ordinary);
	});
});
