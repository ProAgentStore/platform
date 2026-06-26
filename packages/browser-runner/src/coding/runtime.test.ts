import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CodingRuntime } from "./runtime.js";
import { ensureRepo } from "./tmux.js";

// A fake `claude` that speaks stream-json: init on start, then for each user turn
// echoes a result. Lets us drive the runtime without a real Claude install.
const FAKE_CLAUDE = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-rt" }) + "\\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== "user") return;
  const text = (m.message?.content || []).map((b) => b.text).join(" ");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "REPLY:" + text }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "REPLY:" + text }) + "\\n");
});
`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!cond() && Date.now() - start < timeoutMs) await wait(30);
}

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}
const describeGit = gitAvailable() ? describe : describe.skip;

describe("CodingRuntime capabilities", () => {
	it("advertises the structured coding engine + task types", () => {
		expect(CodingRuntime.capabilities()).toContain("coding.sessions");
		expect(CodingRuntime.capabilities()).toContain("coding.stream");
		expect(CodingRuntime.taskTypes()).toContain("coding.session");
	});

	it("throws for an unknown session", () => {
		const rt = new CodingRuntime();
		expect(() => rt.snapshot("nope")).toThrow(/No coding session/);
	});
});

describeGit("ensureRepo", () => {
	let base: string;
	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "pags-ensure-"));
	});
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
		expect(existsSync(join(dir, "junk.txt"))).toBe(false);
		rmSync(src, { recursive: true, force: true });
	});
});

describe("CodingRuntime over the stream-json engine", () => {
	let dir: string;
	let bin: string;
	let rt: CodingRuntime;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-coding-rt-"));
		bin = join(dir, "fake-claude.js");
		writeFileSync(bin, FAKE_CLAUDE);
		chmodSync(bin, 0o755);
	});
	afterEach(() => rt?.closeAll());
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("start → act(message) → capture reflects the agent's real reply", async () => {
		rt = new CodingRuntime(join(dir, "base"));
		const first = rt.start({ sessionId: "s1", repoId: "r1", workDir: dir, clientType: "claude", bin });
		expect(first.alive).toBe(true);

		rt.act("s1", { kind: "message", text: "do-the-thing" });
		await until(() => rt.snapshot("s1").pane.includes("REPLY:do-the-thing"));
		const snap = rt.snapshot("s1");
		expect(snap.pane).toContain("REPLY:do-the-thing");
		expect(snap.runState).toBe("idle"); // result event → real idle
	});

	it("lists sessions and ends them", () => {
		rt = new CodingRuntime(join(dir, "base"));
		rt.start({ sessionId: "s2", repoId: "r1", workDir: dir, clientType: "claude", bin });
		expect(rt.list().some((s) => s.sessionId === "s2")).toBe(true);
		rt.end("s2");
		expect(rt.list().some((s) => s.sessionId === "s2")).toBe(false);
	});

	it("takeover forwards human input to the agent", async () => {
		rt = new CodingRuntime(join(dir, "base"));
		rt.start({ sessionId: "s3", repoId: "r1", workDir: dir, clientType: "claude", bin });
		rt.beginTakeover("s3");
		expect(rt.isUnderTakeover("s3")).toBe(true);
		rt.takeoverInput("s3", { text: "human-says-hi" });
		await until(() => rt.snapshot("s3").pane.includes("REPLY:human-says-hi"));
		expect(rt.snapshot("s3").pane).toContain("REPLY:human-says-hi");
		rt.endTakeover("s3");
		expect(rt.isUnderTakeover("s3")).toBe(false);
	});
});
