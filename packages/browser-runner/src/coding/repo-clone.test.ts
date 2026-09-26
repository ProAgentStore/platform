/**
 * `cloneIntoWorkdir` — the cold-start clone `coding_repo_add … clone:true` runs on the machine (#857).
 *
 * Against real git and a real temp upstream, because what matters is what lands on disk: a working
 * checkout with a clean `origin`, and nothing touched when something was already there.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneIntoWorkdir } from "./repo.js";

const tmp = mkdtempSync(join(tmpdir(), "pags-clone-"));
const upstream = join(tmp, "upstream.git");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

beforeAll(() => {
	const seed = join(tmp, "seed");
	mkdirSync(seed);
	git(seed, "init", "-q", "-b", "main");
	git(seed, "config", "user.email", "t@t");
	git(seed, "config", "user.name", "t");
	writeFileSync(join(seed, "README.md"), "grass-karma\n");
	git(seed, "add", ".");
	git(seed, "commit", "-q", "-m", "init");
	git(tmp, "clone", "-q", "--bare", seed, upstream);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("cloneIntoWorkdir (#857)", () => {
	it("clones into a path that does not exist yet, leaving a working checkout with a clean origin", () => {
		const dir = join(tmp, "absent", "grass-karma");
		expect(cloneIntoWorkdir(dir, upstream)).toEqual({ cloned: true, path: dir });
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("grass-karma\n");
		expect(git(dir, "remote", "get-url", "origin")).toBe(upstream);
	});

	it("clones into an EMPTY folder", () => {
		const dir = join(tmp, "empty");
		mkdirSync(dir);
		expect(cloneIntoWorkdir(dir, upstream).cloned).toBe(true);
		expect(existsSync(join(dir, ".git"))).toBe(true);
	});

	it("leaves an existing checkout untouched — nothing is cloned over it", () => {
		const dir = join(tmp, "absent", "grass-karma");
		writeFileSync(join(dir, "local.txt"), "mine");
		expect(cloneIntoWorkdir(dir, upstream)).toEqual({ cloned: false, path: dir });
		expect(readFileSync(join(dir, "local.txt"), "utf8")).toBe("mine");
	});

	it("never clones into a folder that has files in it", () => {
		const dir = join(tmp, "notes");
		mkdirSync(dir);
		writeFileSync(join(dir, "todo.txt"), "x");
		expect(cloneIntoWorkdir(dir, upstream).cloned).toBe(false);
		expect(existsSync(join(dir, ".git"))).toBe(false);
	});

	it("fails with git's own reason — promptly, never waiting on a prompt — for a repository it cannot reach", () => {
		expect(() => cloneIntoWorkdir(join(tmp, "missing-repo"), join(tmp, "no-such-upstream.git"))).toThrow(/Could not clone .* into/);
	});
});
