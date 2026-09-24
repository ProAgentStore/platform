import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CodingRuntime } from "./runtime.js";
import { authenticatedCloneUrl, ensureRepo } from "./repo.js";
import { defaultStatePath, HeadlessSession } from "./headless.js";

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

describe("authenticatedCloneUrl — the credential the runner puts in a clone URL (#221)", () => {
	it("defaults to x-access-token, so a cloud that sends only a token behaves as before", () => {
		expect(authenticatedCloneUrl("https://github.com/o/r.git", "ghs_live")).toBe("https://x-access-token:ghs_live@github.com/o/r.git");
	});

	it("uses the provider's own username when the cloud names one", () => {
		// The username half is not decoration: GitLab wants `oauth2` and Bitbucket
		// `x-token-auth`. The same token under the wrong username is a 401.
		expect(authenticatedCloneUrl("https://gitlab.com/g/p.git", "glpat-abc", "oauth2")).toBe("https://oauth2:glpat-abc@gitlab.com/g/p.git");
	});

	it("leaves the URL alone with no token, and on ssh", () => {
		expect(authenticatedCloneUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
		// git ignores userinfo on ssh, so injecting there is exposure with no effect.
		expect(authenticatedCloneUrl("git@gitlab.com:g/p.git", "glpat-abc", "oauth2")).toBe("git@gitlab.com:g/p.git");
	});

	it("percent-encodes both halves, so a secret cannot re-point the URL at another host", () => {
		// A `@` in the token would otherwise end the userinfo early and make `evil.example` the
		// host — sending the credential somewhere else entirely.
		expect(authenticatedCloneUrl("https://gitlab.com/g/p.git", "tok@evil.example/x", "oauth2")).toBe(
			"https://oauth2:tok%40evil.example%2Fx@gitlab.com/g/p.git",
		);
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

	it("clones into an EMPTY existing dir (no .git)", () => {
		const src = makeSrc();
		const dir = join(base, "repo2");
		mkdirSync(dir, { recursive: true }); // exists but empty — safe to clone into
		ensureRepo(dir, { cloneUrl: src });
		expect(existsSync(join(dir, ".git"))).toBe(true);
		expect(existsSync(join(dir, "f.txt"))).toBe(true);
		rmSync(src, { recursive: true, force: true });
	});

	it("REFUSES to clobber a NON-EMPTY non-git dir (data-loss guard)", () => {
		const src = makeSrc();
		const dir = join(base, "repo3");
		mkdirSync(dir, { recursive: true });
		execFileSync("bash", ["-c", "echo important > mydata.txt"], { cwd: dir });
		// A real user directory passed as workDir must never be recursively deleted.
		expect(() => ensureRepo(dir, { cloneUrl: src })).toThrow(/non-empty/i);
		expect(existsSync(join(dir, "mydata.txt"))).toBe(true); // preserved
		expect(existsSync(join(dir, ".git"))).toBe(false);
		rmSync(src, { recursive: true, force: true });
	});

	// ── An owner-configured path (#828): an unpinned instance on a machine that never cloned it ──
	it("clones into the owner's EMPTY folder, with full history and no token left in origin", () => {
		const src = makeSrc();
		const dir = join(base, "own-empty");
		mkdirSync(dir, { recursive: true });
		ensureRepo(dir, { cloneUrl: src, ownFolder: true });
		expect(existsSync(join(dir, "f.txt"))).toBe(true);
		expect(execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: dir, encoding: "utf-8" }).trim()).toBe("false");
		expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf-8" }).trim()).toBe(src);
		rmSync(src, { recursive: true, force: true });
	});

	it("clones into the owner's path when it does not exist at all, parents included", () => {
		const src = makeSrc();
		const dir = join(base, "own-missing", "stores", "platform");
		ensureRepo(dir, { cloneUrl: src, ownFolder: true });
		expect(existsSync(join(dir, ".git"))).toBe(true);
		rmSync(src, { recursive: true, force: true });
	});

	it("leaves an existing (even behind) checkout alone — reconciling it is the repair run's job", () => {
		const src = makeSrc();
		const dir = join(base, "own-behind");
		ensureRepo(dir, { cloneUrl: src, ownFolder: true });
		execFileSync("bash", ["-c", "echo more > g.txt && git add -A && git commit -q -m y"], { cwd: src });
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
		ensureRepo(dir, { cloneUrl: src, ownFolder: true });
		expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" })).toBe(head);
		expect(existsSync(join(dir, "g.txt"))).toBe(false);
		rmSync(src, { recursive: true, force: true });
	});

	it("runs in the owner's non-empty plain folder untouched, rather than refusing or cloning over it", () => {
		const src = makeSrc();
		const dir = join(base, "own-plain");
		mkdirSync(dir, { recursive: true });
		execFileSync("bash", ["-c", "echo mine > notes.txt"], { cwd: dir });
		expect(ensureRepo(dir, { cloneUrl: src, ownFolder: true })).toBe(dir);
		expect(existsSync(join(dir, ".git"))).toBe(false);
		expect(existsSync(join(dir, "notes.txt"))).toBe(true);
		rmSync(src, { recursive: true, force: true });
	});

	it("refuses to clone a second repository into an empty folder inside another checkout", () => {
		const src = makeSrc();
		const dir = join(src, "apps", "empty");
		mkdirSync(dir, { recursive: true });
		expect(() => ensureRepo(dir, { cloneUrl: src, ownFolder: true })).toThrow(/inside another git checkout/);
		rmSync(src, { recursive: true, force: true });
	});

	it("a failed clone says what failed, and never echoes the token", () => {
		const dir = join(base, "own-fail");
		let msg = "";
		try {
			ensureRepo(dir, { cloneUrl: join(base, "no-such-remote"), token: "sekrit-token", ownFolder: true });
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toMatch(/^Could not clone .*no-such-remote into ".*own-fail":/);
		expect(msg).not.toContain("sekrit-token");
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
		// Wait for runState to settle — result event may arrive after pane content
		await until(() => rt.snapshot("s1").runState === "idle");
		const snap = rt.snapshot("s1");
		expect(snap.pane).toContain("REPLY:do-the-thing");
		expect(snap.runState).toBe("idle");
	});

	it("carries the action's author through to the engine, and narrows an invented one (#505)", async () => {
		// `/coding/act` is a published HTTP surface any caller can POST to. The author has to reach
		// `HeadlessSession.input` for the fix to exist at all, and an unrecognised value has to
		// reach it as "unstated" rather than becoming a label the platform cannot stand behind.
		rt = new CodingRuntime(join(dir, "base"));
		rt.start({ sessionId: "auth-pass", repoId: "r1", workDir: dir, clientType: "claude", bin });
		rt.act("auth-pass", { kind: "message", text: "one", author: "pilot" });
		await until(() => rt.snapshot("auth-pass").pane.includes("REPLY:"));
		expect(rt.snapshot("auth-pass").pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] \(pilot\) one/);

		rt.start({ sessionId: "auth-bogus", repoId: "r1", workDir: dir, clientType: "claude", bin });
		// `"the project owner"` is exactly the string this defect would invent for itself.
		rt.act("auth-bogus", { kind: "message", text: "two", author: "the project owner" } as never);
		await until(() => rt.snapshot("auth-bogus").pane.includes("REPLY:"));
		expect(rt.snapshot("auth-bogus").pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] two/);
		expect(rt.snapshot("auth-bogus").pane).not.toContain("[pags]");
	});

	it("reports a resting ONE-SHOT session as alive — this is the shape the Pilot reads", () => {
		// `runCodingLoop` fails the whole goal on `!snap.alive`, and this snapshot is what it
		// gets. A one-shot engine has no process until a turn arrives, so before the fix every
		// delegated goal on codex/grok/gemini reported "coding session is not running" at
		// iteration 0 — against a session that was fine.
		rt = new CodingRuntime(join(dir, "base"));
		const snap = rt.start({ sessionId: "one-shot", repoId: "r1", workDir: dir, clientType: "codex", bin });
		expect(snap.alive).toBe(true);
		expect(snap.runState).toBe("idle");
		expect(snap.ready).toBe(true);
		expect(snap.engineMode).toBe("structured");
		expect(snap.engineModeWarning).toBeNull();
		rt.end("one-shot");
	});

	it("reports a raw fallback mode for a structured-capable engine by name (#731)", () => {
		rt = new CodingRuntime(join(dir, "base"));
		const snap = rt.start({ sessionId: "codex-raw", repoId: "r1", workDir: dir, clientType: "codex", command: "codex", bin });
		expect(snap.engineMode).toBe("raw");
		expect(snap.engineModeWarning).toBeNull();
		const diag = rt.diagnostics().find((s) => s.sessionId === "codex-raw");
		expect(diag?.engineMode).toBe("raw");
		expect(diag?.engineModeWarning).toBeNull();
		rt.end("codex-raw");
	});

	it("reports back whether the engine came up with a conversation to continue (#408)", async () => {
		// The cloud cannot know this. It nominates a predecessor; only the machine holding
		// `~/.claude` and the resume store can say whether one was found — and a runner published
		// before #408 answers with no `resumed` key at all, which the cloud must read as "clean".
		// Announcing the cloud's INTENT instead would tell most of the fleet the opposite of what
		// happened.
		rt = new CodingRuntime(join(dir, "resume-base"));
		const cold = rt.start({ sessionId: "prev", repoId: "r1", workDir: dir, clientType: "claude", bin });
		expect(cold.resumed).toBe(false);
		await until(() => rt.snapshot("prev").pane !== "" || true);
		await until(() => rt.list().some((s) => s.sessionId === "prev"));
		// Let the fake engine's init event land, which is what persists the resume key. Waited on
		// rather than slept for: a fixed 300ms lost the race whenever spawning the engine was slow
		// (a loaded machine), and the warm start below then correctly found nothing to resume.
		const statePath = defaultStatePath(join(dir, "resume-base"));
		await until(() => existsSync(statePath) && "prev" in JSON.parse(readFileSync(statePath, "utf8")), 15_000);
		rt.end("prev");

		expect(rt.start({ sessionId: "next-cold", repoId: "r1", workDir: dir, clientType: "claude", bin }).resumed).toBe(false);
		expect(rt.start({ sessionId: "next-warm", repoId: "r1", workDir: dir, clientType: "claude", bin, resumeFrom: "prev" }).resumed).toBe(true);
	}, 25_000);

	it("refuses a keystroke instead of answering it with an unchanged pane (#448)", () => {
		// The old shape: `act` called `key()`, which pushed a transcript line and returned void,
		// and `act` handed back an ordinary snapshot. A caller reading `{status, pane}` had no
		// reason to parse the line, so "never sent" was indistinguishable from "sent, nothing
		// happened" — that cost a 40-decision BYOK run before `press_keys` was withdrawn from the
		// brain. The refusal is a 400 because with no PTY this is a bad request, not a fault.
		rt = new CodingRuntime(join(dir, "base"));
		rt.start({ sessionId: "keys-1", repoId: "r1", workDir: dir, clientType: "claude", bin });
		expect(() => rt.act("keys-1", { kind: "keys", keys: "Enter" })).toThrow(/not deliverable/i);
		try {
			rt.act("keys-1", { kind: "keys", keys: "Enter" });
		} catch (e) {
			expect((e as { status?: number }).status).toBe(400);
			expect((e as Error).message).toMatch(/no terminal attached/i);
		}
		// #391 still holds: the attempt is RECORDED as well as refused, so the transcript the
		// console and the brain read shows a keystroke was tried and dropped.
		expect(rt.snapshot("keys-1").pane).toMatch(/ignored keypress/i);
		rt.end("keys-1");
	});

	it("lists sessions and ends them", () => {
		rt = new CodingRuntime(join(dir, "base"));
		rt.start({ sessionId: "s2", repoId: "r1", workDir: dir, clientType: "claude", bin });
		expect(rt.list().some((s) => s.sessionId === "s2")).toBe(true);
		rt.end("s2");
		expect(rt.list().some((s) => s.sessionId === "s2")).toBe(false);
	});

	it("ending a session reports what its engine authenticated with (#554)", () => {
		// The closing drain is the ONLY `recordEngineUsage` site the cloud cannot supply this for
		// itself: the credential is decided by a merge with THIS machine's shell, so the runner is
		// the only party that knows. Without the field every session's last turns — the ones the
		// end drain exists to catch — reached the ledger with `payer` NULL.
		rt = new CodingRuntime(join(dir, "base"));
		rt.start({ sessionId: "auth-end", repoId: "r1", workDir: dir, clientType: "claude", bin, env: { ANTHROPIC_API_KEY: "sk-test" } });
		const ended = rt.end("auth-end");
		expect(ended.authResolved).toBe("api-key");
	});

	it("ending a session it has never heard of answers null, not a guess and not a missing key", () => {
		// `end()` tolerates an unknown id, and the honest answer for a session this runner does not
		// hold is that it cannot say. `null` and an ABSENT key both reach the cloud as unknown, but
		// only the explicit null says the runner was asked and answered — which is what
		// distinguishes this runner from one published before #554.
		rt = new CodingRuntime(join(dir, "base"));
		const ended = rt.end("never-existed");
		expect("authResolved" in ended).toBe(true);
		expect(ended.authResolved).toBeNull();
		expect(ended.usage).toEqual([]);
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

// ── #247: nothing on the coding path may look like a tmux target ─────────────
describe("engine label", () => {
	// The bug this closes: the label was `pags-<client>-<id>` and was reported to the console
	// as `tmuxSession`, so the obvious move — `tmux attach -t pags-claude-…` — returned
	// "session not found" and users concluded their engine was broken. It never addressed
	// anything; the engine is a child process.
	it("does not use the pags- prefix that invited tmux attach", () => {
		const s = new HeadlessSession({ id: "csess_abc", clientType: "claude", workDir: "/tmp", command: "claude" } as never);
		expect(s.engineLabel).not.toMatch(/^pags-/);
		expect(s.engineLabel).toBe("claude:csess_abc");
	});
});

// ── #291: a throw on the teardown path is what MAKES a process leak (#274 lineage) ──
describe("closeAll isolates a failing session", () => {
	// The bug this closes: `closeAll` was `for (const s of …) s.stop()`. `stop()` kills a child
	// process, and killing an already-dead or wedged one throws — which aborted the loop, so every
	// LATER session's engine kept running and `sessions.clear()` never ran. `LocalRunner.close()`
	// wrapped the call in `catch {}`, so the runner reported a clean shutdown while orphaned CLI
	// processes kept editing the user's repo with nothing left holding their ids.
	function runtimeWith(sessions: Array<{ id: string; stop: () => void }>) {
		const rt = new CodingRuntime("/tmp/does-not-matter");
		const map = (rt as unknown as { sessions: Map<string, unknown> }).sessions;
		for (const s of sessions) map.set(s.id, s);
		return rt;
	}

	it("stops EVERY session even when an earlier one throws", () => {
		const stopped: string[] = [];
		const rt = runtimeWith([
			{
				id: "a",
				stop: () => {
					stopped.push("a");
				},
			},
			{
				id: "b",
				stop: () => {
					stopped.push("b");
					throw new Error("process already dead");
				},
			},
			{
				id: "c",
				stop: () => {
					stopped.push("c");
				},
			},
		]);

		expect(() => rt.closeAll()).toThrow(/failed to stop/);
		// "c" is the regression: before the fix the throw from "b" skipped it entirely.
		expect(stopped).toEqual(["a", "b", "c"]);
	});

	it("clears its session map even when a stop throws, so a leaked engine is not also unreachable", () => {
		const rt = runtimeWith([
			{
				id: "b",
				stop: () => {
					throw new Error("boom");
				},
			},
		]);
		expect(() => rt.closeAll()).toThrow();
		expect(rt.hasLiveSessions()).toBe(false);
	});

	it("stays silent when every session stops cleanly", () => {
		const rt = runtimeWith([{ id: "a", stop: () => {} }]);
		expect(() => rt.closeAll()).not.toThrow();
	});
});
