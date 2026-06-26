import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CodingRuntime } from "./runtime.js";
import { ensureRepo } from "./tmux.js";
import { existsSync, mkdirSync } from "node:fs";

function tmuxAvailable(): boolean {
	try {
		execFileSync("tmux", ["-V"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const describeTmux = tmuxAvailable() ? describe : describe.skip;

describe("CodingRuntime capabilities", () => {
	it("advertises coding capabilities + task types", () => {
		expect(CodingRuntime.capabilities()).toContain("coding.sessions");
		expect(CodingRuntime.taskTypes()).toContain("coding.session");
	});

	it("throws for an unknown session", () => {
		const rt = new CodingRuntime();
		expect(() => rt.snapshot("nope")).toThrow(/No coding session/);
	});
});

describeTmux("ensureRepo", () => {
	let base: string;
	beforeAll(() => { base = mkdtempSync(join(tmpdir(), "pags-ensure-")); });
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	function makeSrc(): string {
		const src = mkdtempSync(join(tmpdir(), "pags-ensure-src-"));
		execFileSync("git", ["init", "-q"], { cwd: src });
		execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: src });
		execFileSync("git", ["config", "user.name", "t"], { cwd: src });
		execFileSync("bash", ["-c", "echo hi > f.txt"], { cwd: src });
		execFileSync("git", ["add", "-A"], { cwd: src });
		execFileSync("git", ["commit", "-q", "-m", "x"], { cwd: src });
		return src;
	}

	it("clones into a fresh dir, and reuses an existing .git checkout without re-cloning", () => {
		const src = makeSrc();
		const dir = join(base, "repo1");
		ensureRepo(dir, { cloneUrl: src });
		expect(existsSync(join(dir, "f.txt"))).toBe(true);
		// Add a local edit, then call again — a real checkout must be reused as-is.
		execFileSync("bash", ["-c", "echo local > untracked.txt"], { cwd: dir });
		ensureRepo(dir, { cloneUrl: src });
		expect(existsSync(join(dir, "untracked.txt"))).toBe(true);
		rmSync(src, { recursive: true, force: true });
	});

	it("re-clones when the dir exists but has no .git (stale/empty)", () => {
		const src = makeSrc();
		const dir = join(base, "repo2");
		mkdirSync(dir, { recursive: true });
		execFileSync("bash", ["-c", "echo junk > junk.txt"], { cwd: dir });
		ensureRepo(dir, { cloneUrl: src });
		expect(existsSync(join(dir, ".git"))).toBe(true);
		expect(existsSync(join(dir, "f.txt"))).toBe(true);
		expect(existsSync(join(dir, "junk.txt"))).toBe(false); // stale content cleared
		rmSync(src, { recursive: true, force: true });
	});
});

describeTmux("CodingRuntime brain-driven loop against a real shell", () => {
	let workDir: string;
	let rt: CodingRuntime;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "pags-coding-rt-"));
	});
	afterEach(() => rt?.closeAll());
	afterAll(() => rmSync(workDir, { recursive: true, force: true }));

	function startGeneric(sessionId: string) {
		rt = new CodingRuntime();
		return rt.start({ sessionId, repoId: "r1", workDir, clientType: "generic" });
	}

	it("start → act(message) → capture reflects the command output", async () => {
		const first = startGeneric("s1");
		expect(first.alive).toBe(true);

		rt.act("s1", { kind: "message", text: "echo brain-drove-this" });
		// Poll capture until the shell is idle and output landed.
		let snap = rt.snapshot("s1");
		for (let i = 0; i < 20 && !snap.pane.includes("brain-drove-this"); i++) {
			await new Promise((r) => setTimeout(r, 150));
			snap = rt.snapshot("s1");
		}
		expect(snap.pane).toContain("brain-drove-this");
	}, 15_000);

	it("lists sessions and ends them", () => {
		startGeneric("s2");
		expect(rt.list().some((s) => s.sessionId === "s2")).toBe(true);
		rt.end("s2");
		expect(rt.list().some((s) => s.sessionId === "s2")).toBe(false);
	});

	it("clones a repo on first start and runs the CLI inside it", async () => {
		// Build a tiny source repo with a sentinel file.
		const src = mkdtempSync(join(tmpdir(), "pags-coding-src-"));
		execFileSync("git", ["init", "-q"], { cwd: src });
		execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: src });
		execFileSync("git", ["config", "user.name", "t"], { cwd: src });
		execFileSync("bash", ["-c", "echo SENTINEL_OK > marker.txt"], { cwd: src });
		execFileSync("git", ["add", "-A"], { cwd: src });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: src });

		const reposBase = mkdtempSync(join(tmpdir(), "pags-coding-base-"));
		rt = new CodingRuntime(reposBase);
		// No workDir → runtime derives one under reposBase and clones `src` into it.
		rt.start({ sessionId: "clone1", repoId: "repoA", clientType: "generic", cloneUrl: src });

		const snap = rt.snapshot("clone1");
		expect(snap.alive).toBe(true);

		rt.act("clone1", { kind: "message", text: "cat marker.txt" });
		let out = rt.snapshot("clone1");
		for (let i = 0; i < 20 && !out.pane.includes("SENTINEL_OK"); i++) {
			await new Promise((r) => setTimeout(r, 150));
			out = rt.snapshot("clone1");
		}
		expect(out.pane).toContain("SENTINEL_OK");
		rmSync(src, { recursive: true, force: true });
		rmSync(reposBase, { recursive: true, force: true });
	}, 30_000);

	it("takeover forwards human input", async () => {
		startGeneric("s3");
		rt.beginTakeover("s3");
		expect(rt.isUnderTakeover("s3")).toBe(true);
		rt.takeoverInput("s3", { text: "echo human-typed" });
		let snap = rt.snapshot("s3");
		for (let i = 0; i < 20 && !snap.pane.includes("human-typed"); i++) {
			await new Promise((r) => setTimeout(r, 150));
			snap = rt.snapshot("s3");
		}
		expect(snap.pane).toContain("human-typed");
		rt.endTakeover("s3");
		expect(rt.isUnderTakeover("s3")).toBe(false);
	}, 15_000);
});
