import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitArgv, InspectError, readRepoFile, repoTree, resolveInside, runRepoGit } from "./inspect.js";

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
		expect(gitArgv("status")).toEqual(["status", "--short"]);
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
	it("throws on an unknown command", () => {
		expect(() => gitArgv("rm" as never)).toThrow(InspectError);
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
	it("tree lists files, respects entry cap, skips ignored dirs", () => {
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "node_modules", "junk.js"), "x");
		const t = repoTree(dir);
		const paths = t.entries.map((e) => e.path);
		expect(paths).toContain("src");
		expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
		expect(paths.some((p) => p.startsWith("."))).toBe(false);
	});
});
