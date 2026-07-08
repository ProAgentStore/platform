import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClaudeArgs, defaultStatePath, HeadlessSession, parseCommand } from "./headless.js";

/**
 * A stand-in for `claude -p --input-format stream-json --output-format stream-json`:
 * emits an init event, then for each user turn on stdin replies with an assistant
 * text block + a result event (the turn boundary the engine keys "idle" off).
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc-123" }) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const text = (msg.message?.content || []).map((b) => b.text).join(" ");
  // A tool use + result, then the assistant's reply, then the turn result.
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git pull" } }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Already up to date." }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: " + text }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done: " + text }) + "\\n");
});
`;

/** A raw (non-Claude) CLI: echoes coloured (ANSI) lines for each stdin line, with a
 *  short delay before the second line, then goes quiet. */
const FAKE_CODEX = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  process.stdout.write("\\x1b[32mthinking about: " + line + "\\x1b[0m\\n");
  setTimeout(() => process.stdout.write("done: " + line + "\\n"), 150);
});
`;

/** A raw CLI whose FIRST output is slow (1.8s) — to prove we don't flip idle early. */
const FAKE_SLOW = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => { setTimeout(() => process.stdout.write("late: " + line + "\\n"), 1800); });
`;

/** A raw CLI that emits, PAUSES > 1.5s (e.g. a compile/test run), then resumes — to prove
 *  the settle heuristic doesn't LATCH idle: resumed output must restore "thinking". */
const FAKE_PAUSER = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  process.stdout.write("part 1: " + line + "\\n");
  setTimeout(() => process.stdout.write("part 2: " + line + "\\n"), 2000);
});
`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (!cond() && Date.now() - start < timeoutMs) await wait(25);
}

describe("HeadlessSession (stream-json engine)", () => {
	let dir: string;
	let bin: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-headless-"));
		bin = join(dir, "fake-claude.js");
		writeFileSync(bin, FAKE_CLAUDE);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("drives a turn via stdin/stdout JSON: thinking → real reply → idle", async () => {
		const statePath = defaultStatePath(dir);
		const s = new HeadlessSession({ id: "sess1", workDir: dir, clientType: "claude", bin, statePath });
		s.start();
		expect(s.alive).toBe(true);
		await until(() => s.snapshot().includes("sess-abc-123") || s.runState() === "idle");
		expect(s.runState()).toBe("idle");

		s.input("pull latest");
		expect(s.runState()).toBe("thinking"); // set synchronously on send

		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: pull latest"));
		const pane = s.snapshot();
		expect(pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] pull latest/); // your turn, echoed + timestamped
		expect(pane).toContain("⚙ Bash"); // tool use is surfaced
		expect(pane).toContain("Already up to date."); // tool result is surfaced
		expect(pane).toContain("Done: pull latest"); // Claude's REAL reply, not a scrape
		expect(s.runState()).toBe("idle"); // result event → idle is a fact

		s.stop();
		expect(s.alive).toBe(false);
	});

	it("does not crash when the binary is missing — surfaces the error instead", async () => {
		const s = new HeadlessSession({ id: "sx", workDir: dir, clientType: "claude", bin: join(dir, "no-such-binary-xyz") });
		// MUST NOT throw / emit an uncaught 'error' that would kill the runner.
		expect(() => s.start()).not.toThrow();
		s.input("hello"); // writing to a dead process must be safe too
		await until(() => !s.alive && s.snapshot().includes("cannot run"));
		expect(s.alive).toBe(false);
		expect(s.snapshot()).toContain("cannot run");
		expect(s.runState()).toBe("idle");
	});

	it("persists Claude's session id for --resume across runner restarts", async () => {
		const statePath = defaultStatePath(dir);
		const s = new HeadlessSession({ id: "sess2", workDir: dir, clientType: "claude", bin, statePath });
		s.start();
		await until(() => readState(statePath, "sess2") === "sess-abc-123");
		expect(readState(statePath, "sess2")).toBe("sess-abc-123");
		s.stop();

		// A fresh instance (runner restarted) reads the stored id, so start() resumes.
		const revived = new HeadlessSession({ id: "sess2", workDir: dir, clientType: "claude", bin, statePath });
		expect(revived.snapshot()).toBe(""); // no live process yet, but it knows the id
		// (resume is exercised by start(); we assert the persistence contract here.)
	});
});

describe("HeadlessSession (raw engine — Codex/Grok/custom)", () => {
	let dir: string;
	let codexBin: string;
	let slowBin: string;
	let pauserBin: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-raw-"));
		codexBin = join(dir, "fake-codex.js");
		slowBin = join(dir, "fake-slow.js");
		pauserBin = join(dir, "fake-pauser.js");
		writeFileSync(codexBin, FAKE_CODEX);
		writeFileSync(slowBin, FAKE_SLOW);
		writeFileSync(pauserBin, FAKE_PAUSER);
		chmodSync(codexBin, 0o755);
		chmodSync(slowBin, 0o755);
		chmodSync(pauserBin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("captures raw stdout (ANSI-stripped) into the transcript and settles to idle", async () => {
		const s = new HeadlessSession({ id: "raw1", workDir: dir, clientType: "codex", bin: codexBin });
		s.start();
		expect(s.alive).toBe(true);
		s.input("hi");
		expect(s.runState()).toBe("thinking"); // set synchronously on send

		await until(() => s.snapshot().includes("done: hi"));
		const pane = s.snapshot();
		expect(pane).toContain("thinking about: hi"); // raw line captured
		expect(pane).not.toContain("\x1b["); // ANSI escapes stripped
		expect(pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] hi/); // your turn, echoed

		await until(() => s.runState() === "idle", 3000); // quiet for 1.5s → idle
		expect(s.runState()).toBe("idle");
		s.stop();
	});

	it("a slow first token does NOT flip to idle mid-turn", async () => {
		const s = new HeadlessSession({ id: "raw2", workDir: dir, clientType: "codex", bin: slowBin });
		s.start();
		s.input("go");
		await wait(1000); // 1s in, no output yet — old heuristic would have flipped idle at 1.5s of silence
		expect(s.runState()).toBe("thinking");
		await until(() => s.snapshot().includes("late: go"), 3000);
		s.stop();
	});

	it("does NOT latch idle: resumed output after a >1.5s pause restores thinking", async () => {
		const s = new HeadlessSession({ id: "raw-pause", workDir: dir, clientType: "codex", bin: pauserBin });
		s.start();
		s.input("build");
		// First chunk lands, then a >1.5s pause → the settle heuristic reads idle...
		await until(() => s.snapshot().includes("part 1: build"), 3000);
		await until(() => s.runState() === "idle", 3000);
		expect(s.runState()).toBe("idle");
		// ...but when the turn RESUMES (part 2), state must return to thinking, not stay
		// latched idle (the bug that made the brain act on a half-finished turn).
		await until(() => s.snapshot().includes("part 2: build"), 3000);
		expect(s.runState()).toBe("thinking");
		// And it settles to idle again once truly quiet.
		await until(() => s.runState() === "idle", 3000);
		expect(s.runState()).toBe("idle");
		s.stop();
	});

	it("with NO command/bin, a non-Claude engine spawns ITS OWN binary (not `claude`)", async () => {
		// Regression: the constructor fell back to a hard-coded "claude" when no command was
		// configured, so a codex/grok session was silently driven by the wrong CLI. Whether
		// codex is installed (→ "[codex] …" output / exit) or not (→ "cannot run `codex`"),
		// the transcript must reference codex and NEVER claude.
		const s = new HeadlessSession({ id: "raw-default", workDir: dir, clientType: "codex" });
		expect(() => s.start()).not.toThrow();
		await until(() => s.snapshot().toLowerCase().includes("codex"), 4000);
		const snap = s.snapshot().toLowerCase();
		expect(snap).toContain("codex");
		expect(snap).not.toContain("claude");
		s.stop();
	});
});

describe("parseCommand", () => {
	it("splits bin + args, respecting quotes", () => {
		expect(parseCommand("claude --dangerously-skip-permissions")).toEqual({ bin: "claude", args: ["--dangerously-skip-permissions"] });
		expect(parseCommand('claude --append-system-prompt "be terse please"')).toEqual({ bin: "claude", args: ["--append-system-prompt", "be terse please"] });
		expect(parseCommand("")).toEqual({ bin: "", args: [] });
		expect(parseCommand(undefined)).toEqual({ bin: "", args: [] });
	});
});

describe("buildClaudeArgs", () => {
	it("always includes the structural stream-json flags + skip-permissions", () => {
		expect(buildClaudeArgs([], null)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
	});
	it("merges user extras (e.g. --model) without duplicating our flags", () => {
		const a = buildClaudeArgs(["--model", "sonnet", "--dangerously-skip-permissions"], null);
		expect(a).toContain("--model");
		expect(a).toContain("sonnet");
		expect(a.filter((x) => x === "--dangerously-skip-permissions").length).toBe(1);
		expect(a.filter((x) => x === "--verbose").length).toBe(1);
	});
	it("strips a reserved flag AND its value — no orphan positional", () => {
		const a = buildClaudeArgs(["--output-format", "text", "--model", "x"], null);
		expect(a).not.toContain("text"); // the value didn't leak as a positional/prompt
		expect(a.filter((x) => x === "--output-format").length).toBe(1);
		expect(a[a.indexOf("--output-format") + 1]).toBe("stream-json"); // our value survives
		expect(a).toContain("--model");
		expect(a).toContain("x");
	});
	it("never doubles --resume and uses OUR persisted id", () => {
		const a = buildClaudeArgs(["--resume", "userId"], "ourId");
		expect(a.filter((x) => x === "--resume").length).toBe(1);
		expect(a).toContain("ourId");
		expect(a).not.toContain("userId");
	});
	it("preserves a REPEATED user flag and both its values (no dedup-drop)", () => {
		// Regression: a `!args.includes(a)` dedup dropped the 2nd --add-dir, orphaning /b.
		const a = buildClaudeArgs(["--add-dir", "/a", "--add-dir", "/b"], null);
		expect(a.filter((x) => x === "--add-dir").length).toBe(2);
		// Each --add-dir is immediately followed by its own value (no stray positional).
		const idxs = a.map((x, i) => (x === "--add-dir" ? i : -1)).filter((i) => i >= 0);
		expect(a[idxs[0] + 1]).toBe("/a");
		expect(a[idxs[1] + 1]).toBe("/b");
	});
});

function readState(path: string, id: string): string | null {
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>)[id] ?? null;
	} catch {
		return null;
	}
}
