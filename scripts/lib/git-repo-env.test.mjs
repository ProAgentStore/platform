/**
 * #1722: a test fixture must never act on the repository a git hook points at.
 *
 * The sentinel repo stands in for the real one. A child process gets the hook's GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE aimed at it
 * and runs what fail-before's fixtures did during the incident: commit, create a branch, write core.bare and a fixture identity.
 * Through `vitest.setup-git-env.mjs` the sentinel must come out unchanged; without it (the control) it must NOT, or the
 * test proves nothing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isRepoLocationVar, scrubRepoLocation, withoutRepoLocation } from "./git-repo-env.mjs";

const SETUP = resolve(import.meta.dirname, "..", "..", "vitest.setup-git-env.mjs");
const made = [];
afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name) => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)));
	made.push(d);
	return d;
};
const CLEAN = withoutRepoLocation();
const git = (cwd, args) => spawnSync("git", args, { cwd, env: CLEAN, encoding: "utf8" });

function sentinel() {
	const dir = tmp("sentinel");
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["-c", "user.name=real", "-c", "user.email=real@example.invalid", "commit", "-q", "--allow-empty", "-m", "real work"]);
	writeFileSync(join(dir, "tracked.txt"), "x");
	git(dir, ["add", "tracked.txt"]);
	return dir;
}
const snapshot = (dir) => ({
	head: git(dir, ["rev-parse", "HEAD"]).stdout,
	branches: git(dir, ["branch", "--list", "--format=%(refname)"]).stdout,
	config: readFileSync(join(dir, ".git", "config"), "utf8"),
	index: readFileSync(join(dir, ".git", "index")).toString("hex"),
	log: git(dir, ["log", "--format=%H %s"]).stdout,
});

/** What the incident's fixture did, run in a child that inherits the hook's variables. */
const FIXTURE = `
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = mkdtempSync(join(require("node:os").tmpdir(), "fixture-"));
const g = (...a) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
g("init", "-q");
g("config", "user.name", "fixture");
g("config", "user.email", "fixture@example.invalid");
g("config", "core.bare", "true");
writeFileSync(join(dir, "f.txt"), "f");
g("add", "-A");
g("commit", "-q", "-m", "fixture base");
g("checkout", "-q", "-B", "wip/recovery");
`;

function runFixture(repo, { scrubbed }) {
	const env = { ...CLEAN, GIT_DIR: join(repo, ".git"), GIT_INDEX_FILE: join(repo, ".git", "index"), GIT_WORK_TREE: repo };
	const args = scrubbed ? ["--import", pathToFileURL(SETUP).href, "-e", FIXTURE] : ["-e", FIXTURE];
	const r = spawnSync(process.execPath, args, { env, encoding: "utf8" });
	expect(r.status, r.stderr).toBe(0);
}

describe("repo-location scrub (#1722)", () => {
	it("names every variable that picks or reconfigures the repository", () => {
		for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) expect(isRepoLocationVar(v), v).toBe(true);
		for (const v of ["PATH", "HOME", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "GITHUB_TOKEN"]) expect(isRepoLocationVar(v), v).toBe(false);
	});

	it("withoutRepoLocation copies, scrubRepoLocation mutates", () => {
		const env = { PATH: "/bin", GIT_DIR: "/x", GIT_CONFIG_COUNT: "1" };
		expect(withoutRepoLocation(env)).toEqual({ PATH: "/bin" });
		expect(env.GIT_DIR).toBe("/x");
		expect(scrubRepoLocation(env)).toEqual({ PATH: "/bin" });
		expect(env.GIT_DIR).toBeUndefined();
	});

	it("this test worker (vitest.setup-git-env.mjs) starts with none of them", () => {
		expect(Object.keys(process.env).filter(isRepoLocationVar)).toEqual([]);
	});

	it("control: without the scrub the inherited variables DO rewrite the sentinel", () => {
		const repo = sentinel();
		const before = snapshot(repo);
		runFixture(repo, { scrubbed: false });
		expect(snapshot(repo)).not.toEqual(before);
	});

	it("with the scrub, a fixture run under GIT_DIR=<sentinel> leaves it untouched: HEAD, config, branches, index", () => {
		const repo = sentinel();
		const before = snapshot(repo);
		runFixture(repo, { scrubbed: true });
		expect(snapshot(repo)).toEqual(before);
		expect(before.config).not.toMatch(/bare = true|fixture/);
	});
});
