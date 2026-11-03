/** #1457: reserved directory names cannot be bypassed by case; ordinary names follow the filesystem. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confineCloneTarget } from "./clone-target.js";
import { liveCloneDeps } from "./repo-clone-job.js";
import { CodingRuntime } from "./runtime.js";
import { confineWorkDir, realPathOf } from "./workdir-guard.js";

const base = realpathSync.native(mkdtempSync(join(tmpdir(), "pags-path-case-")));
let home: string;
beforeEach(() => {
	home = mkdtempSync(join(base, "home-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("reserved credential names", () => {
	it.each([".SSH", ".CONFIG/PROAGENTSTORE", ".Aws/credentials", "library/KEYCHAINS"])("refuses missing %s without creating a credential directory", (name) => {
		const path = join(home, name);
		expect(() => confineCloneTarget(path, { home, roots: [] })).toThrow(/credentials/);
		expect(() => confineWorkDir(path, { home, roots: [path] })).toThrow(/credentials/);
		expect(existsSync(path)).toBe(false);
	});

	it("reserves ancestor names for clone destinations even on case-sensitive filesystems", () => {
		for (const name of [".CONFIG", "library"]) {
			expect(() => confineCloneTarget(join(home, name), { home, roots: [] })).toThrow(/credentials/);
			expect(existsSync(join(home, name))).toBe(false);
		}
	});

	it("refuses an existing differently cased credential folder even when registered", () => {
		const path = join(home, ".SSH");
		mkdirSync(path);
		expect(() => confineWorkDir(path, { home, roots: [path] })).toThrow(/credentials/);
		expect(() => confineCloneTarget(join(path, "repo"), { home, roots: [] })).toThrow(/credentials/);
	});
});

describe("ordinary directory identity", () => {
	it("canonicalizes existing names without conflating distinct case-sensitive directories", () => {
		const upper = join(home, "Project");
		const lower = join(home, "project");
		mkdirSync(upper);
		const insensitive = existsSync(lower);
		if (!insensitive) mkdirSync(lower);
		expect(realPathOf(upper, home)).toBe(realpathSync.native(upper));
		expect(realPathOf(lower, home)).toBe(realpathSync.native(lower));
		expect(realPathOf(upper, home) === realPathOf(lower, home)).toBe(insensitive);
	});

	it("recognizes a differently cased spelling of the home boundary when it exists", () => {
		const spelling = existsSync(home.toUpperCase()) ? home.toUpperCase() : home;
		expect(confineCloneTarget(join(spelling, "new-project"), { home, roots: [] })).toBe(join(home, "new-project"));
	});

	it("joins absent destination aliases only when the filesystem treats them as the same directory", async () => {
		const runtime = new CodingRuntime(join(home, ".config", "proagentstore", "repos"));
		const finishes: Array<() => void> = [];
		const clone = vi.spyOn(liveCloneDeps, "clone").mockImplementation(() => new Promise<void>((resolve) => finishes.push(resolve)));
		const upper = join(home, "CasePending");
		const lower = join(home, "casepending");
		mkdirSync(join(home, "CaseProbe"));
		const insensitive = existsSync(join(home, "caseprobe"));
		const first = runtime.startClone({ workDir: upper, slug: "acme/chinese", protocol: "https" });
		const second = runtime.startClone({ workDir: lower, slug: "ACME/CHINESE", protocol: "https" });
		try {
			expect(first === second).toBe(insensitive);
			expect(clone).toHaveBeenCalledTimes(insensitive ? 1 : 2);
			expect(runtime.cloneStatus({ workDir: lower })).toBe(second);
			expect(() => runtime.startClone({ workDir: lower, slug: "other/repository" })).toThrow(/different repository/);
		} finally {
			for (const finish of finishes) finish();
		}
		await vi.waitFor(() => expect([first.state, second.state]).toEqual(["done", "done"]));
		expect(runtime.cloneStatus({ workDir: lower })).toBe(second);
	});

	it("keeps a failed empty reservation retryable and reports the replacement job", async () => {
		const runtime = new CodingRuntime(join(home, ".config", "proagentstore", "repos"));
		const clone = vi.spyOn(liveCloneDeps, "clone").mockRejectedValueOnce(new Error("fixture auth refused")).mockResolvedValueOnce(undefined);
		const workDir = join(home, "Retry");
		const first = runtime.startClone({ workDir, slug: "acme/chinese", protocol: "https" });
		await vi.waitFor(() => expect(first.state).toBe("failed"));
		expect(existsSync(workDir)).toBe(true);
		const spelling = existsSync(join(home, "retry")) ? join(home, "retry") : workDir;
		const second = runtime.startClone({ workDir: spelling, slug: "acme/chinese", protocol: "https" });
		expect(second).not.toBe(first);
		await vi.waitFor(() => expect(runtime.cloneStatus({ workDir })).toMatchObject({ state: "done" }));
		expect(runtime.cloneStatus({ workDir: spelling })).toBe(second);
		expect(clone).toHaveBeenCalledTimes(2);
	});
});
