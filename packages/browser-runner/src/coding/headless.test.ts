import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClaudeArgs, defaultStatePath, HeadlessSession, parseCommand } from "./headless.js";
import { RESULT_RENDERED_MAX, toolResultBudget } from "./transcript-lines.js";

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
  // The result event carries the turn's measured spend (#267) — the shape real Claude Code emits.
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "Done: " + text,
    uuid: "turn-" + text.replace(/\\W/g, ""),
    total_cost_usd: 0.25,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
    modelUsage: { "claude-opus-5": { costUSD: 0.25 } },
  }) + "\\n");
});
`;

/** A raw (non-Claude) CLI: echoes coloured (ANSI) lines for each stdin line, with a
 *  short delay before the second line, then goes quiet. */
const FAKE_CODEX = `#!/usr/bin/env node
// One-shot, like \`codex exec "<turn>"\`: the prompt is the final argument, not a stdin line.
const line = process.argv[2] || "";
process.stdout.write("\\x1b[32mthinking about: " + line + "\\x1b[0m\\n");
setTimeout(() => process.stdout.write("done: " + line + "\\n"), 150);
`;

/**
 * A raw CLI that REFUSES the turn: prints its reason and exits 1 (#545).
 *
 * The production shape, verbatim — `codex exec` outside a git work tree prints exactly these two
 * lines and exits 1, and did so three times on the session that filed the issue while the platform
 * reported `alive/ready/idle`.
 */
const FAKE_REFUSER = `#!/usr/bin/env node
process.stdout.write("Reading additional input from stdin...\\n");
process.stderr.write("Not inside a trusted directory and --skip-git-repo-check was not specified.\\n");
setTimeout(() => process.exit(1), 30);
`;

/** A stream-json engine whose turn comes back as an ERROR — Claude's own analogue of exit 1. */
const FAKE_CLAUDE_ERR = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-err-1" }) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "the engine could not complete the turn" }) + "\\n");
});
`;

/** A raw CLI that reports the `gh` its own PATH resolves — to prove the guard reaches the spawn. */
const FAKE_WHICH_GH = `#!/bin/sh
printf 'resolved: %s\\n' "$(command -v gh || echo none)"
`;

/** A raw CLI that prints its own argv — to prove preset flags reach the engine verbatim. */
const FAKE_ARGV = `#!/usr/bin/env node
process.stdout.write("argv: " + JSON.stringify(process.argv.slice(2)) + "\\n");
`;

/** A raw CLI whose FIRST output is slow (1.8s) — to prove we don't flip idle early. */
const FAKE_SLOW = `#!/usr/bin/env node
const line = process.argv[2] || "";
setTimeout(() => process.stdout.write("late: " + line + "\\n"), 1800);
`;

/** A raw CLI that emits, PAUSES > 1.5s (e.g. a compile/test run), then resumes and exits —
 *  to prove a quiet spell inside a turn is not mistaken for the end of it (#391). */
const FAKE_PAUSER = `#!/usr/bin/env node
const line = process.argv[2] || "";
process.stdout.write("part 1: " + line + "\\n");
setTimeout(() => process.stdout.write("part 2: " + line + "\\n"), 2000);
// Linger past the second chunk so "still working" is observable before the process exits.
setTimeout(() => {}, 4000);
`;

/**
 * A stream-json engine that makes two tool calls per turn — one that works, one that fails (#597).
 *
 * The successful call's result text deliberately BEGINS with `✓`, which is what vitest prints and
 * what `toolResult()` collapses to the head of the line. That is the ambiguity the outcome marker
 * has to survive: it says whether the CALL succeeded, not whether its output happens to look
 * cheerful.
 */
const FAKE_CLAUDE_TOOLS = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-tools-1" }) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "✓ src/a.test.ts (3 tests)" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "missing.ts" } }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "File does not exist." }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
});
`;

/** A raw CLI that never finishes — for the enforced turn ceiling. */
const FAKE_WEDGED = `#!/usr/bin/env node
process.stdout.write("wedged: " + (process.argv[2] || "") + "\\n");
setInterval(() => {}, 1000);
`;

/**
 * ~4,000 characters of source, in the shape the Pilot spent twelve rounds trying to read (#700):
 * 92 indented lines, each individually identifiable, so a truncation can be located to the line.
 */
const FIXTURE_FILE_LINES = 92;
function fixtureFile(): string {
	const lines: string[] = [];
	for (let i = 1; i <= FIXTURE_FILE_LINES; i++) {
		lines.push(`  const marker${String(i).padStart(3, "0")} = "${"x".repeat(20)}";`);
	}
	return lines.join("\n");
}

/**
 * A stream-json engine that returns the SAME file two ways (#700).
 *
 * A turn mentioning "quote" is answered in the engine's own assistant TEXT block; any other turn
 * routes the file through a `Read` tool_result, which is what every `cat`/`sed`/`head`/`grep`
 * instruction produces. The file content is byte-identical on both paths, so the only difference
 * the test can observe is what `toolResult()` does to one of them.
 */
const FAKE_CLAUDE_FILE = `#!/usr/bin/env node
const FILE = ${JSON.stringify(fixtureFile())};
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-file-1" }) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const asked = (msg.message?.content || []).map((b) => b.text || "").join(" ");
  if (asked.indexOf("quote") >= 0) {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: FILE }] } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "web/e2e/helpers.ts" } }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: FILE }] } }) + "\\n");
  }
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");
});
`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000, description = "condition"): Promise<void> {
	const start = Date.now();
	while (!cond() && Date.now() - start < timeoutMs) await wait(25);
	if (!cond()) throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
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

	it("tells the engine a Pilot turn is a Pilot turn, and sends the instruction unchanged (#505)", async () => {
		// The naming collision this closes: `role` can only ever be "user" here, so the engine
		// called its driver "the user" and a Pilot reading that back told the owner he had
		// "explicitly chosen" a change he was never asked about. FAKE_CLAUDE echoes what it
		// received, which is how this can observe the wire text at all.
		const s = new HeadlessSession({ id: "author1", workDir: dir, clientType: "claude", bin, statePath: defaultStatePath(dir) });
		s.start();
		await until(() => s.runState() === "idle");

		s.input("bump the version in pubspec.yaml", { author: "pilot" });
		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: "));
		const pane = s.snapshot();

		// The engine RECEIVED the disambiguation…
		expect(pane).toContain("Done: [pags] This turn was written by the Pilot");
		// …and the instruction reached it whole. #505 promises annotate, never rewrite.
		expect(pane).toContain("bump the version in pubspec.yaml");
		// The owner's Terminal view carries a short marker, not the preamble: that pane is the
		// Pilot's own fixed character budget, and 150 characters per turn would evict real output.
		expect(pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] \(pilot\) bump the version in pubspec\.yaml/);
		s.stop();
	});

	it("says nothing about an unauthored turn — silence is not a label (#505)", async () => {
		// The console's manual `/message`, MCP and the Overseer all reach `/coding/act` without
		// declaring an author, so an absent author must leave the bytes exactly as they were.
		const s = new HeadlessSession({ id: "author2", workDir: dir, clientType: "claude", bin, statePath: defaultStatePath(dir) });
		s.start();
		await until(() => s.runState() === "idle");

		s.input("bump the version in pubspec.yaml");
		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: "));
		const pane = s.snapshot();

		expect(pane).toContain("Done: bump the version in pubspec.yaml"); // nothing prepended
		expect(pane).not.toContain("[pags]");
		expect(pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] bump the version in pubspec\.yaml/);
		expect(pane).not.toContain("(pilot)");
		s.stop();
	});

	it("accumulates the engine's own spend per turn, and a drain hands it over exactly once", async () => {
		// The whole point of #267: the Engine's tokens are spent on the user's machine and passed
		// through none of the cloud's three ledger choke points, so unless the `result` event is
		// harvested here the largest cost on the platform is recorded nowhere at all.
		const s = new HeadlessSession({ id: "usage1", workDir: dir, clientType: "claude", bin, statePath: defaultStatePath(dir) });
		s.start();
		await until(() => s.runState() === "idle");

		s.input("first");
		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: first"));
		s.input("second");
		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: second"));

		const drained = s.takeUsage();
		expect(drained).toHaveLength(2);
		expect(drained[0]).toMatchObject({ model: "claude-opus-5", inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40, costUsd: 0.25 });
		// Draining is destructive on purpose: /coding/capture polls every 3s, and re-reporting
		// would either double-count or force the cloud to diff a growing list on every poll.
		expect(s.takeUsage()).toEqual([]);
		s.stop();
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
		expect(revived.resumedConversation).toBe(true);
	});

	it("a NEW session id has nothing to resume — the reap-then-reopen gap #408 closes", async () => {
		// The fact the whole of #408 turns on, pinned so it cannot be assumed away again. The resume
		// store is keyed by OUR coding_sessions id. The reaper ENDS that row, the next open creates
		// a new one, and a new id has no entry — so re-opening a repo started a brand-new Claude
		// conversation while the surface said nothing. It "lost a process, not a memory" only for a
		// runner restart on the SAME row.
		const statePath = defaultStatePath(dir);
		const first = new HeadlessSession({ id: "reaped1", workDir: dir, clientType: "claude", bin, statePath });
		first.start();
		await until(() => readState(statePath, "reaped1") === "sess-abc-123");
		first.stop();

		const successor = new HeadlessSession({ id: "reopened1", workDir: dir, clientType: "claude", bin, statePath });
		expect(successor.resumedConversation).toBe(false);

		// …and with the cloud naming the predecessor, it continues instead.
		const continued = new HeadlessSession({ id: "reopened2", workDir: dir, clientType: "claude", bin, statePath, resumeFrom: "reaped1" });
		expect(continued.resumedConversation).toBe(true);
	});

	it("prefers its OWN key over the nominated predecessor, and ignores an unknown one", async () => {
		// Ordering matters on a re-attach: this session's own conversation is always the better
		// answer, and a `resumeFrom` must never be able to override it. A predecessor that is not in
		// the store (another machine, a wiped state file) is simply absent — never an error, never a
		// half-resume.
		const statePath = defaultStatePath(dir);
		const mine = new HeadlessSession({ id: "own1", workDir: dir, clientType: "claude", bin, statePath });
		mine.start();
		await until(() => readState(statePath, "own1") === "sess-abc-123");
		mine.stop();
		writeFileSync(statePath, JSON.stringify({ own1: "sess-abc-123", other: "sess-other" }));

		expect(new HeadlessSession({ id: "own1", workDir: dir, clientType: "claude", bin, statePath, resumeFrom: "other" }).resumedConversation).toBe(true);
		expect(new HeadlessSession({ id: "cold1", workDir: dir, clientType: "claude", bin, statePath, resumeFrom: "never-seen" }).resumedConversation).toBe(false);
	});

	it("never reports a resumed conversation for a raw engine", () => {
		// `--resume` is a Claude Code flag and `buildClaudeArgs` is only reached in stream-json mode,
		// so a resume key on a codex/grok session is inert. Reporting true would make the cloud tell
		// the user their engine remembers something it structurally cannot.
		const statePath = defaultStatePath(dir);
		writeFileSync(statePath, JSON.stringify({ raw1: "sess-abc-123" }));
		const raw = new HeadlessSession({ id: "raw1", workDir: dir, clientType: "codex", command: "codex", bin, statePath });
		expect(raw.resumedConversation).toBe(false);
	});

	it("leads the FIRST turn with the cloud's brief when it came up cold, and only the first (#693)", async () => {
		// ADR 0005 from the machine's end. The fake engine echoes back whatever text it received, so
		// this reads what the ENGINE actually got rather than what this side intended to send.
		const statePath = defaultStatePath(dir);
		const s = new HeadlessSession({ id: "seeded1", workDir: dir, clientType: "claude", bin, statePath, seed: "BRIEF: we were fixing the health endpoint" });
		expect(s.seededConversation).toBe(true);
		s.input("carry on");
		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: "));
		expect(s.snapshot()).toContain("BRIEF: we were fixing the health endpoint");
		// The brief is background and the instruction is the request, so the instruction is LAST.
		const echoed = s.snapshot();
		expect(echoed.indexOf("BRIEF:")).toBeLessThan(echoed.lastIndexOf("carry on"));

		// Spent, not repeated. Re-sending it every turn is the unbounded context ADR 0005 names as
		// the cost of owning the conversation, and by turn three it would also be contradicting the
		// engine's own memory of the turns since.
		expect(s.seededConversation).toBe(false);
		s.input("and now the other one");
		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: and now"));
		expect(s.snapshot().split("BRIEF:").length - 1).toBe(1);
		s.stop();
	});

	it("drops the brief unread when it resumed its own conversation (#693)", async () => {
		// `--resume` is preferred and stays preferred: it is cheaper and higher fidelity than any
		// reconstruction. Handing a resumed engine a summary of the conversation it is already in
		// would duplicate its context and invite it to re-litigate finished turns — which is why the
		// cloud sends the brief unconditionally and this side decides, being the only side that
		// knows whether the resume key was actually here.
		const statePath = defaultStatePath(dir);
		const first = new HeadlessSession({ id: "warm1", workDir: dir, clientType: "claude", bin, statePath });
		first.start();
		await until(() => readState(statePath, "warm1") === "sess-abc-123");
		first.stop();

		const s = new HeadlessSession({ id: "warm1", workDir: dir, clientType: "claude", bin, statePath, seed: "BRIEF: should never be sent" });
		expect(s.resumedConversation).toBe(true);
		expect(s.seededConversation).toBe(false);
		s.input("carry on");
		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: "));
		expect(s.snapshot()).not.toContain("BRIEF:");
		s.stop();
	});

	it("reports no brief when the cloud sent none, or sent an empty one", () => {
		// A `pags up` newer than the cloud, and a repo with no record, are the same case: nothing to
		// say. `seeded` must read false so the cloud does not tell a user their engine was briefed.
		const statePath = defaultStatePath(dir);
		expect(new HeadlessSession({ id: "none1", workDir: dir, clientType: "claude", bin, statePath }).seededConversation).toBe(false);
		expect(new HeadlessSession({ id: "none2", workDir: dir, clientType: "claude", bin, statePath, seed: "   " }).seededConversation).toBe(false);
	});
});

/**
 * Why the raw cases below pass `command: "codex"` alongside a fake `bin`.
 *
 * `bin` swaps the BINARY only; the ARGS still come from the command, and a session with no
 * command falls back to the engine's default preset — which is `codex exec --sandbox
 * danger-full-access`, real flags a stand-in script does not understand (its turn text would
 * arrive as argv[5]). Saying `command: "codex"` is the test declaring "a bare prefix, so the turn
 * text is argv[2]", instead of depending on the default preset happening to have no flags.
 */
describe("HeadlessSession (raw engine — Codex/Grok/custom)", () => {
	let dir: string;
	let codexBin: string;
	let slowBin: string;
	let pauserBin: string;
	let argvBin: string;
	let wedgedBin: string;
	let refuserBin: string;
	let whichGhBin: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-raw-"));
		codexBin = join(dir, "fake-codex.js");
		slowBin = join(dir, "fake-slow.js");
		pauserBin = join(dir, "fake-pauser.js");
		argvBin = join(dir, "fake-argv.js");
		wedgedBin = join(dir, "fake-wedged.js");
		refuserBin = join(dir, "fake-refuser.js");
		whichGhBin = join(dir, "fake-which-gh.sh");
		writeFileSync(codexBin, FAKE_CODEX);
		writeFileSync(slowBin, FAKE_SLOW);
		writeFileSync(pauserBin, FAKE_PAUSER);
		writeFileSync(argvBin, FAKE_ARGV);
		writeFileSync(wedgedBin, FAKE_WEDGED);
		writeFileSync(refuserBin, FAKE_REFUSER);
		writeFileSync(whichGhBin, FAKE_WHICH_GH);
		chmodSync(codexBin, 0o755);
		chmodSync(slowBin, 0o755);
		chmodSync(pauserBin, 0o755);
		chmodSync(argvBin, 0o755);
		chmodSync(wedgedBin, 0o755);
		chmodSync(refuserBin, 0o755);
		chmodSync(whichGhBin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("reports NO usage — an unmeasurable engine must leave a gap, not a zero", async () => {
		// Codex/Grok emit no structured result event, so there is nothing to measure. Recording a
		// zero row would put "Coding engine · $0.00" on the Usage page, which claims the engine was
		// free — a stronger and more misleading statement than the absence it replaces (#267).
		// The absence is structural, not a special case: raw mode never parses JSON at all.
		const s = new HeadlessSession({ id: "rawusage", workDir: dir, clientType: "codex", command: "codex", bin: codexBin });
		s.start();
		s.input("hi");
		await until(() => s.snapshot().includes("done: hi"), 12_000, "raw stdout to include final line");
		expect(s.takeUsage()).toEqual([]);
		s.stop();
	}, 20_000);

	it("a RAW engine is told who wrote the turn too — the one-shot path is not exempt (#505)", async () => {
		// `runOneShot` appends the turn as the final argv element, a completely separate send from
		// the stream-json write. A fix that only covered Claude would leave every Codex/Grok/local
		// engine with the same naming collision, silently.
		const s = new HeadlessSession({ id: "raw-author", workDir: dir, clientType: "codex", command: "codex", bin: codexBin });
		s.start();
		s.input("bump the version in pubspec.yaml", { author: "pilot" });
		await until(() => s.snapshot().includes("done: "), 12_000, "raw one-shot turn to finish");
		const pane = s.snapshot();

		expect(pane).toContain("thinking about: [pags] This turn was written by the Pilot");
		expect(pane).toContain("bump the version in pubspec.yaml");
		expect(pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] \(pilot\) bump the version in pubspec\.yaml/);
		s.stop();
	}, 20_000);

	it("captures raw stdout (ANSI-stripped) into the transcript and settles to idle", async () => {
		const s = new HeadlessSession({ id: "raw1", workDir: dir, clientType: "codex", command: "codex", bin: codexBin });
		s.start();
		// A one-shot engine spawns nothing until a turn arrives — starting it eagerly is what
		// made `codex` die instantly with "stdin is not a terminal". Asserted as "no process ran"
		// (empty transcript, idle) rather than `alive === false`: alive means "can take a turn",
		// and reading it as "a process is executing" is what killed every delegated goal at
		// iteration 0.
		expect(s.snapshot()).toBe("");
		expect(s.runState()).toBe("idle");
		s.input("hi");
		expect(s.runState()).toBe("thinking"); // set synchronously on send

		await until(() => s.snapshot().includes("done: hi"), 12_000, "raw stdout to include final line");
		const pane = s.snapshot();
		expect(pane).toContain("thinking about: hi"); // raw line captured
		expect(pane).not.toContain("\x1b["); // ANSI escapes stripped
		expect(pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] hi/); // your turn, echoed

		await until(() => s.runState() === "idle", 6000, "raw session to settle idle"); // the process exited → idle
		expect(s.runState()).toBe("idle");
		s.stop();
	}, 20_000);

	it("a slow first token does NOT flip to idle mid-turn", async () => {
		const s = new HeadlessSession({ id: "raw2", workDir: dir, clientType: "codex", command: "codex", bin: slowBin });
		s.start();
		s.input("go");
		await wait(1000); // 1s in, no output yet — old heuristic would have flipped idle at 1.5s of silence
		expect(s.runState()).toBe("thinking");
		await until(() => s.snapshot().includes("late: go"), 6000, "slow raw first output");
		s.stop();
	}, 15_000);

	it("a >1.5s output pause is NOT the end of the turn — only the process's exit is (#391)", async () => {
		// The defect this replaces: a one-shot turn was judged idle after 1.5s of quiet, so a build
		// or a test run — which is silent for far longer than that — read as FINISHED. The Pilot
		// sent turn 2, `runOneShot` killed turn 1 to keep two engines off one repo, and the work in
		// flight was destroyed while the brain reasoned about a turn that never completed. A turn is
		// its own process here, so its exit is the exact boundary and no timer may pre-empt it.
		const s = new HeadlessSession({ id: "raw-pause", workDir: dir, clientType: "codex", command: "codex", bin: pauserBin });
		s.start();
		s.input("build");
		await until(() => s.snapshot().includes("part 1: build"), 6000, "first paused raw output");
		// Well past the old 1.5s "settled" rule, and the process is still working.
		await wait(1800);
		expect(s.runState()).toBe("thinking");
		expect(s.ready).toBe(false); // and nothing may be sent into a live turn
		// The turn's later output proves it really was still running.
		await until(() => s.snapshot().includes("part 2: build"), 6000, "second paused raw output");
		expect(s.runState()).toBe("thinking");
		// Idle arrives when — and only when — the process exits.
		await until(() => s.runState() === "idle", 8000, "the engine process to exit");
		expect(s.alive).toBe(true); // a resting one-shot session is not a dead one
		s.stop();
	}, 25_000);

	it("ends a turn whose engine never exits, and says so (#391)", async () => {
		// Exit being authoritative needs a ceiling, or a wedged process reports "thinking" forever
		// and nothing on this path can unstick it. The ceiling ENDS the turn rather than relabelling
		// a live process as idle — relabelling is the original defect, just slower, because the next
		// instruction would then land on a repo another engine is still editing.
		const s = new HeadlessSession({ id: "raw-wedged", workDir: dir, clientType: "codex", command: "codex", bin: wedgedBin, maxTurnMs: 700 });
		s.start();
		s.input("hang");
		await until(() => s.snapshot().includes("wedged: hang"), 6000, "the wedged engine's output");
		expect(s.runState()).toBe("thinking");
		await until(() => s.runState() === "idle", 6000, "the turn ceiling to end the turn");
		expect(s.snapshot()).toMatch(/turn ended after .* the engine never exited/);
		expect(s.alive).toBe(true); // the SESSION survives; only the turn was ended
		s.stop();
	}, 20_000);

	it("is ALIVE between turns — a resting one-shot engine is not a dead session", async () => {
		// The Pilot opens every iteration with
		//   if (!snap.alive) return failed("coding session is not running")
		// and a one-shot engine has no process between turns — that IS its resting state. So
		// every delegated goal on codex/grok/gemini/ollama died at iteration 0 having done
		// nothing, reporting a dead session that was healthy and answering interactive turns.
		// `alive` means "can take a turn"; "is a turn executing" is runState.
		const s = new HeadlessSession({ id: "raw-alive", workDir: dir, clientType: "codex", command: "codex", bin: codexBin });
		s.start();
		expect(s.alive).toBe(true); // before the first turn
		expect(s.runState()).toBe("idle"); // ...and nothing is executing

		s.input("hi");
		await until(() => s.snapshot().includes("done: hi"), 12_000, "the turn to finish");
		await until(() => s.runState() === "idle", 6000, "settle after the turn");
		expect(s.alive).toBe(true); // still alive AFTER the turn's process exited

		s.stop();
		expect(s.alive).toBe(false); // stop() is the only thing that ends it
		s.start();
		expect(s.alive).toBe(true); // ...and a restart brings it back
		s.stop();
	}, 25_000);

	it("spawns the engine with the `gh` guard ahead of the real binary on PATH (#679)", async () => {
		// The wiring assertion. `installGhGuard` is unit-tested on its own; what this pins is that
		// the shim actually reaches the process the Engine runs as — the whole containment is a
		// `PATH` entry, and a `PATH` entry that never gets applied is indistinguishable from a
		// tested feature that does nothing.
		const guardRoot = join(dir, "guard-e2e");
		const fakeGhDir = join(dir, "ghbin");
		mkdirSync(fakeGhDir, { recursive: true });
		writeFileSync(join(fakeGhDir, "gh"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(fakeGhDir, "gh"), 0o755);
		const s = new HeadlessSession({
			id: "gh-guard-e2e", workDir: dir, clientType: "codex", command: "codex", bin: whichGhBin,
			ghScope: ["ProAgentStore/platform"], ghGuardRoot: guardRoot,
			env: { PATH: `${fakeGhDir}:${process.env.PATH ?? ""}` },
		});
		s.start();
		s.input("go");
		await until(() => s.snapshot().includes("resolved: "), 12_000, "the engine to report its gh");
		// It resolved OUR shim, not the fake real one two entries along.
		expect(s.snapshot()).toContain(`resolved: ${guardRoot}`);
		expect(s.ghGuard).toMatchObject({ installed: true, scope: ["proagentstore/platform"] });
		expect(s.ghGuard.gaps.join(" ")).toContain("git push");
		s.stop();
	}, 20_000);

	it("spawns UNGUARDED when the platform named no scope, and says which way it failed (#679)", async () => {
		// An older cloud sends no scope. The guard must fail OPEN: a runner that could not install
		// it still has to run the Engine, and a broken `gh` would be far worse than the gap.
		const guardRoot = join(dir, "guard-e2e-none");
		const s = new HeadlessSession({ id: "gh-guard-none", workDir: dir, clientType: "codex", command: "codex", bin: whichGhBin, ghGuardRoot: guardRoot });
		s.start();
		s.input("go");
		await until(() => s.snapshot().includes("resolved: "), 12_000, "the engine to report its gh");
		expect(s.snapshot()).not.toContain(guardRoot);
		expect(s.ghGuard).toMatchObject({ installed: false, reason: "no-scope" });
		s.stop();
	}, 20_000);

	it("passes EVERY preset param through to the engine, with the turn text last", async () => {
		// "It should launch with any params provided" — the preset command is a prefix and the
		// turn text is appended as the final argument, so `--sandbox danger-full-access`,
		// `--model`, `-c key=value`, a quoted value, anything, reaches the CLI untouched. This is
		// what makes engine posture a CONFIG change rather than a code change; without it, the
		// only fix for `codex exec` running read-only would have been shipping a new default.
		const s = new HeadlessSession({
			id: "raw-argv",
			workDir: dir,
			clientType: "codex",
			bin: argvBin,
			command: 'codex exec --sandbox danger-full-access -c model="o3"',
		});
		s.start();
		s.input("fix the failing test");
		await until(() => s.snapshot().includes("argv:"), 8000, "engine argv echo");
		const argv = JSON.parse(/argv: (\[.*\])/.exec(s.snapshot())?.[1] ?? "[]") as string[];
		expect(argv).toEqual(["exec", "--sandbox", "danger-full-access", "-c", "model=o3", "fix the failing test"]);
		s.stop();
	}, 15_000);

	it("with NO command/bin, a non-Claude engine spawns ITS OWN binary (not `claude`)", async () => {
		// Regression: the constructor fell back to a hard-coded "claude" when no command was
		// configured, so a codex/grok session was silently driven by the wrong CLI. Whether
		// codex is installed (→ "[codex] …" output / exit) or not (→ "cannot run `codex`"),
		// the transcript must reference codex and NEVER claude.
		const s = new HeadlessSession({ id: "raw-default", workDir: dir, clientType: "codex" });
		expect(() => s.start()).not.toThrow();
		// One-shot: the process is spawned by the TURN, so nothing runs until input arrives.
		s.input("hi");
		await until(() => s.snapshot().toLowerCase().includes("codex"), 8000, "default raw engine process output");
		const snap = s.snapshot().toLowerCase();
		expect(snap).toContain("codex");
		expect(snap).not.toContain("claude");
		s.stop();
	}, 15_000);

	// ── #545: a non-zero exit was prose in the pane and nothing else ─────────────────────────
	//
	// Production capture of csess_22d08431, three turns, three `[codex exited with code 1]` lines,
	// reported as `alive: true, ready: true, runState: "idle"`. The exit code was in hand on this
	// side each time and set no field, so nothing downstream could see it.

	it("reports the last turn's FAILURE — while alive/ready/idle stay exactly as they were (#545)", async () => {
		const s = new HeadlessSession({ id: "raw-refuse", workDir: dir, clientType: "codex", command: "codex", bin: refuserBin });
		s.start();
		// Nothing has run: absent, never a verdict. "Not measured" and "fine" must not look alike.
		expect(s.lastTurn).toBeNull();

		s.input("Run `git pull` in the repository at dev/aipa.");
		await until(() => s.lastTurn !== null, 8000, "the refusing turn to exit");

		expect(s.lastTurn).toMatchObject({ verdict: "failed", exitCode: 1, signal: null });
		// The engine's OWN sentence, captured as it was written — not scraped back out of the pane,
		// which is the regex-over-prose guess #391 removed from runState.
		expect(s.lastTurn?.detail).toContain("Not inside a trusted directory");
		expect(s.lastTurn?.at).toBeGreaterThan(0);

		// The production triple, DELIBERATELY unchanged. A failing turn does not make the session
		// unable to take another; conflating outcome with liveness once killed every delegated goal
		// on codex/grok/gemini at iteration 0.
		expect(s.alive).toBe(true);
		expect(s.ready).toBe(true);
		expect(s.runState()).toBe("idle");
		s.stop();
	}, 15_000);

	it("a turn that SUCCEEDS reports ok, and replaces the previous failure (#545)", async () => {
		// The bound the cloud applies is CONSECUTIVE failures, so a session that recovers has to be
		// able to say so. A report that only ever accumulated failures would strand a working
		// session on the strength of one bad turn.
		const s = new HeadlessSession({ id: "raw-recover", workDir: dir, clientType: "codex", command: "codex", bin: refuserBin });
		s.start();
		s.input("refuse this");
		await until(() => s.lastTurn?.verdict === "failed", 8000, "the refusing turn");

		const ok = new HeadlessSession({ id: "raw-recover-2", workDir: dir, clientType: "codex", command: "codex", bin: codexBin });
		ok.start();
		ok.input("hi");
		await until(() => ok.lastTurn !== null, 12_000, "the succeeding turn to exit");
		expect(ok.lastTurn).toMatchObject({ verdict: "ok", exitCode: 0 });
		expect(ok.lastTurn?.detail).toContain("done: hi"); // the engine's last line, whatever it was
		s.stop();
		ok.stop();
	}, 25_000);

	it("a turn WE ended is `killed`, not a failure — the wedge ceiling is not evidence about the engine (#545)", async () => {
		// The ceiling SIGTERMs a process that never exits. That says something about this platform's
		// timers, not about whether the engine can work, so it must not feed the consecutive-failure
		// bound: three slow builds are not a broken CLI.
		const s = new HeadlessSession({ id: "raw-killed", workDir: dir, clientType: "codex", command: "codex", bin: wedgedBin, maxTurnMs: 500 });
		s.start();
		s.input("hang");
		await until(() => s.lastTurn !== null, 8000, "the ceiling to end the wedged turn");
		expect(s.lastTurn?.verdict).toBe("killed");
		expect(s.lastTurn?.signal).not.toBeNull();
		expect(s.alive).toBe(true);
		s.stop();
	}, 15_000);

	it("a turn ABORTED by its successor does not overwrite the successor's report (#545)", async () => {
		// `runOneShot` kills a turn still running when a new instruction arrives, and that dead
		// process's `close` fires LATER — after the replacement's. Recording before the staleness
		// guard would file the loser's outcome as the session's latest, which is a report about a
		// turn nobody is waiting on.
		const s = new HeadlessSession({ id: "raw-abort", workDir: dir, clientType: "codex", command: "codex", bin: pauserBin });
		s.start();
		s.input("slow one");
		await until(() => s.snapshot().includes("part 1: slow one"), 6000, "the first turn to start");
		s.input("second"); // pre-empts the first — the first's close will arrive with a signal
		await until(() => s.snapshot().includes("part 1: second"), 6000, "the second turn to start");
		await until(() => s.lastTurn !== null, 12_000, "the second turn to finish");
		// Whatever the second turn's own verdict is, the report must belong to IT: the aborted
		// first turn produced a SIGTERM close that arrived while the second was still running.
		expect(s.lastTurn?.verdict).toBe("ok");
		s.stop();
	}, 25_000);
});

describe("HeadlessSession — a stream-json turn reports its own error (#545)", () => {
	let dir: string;
	let bin: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-turn-err-"));
		bin = join(dir, "fake-claude-err.js");
		writeFileSync(bin, FAKE_CLAUDE_ERR);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("takes the verdict from the `result` event's is_error, with no exit code to take it from", async () => {
		// The two engine mechanisms know different things, and each must report only what it can:
		// a raw engine's turn IS a process (exit code), Claude's turn ends with a protocol event
		// (`is_error`). Leaving the structured path out would give the field to three engines and
		// silently not to the flagship.
		const s = new HeadlessSession({ id: "sjerr", workDir: dir, clientType: "claude", bin, statePath: defaultStatePath(dir) });
		s.start();
		await until(() => s.runState() === "idle", 8000, "the engine to initialise");
		expect(s.lastTurn).toBeNull();

		s.input("do the thing");
		await until(() => s.lastTurn !== null, 8000, "the errored result event");
		expect(s.lastTurn).toMatchObject({ verdict: "failed", exitCode: null, signal: null });
		expect(s.lastTurn?.detail).toContain("could not complete the turn");
		s.stop();
	}, 15_000);
});

/**
 * What a file's text loses on each of the two routes into the pane (#700).
 *
 * The run this pins spent twelve of sixteen Pilot decisions rephrasing one request — `cat`, then
 * `sed -n '1,100p'`, then `cat -n | head -60`, then "print every character" — because the file
 * never arrived and nothing told it why. Every one of those routes through a tool_result, which the
 * runner cut to 240 characters with `\s+` collapsed to a single space BEFORE the pane existed, so
 * all four produced the same size and the same shape. The search space was empty.
 *
 * These tests measure both routes against the SAME ~4,000-character file, through a REAL spawned
 * engine rather than by calling the renderer directly — the claim being pinned is end-to-end
 * ("a file reaches the Pilot"), and the earlier attribution of this failure to the pane window
 * rather than the runner is what a unit-level check would have missed again.
 */
describe("HeadlessSession — how much of a file reaches the pane (#700)", () => {
	let dir: string;
	let bin: string;
	const file = fixtureFile();

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-file-dump-"));
		bin = join(dir, "fake-claude-file.js");
		writeFileSync(bin, FAKE_CLAUDE_FILE);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("a Read result arrives as LINES, ~1,500 characters of them, and says how much it lost", async () => {
		expect(file.length).toBeGreaterThan(4000);
		const s = new HeadlessSession({ id: "file-tool", workDir: dir, clientType: "claude", bin, statePath: defaultStatePath(dir) });
		s.start();
		await until(() => s.runState() === "idle", 8000, "the engine to initialise");

		s.input("read web/e2e/helpers.ts"); // no "quote" — the engine uses its Read tool
		await until(() => s.snapshot().includes("↳"), 8000, "the tool result line");
		const pane = s.snapshot();
		const lines = pane.split("\n");

		// The framing `engine-tool-calls.ts` parses is intact: the call line, then the arrow line.
		expect(lines.some((l) => l.startsWith("⚙ Read "))).toBe(true);
		const arrow = lines.findIndex((l) => l.startsWith("  ↳"));
		expect(arrow).toBeGreaterThanOrEqual(0);
		expect(lines[arrow].startsWith("  ↳✓ ")).toBe(true);

		// THE fix: the file's own lines are lines again. Before this, not one of them survived as
		// its own line at any length, which is why `cat -n` and `sed -n '1,50p'` were the same
		// request to the Pilot.
		const body = lines.slice(arrow + 1).filter((l) => l.startsWith("  │ "));
		expect(body.length).toBeGreaterThan(30);
		expect(body[0]).toContain("marker002");

		// ~34 of 92 lines rather than ~5, and the cut is disclosed WITH its size — the number that
		// tells the Pilot how narrow a slice would arrive whole.
		expect(pane).toContain("marker010"); // the old 240-char cap stopped short of this
		expect(pane).toContain("marker030");
		expect(pane).not.toContain("marker092");
		expect(pane).toMatch(/…\[cut: 1,500 of 4,0\d\d chars\]/);

		// And it is still bounded: the whole block — content, per-line framing and the disclosure —
		// honours RESULT_RENDERED_MAX, which is under a third of the Pilot's 6,000-character window,
		// so two more results can follow it before anything is evicted.
		const block = [lines[arrow], ...body].join("\n");
		expect(block.length).toBeLessThanOrEqual(RESULT_RENDERED_MAX);
		expect(RESULT_RENDERED_MAX * 3).toBeLessThanOrEqual(6000);
		s.stop();
	}, 15_000);

	it("a status-string tool keeps the old 240, so the widening is paid for only where it buys something", async () => {
		// Same pane, different tool: `FAKE_CLAUDE_TOOLS` answers a `Bash` and a `Read`. The point is
		// the negative one — a per-tool cap means an `Edit`/`TodoWrite` receipt cannot spend the
		// window. Measured here on the budget function's own boundary rather than by spawning a
		// fourth fake engine.
		expect(toolResultBudget("Edit")).toEqual({ chars: 240, lines: 6 });
		expect(toolResultBudget("Read").chars).toBeGreaterThan(240);
	});

	it("the engine's own REPLY text arrives whole — the one channel a file can travel", async () => {
		const s = new HeadlessSession({ id: "file-reply", workDir: dir, clientType: "claude", bin, statePath: defaultStatePath(dir) });
		s.start();
		await until(() => s.runState() === "idle", 8000, "the engine to initialise");

		s.input("quote web/e2e/helpers.ts verbatim in your reply");
		await until(() => s.snapshot().includes("marker092"), 8000, "the engine's quoted reply");
		const pane = s.snapshot();

		// Verbatim, with the newlines intact — `push()` stores the block as ONE transcript entry
		// (timestamp-prefixed) and the only bound above it counts LINES, not characters. The single
		// loss is `block.text.trim()` on the whole block, i.e. the leading indent of the first line
		// and any trailing blank; the 4,000 characters in between are untouched.
		expect(pane).toContain(file.trim());
		expect(file.trim().length).toBeGreaterThan(4000);
		expect(pane.split("\n").filter((l) => l.includes("const marker")).length).toBe(FIXTURE_FILE_LINES);

		// The size that matters is the size the Pilot reads: PILOT_PANE_CHARS is 6,000 and the pane
		// is well inside it, so this file reaches the decision in full rather than as a 240-char head.
		expect(pane.length).toBeLessThan(6000);
		expect(pane.length).toBeGreaterThan(4000);
		s.stop();
	}, 15_000);
});

describe("parseCommand", () => {
	it("splits bin + args, respecting quotes", () => {
		expect(parseCommand("claude --dangerously-skip-permissions")).toEqual({ bin: "claude", args: ["--dangerously-skip-permissions"] });
		expect(parseCommand('claude --append-system-prompt "be terse please"')).toEqual({ bin: "claude", args: ["--append-system-prompt", "be terse please"] });
		expect(parseCommand("")).toEqual({ bin: "", args: [] });
		expect(parseCommand(undefined)).toEqual({ bin: "", args: [] });
	});

	it("strips quotes MID-token, like a shell", () => {
		// `-c model="o3"` used to reach the engine as the literal `model="o3"`, and
		// `--flag="two words"` split at the space, because only a fully-quoted token counted.
		expect(parseCommand('codex exec -c model="o3"')).toEqual({ bin: "codex", args: ["exec", "-c", "model=o3"] });
		expect(parseCommand('claude --append-system-prompt="be terse"')).toEqual({ bin: "claude", args: ["--append-system-prompt=be terse"] });
		expect(parseCommand("grok --agent='my agent'")).toEqual({ bin: "grok", args: ["--agent=my agent"] });
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

describe("HeadlessSession — a finishing turn must not clobber a newer one", () => {
	let dir: string;
	let slowBin: string;
	let fastBin: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-stale-"));
		slowBin = join(dir, "slow.js");
		fastBin = join(dir, "fast.js");
		// Emits immediately, then LINGERS — so it is still "running" when turn 2 starts.
		writeFileSync(slowBin, `#!/usr/bin/env node\nprocess.stdout.write("turn1 start\\n");\nsetTimeout(() => process.stdout.write("turn1 end\\n"), 3000);\n`);
		writeFileSync(fastBin, `#!/usr/bin/env node\nprocess.stdout.write("turn2: " + (process.argv[2]||"") + "\\n");\nsetTimeout(()=>{}, 5000);\n`);
		chmodSync(slowBin, 0o755);
		chmodSync(fastBin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("a stale process's close does not force the session idle mid-turn", async () => {
		// The raw idle heuristic declares idle after a >1.5s output pause, so a long build gets
		// judged idle and the brain sends turn 2 while turn 1 is still running. Without a
		// staleness guard, turn 1's `close` then set `run = "idle"` — so the brain read a turn 2
		// that had barely started as FINISHED and acted on a half-done turn (or double-sent) —
		// and `proc = null`, after which stop()/interrupt()/end() could no longer kill turn 2,
		// leaving an engine process still editing the repo, invisible to diagnostics and
		// kill-tmux. `alive` cannot show this (a one-shot session is alive until stop), so the
		// assertion is on `runState`, which is what the brain actually reads.
		const s = new HeadlessSession({ id: "stale", workDir: dir, clientType: "codex", command: "codex", bin: slowBin });
		s.start();
		s.input("build");
		await until(() => s.snapshot().includes("turn1 start"), 6000, "turn 1 to emit");

		// Turn 2 starts while turn 1 is mid-flight (the exact race). Turn 1 is aborted, and its
		// `close` lands a moment later — it must be IGNORED, because turn 2 owns the session now.
		s.input("next");
		expect(s.runState()).toBe("thinking");
		await wait(600); // long enough for the stale close, far short of the 1.5s idle threshold
		expect(s.runState()).toBe("thinking");
		s.stop();
	}, 20_000);

	it("aborts a still-running turn before spawning its replacement, and RECORDS the abort", async () => {
		// Two engine processes editing the same repo concurrently is worse than a lost turn — and
		// `input()` still accepts a turn at any moment (a human typing, a takeover), so making exit
		// authoritative did not remove the need for this. What it did remove is the excuse for doing
		// it silently: a turn's work vanishing with no line in the transcript is how the Pilot ends
		// up reasoning about a turn that never finished, with nothing to explain the gap (#391).
		const s = new HeadlessSession({ id: "stale2", workDir: dir, clientType: "codex", command: "codex", bin: fastBin });
		s.start();
		s.input("one");
		await until(() => s.snapshot().includes("turn2: one"), 6000, "first turn");
		s.input("two");
		await until(() => s.snapshot().includes("turn2: two"), 6000, "second turn");
		// Both turns are in the transcript, and exactly one process is current.
		expect(s.snapshot()).toContain("turn2: one");
		expect(s.snapshot()).toMatch(/turn aborted — a new instruction arrived/);
		s.stop();
		expect(s.alive).toBe(false);
	}, 20_000);
});

describe("HeadlessSession.key — a no-op that READS as success is worse than an error", () => {
	it("records the ignored keypress in the transcript", () => {
		// `press_keys` was advertised to the brain, mapped to {kind:"keys"}, routed here and
		// answered with a normal snapshot — indistinguishable from success. A menu prompt then
		// looped: press Enter → nothing sent → unchanged pane → same decision → repeat, until the
		// run burned all 40 decisions and ended max_steps having done nothing.
		const s = new HeadlessSession({ id: "keys", workDir: tmpdir(), clientType: "codex", bin: "/bin/echo" });
		s.key("Enter");
		expect(s.snapshot()).toMatch(/ignored keypress/i);
	});

	it("reports the failure to its caller too — a transcript line is not an answer (#448)", () => {
		// Recording it (#391) fixed what the human and the brain READ. It did nothing for the
		// HTTP caller: `runtime.act` had no value to raise, so it returned a normal snapshot and
		// the route answered 200. `key()` now returns the failure, which is what lets the runtime
		// refuse and what a future PTY-backed backend would flip to `delivered:true`.
		const s = new HeadlessSession({ id: "keys2", workDir: tmpdir(), clientType: "codex", bin: "/bin/echo" });
		const result = s.key("Enter");
		expect(result.delivered).toBe(false);
		expect(result.reason).toMatch(/no terminal attached/i);
		expect(s.snapshot()).toMatch(/ignored keypress/i);
	});
});

describe("parseCommand — an apostrophe in ordinary English must survive", () => {
	it("keeps an unbalanced quote inside its token", () => {
		// Presets are user-edited free text. The quote-stripping regex matched `don` and left `t`
		// as a separate argument, so `--append-system-prompt don't guess` reached the engine as
		// three broken args. The old `(\S+)` fallback kept it intact.
		expect(parseCommand("claude --append-system-prompt don't")).toEqual({ bin: "claude", args: ["--append-system-prompt", "don't"] });
		expect(parseCommand("claude it's fine")).toEqual({ bin: "claude", args: ["it's", "fine"] });
	});

	it("still strips BALANCED quotes, including mid-token", () => {
		expect(parseCommand('codex exec -c model="o3"')).toEqual({ bin: "codex", args: ["exec", "-c", "model=o3"] });
		expect(parseCommand('claude --p="two words"')).toEqual({ bin: "claude", args: ["--p=two words"] });
	});
});

describe("HeadlessSession — a one-shot engine that cannot SPAWN is not alive", () => {
	it("reports dead when the binary is missing, so the Pilot stops instead of retrying forever", async () => {
		// `alive = !stopped` made a misconfigured engine indistinguishable from a healthy idle one,
		// so `runCodingLoop`'s `if (!snap.alive)` guard — the thing that catches a bad command —
		// became structurally unreachable for every one-shot engine, and the Pilot burned all 40
		// BYOK decisions re-spawning a binary that isn't there.
		const s = new HeadlessSession({ id: "missing", workDir: tmpdir(), clientType: "codex", bin: join(tmpdir(), "no-such-engine-xyz") });
		s.start();
		expect(s.alive).toBe(true); // nothing has been tried yet
		s.input("hi");
		await until(() => !s.alive, 8000, "the spawn failure to be reported");
		expect(s.alive).toBe(false);
		expect(s.snapshot()).toMatch(/failed to start/i);
	}, 15_000);

	it("a restart clears the failure — it is also a retry of the command", async () => {
		const s = new HeadlessSession({ id: "missing2", workDir: tmpdir(), clientType: "codex", bin: join(tmpdir(), "no-such-engine-xyz") });
		s.start();
		s.input("hi");
		await until(() => !s.alive, 8000, "the spawn failure");
		s.start();
		expect(s.alive).toBe(true);
		s.stop();
	}, 15_000);
});

/**
 * A stand-in that MERGES A PULL REQUEST — the exact act #294 exists to record.
 *
 * `$MERGE_FAILS=1` makes the engine's tool_result come back flagged as an error, which is how the
 * "attempted but refused" case is exercised without a real branch-protection rule.
 */
const FAKE_MERGER = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-merge" }) + "\\n");
const failed = process.env.MERGE_FAILS === "1";
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "git push -u origin fix && gh pr merge 42 --squash" } },
  ] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "toolu_01", is_error: failed, content: failed ? "protected branch" : "merged" },
  ] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "t1" }) + "\\n");
});
`;

describe("HeadlessSession — a run that merges to main must leave a record (#294)", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-acts-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function merger(id: string, env?: Record<string, string>): HeadlessSession {
		const bin = join(dir, `fake-merger-${id}.js`);
		writeFileSync(bin, FAKE_MERGER);
		chmodSync(bin, 0o755);
		return new HeadlessSession({ id, workDir: dir, clientType: "claude", bin, env, statePath: defaultStatePath(dir) });
	}

	it("records the push AND the merge, with the outcome the tool_result reported", async () => {
		// The whole issue: run 73ffc073 merged its own PRs to `main` unattended and the only record
		// it left said the objective completed. Without this, that is still true.
		const s = merger("acts1");
		s.start();
		await until(() => s.runState() === "idle");
		s.input("ship it");
		await until(() => s.runState() === "idle" && s.snapshot().includes("merged"));

		const acts = s.takeActs();
		expect(acts.map((a) => a.kind)).toEqual(["push", "pr.merge"]);
		expect(acts[1]).toMatchObject({ kind: "pr.merge", target: "#42", irreversible: true, ok: true });
		// Draining is destructive, for the same reason as usage: /coding/capture polls every 3s and
		// re-reporting would either duplicate the merge or force the cloud to diff a growing list.
		expect(s.takeActs()).toEqual([]);
		s.stop();
	}, 20_000);

	it("marks a REFUSED merge as failed, so the trail never claims a merge that did not happen", async () => {
		// A `gh pr merge` blocked by branch protection, published as a merge, would put an unattended
		// merge to `main` in the audit trail that never occurred — as corrosive as missing a real one.
		const s = merger("acts2", { MERGE_FAILS: "1" });
		s.start();
		await until(() => s.runState() === "idle");
		s.input("ship it");
		await until(() => s.runState() === "idle" && s.snapshot().includes("protected branch"));

		const acts = s.takeActs();
		expect(acts).toHaveLength(2);
		expect(acts.every((a) => a.ok === false)).toBe(true);
		s.stop();
	}, 20_000);

	it("records nothing for a raw engine — a gap, never a false all-clear", async () => {
		// Nothing parses a Codex/Grok session's stdout, so it can report no acts. An empty list must
		// therefore mean "not observed"; every consumer is written against that, and this is the test
		// that keeps the runner honest about it.
		const bin = join(dir, "fake-raw.js");
		writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write("gh pr merge 42 --squash\\n");\n`);
		chmodSync(bin, 0o755);
		const s = new HeadlessSession({ id: "acts3", workDir: dir, clientType: "codex", bin });
		s.start();
		s.input("ship it");
		await until(() => s.snapshot().includes("gh pr merge"), 8000, "the raw engine's output");
		expect(s.takeActs()).toEqual([]);
		s.stop();
	}, 20_000);
});

/**
 * A stand-in that opens a PR the way engines actually do — `gh pr create --fill`, whose number
 * exists nowhere but the command's own stdout (#417).
 *
 * `$WRONG_ID=1` addresses the result to a DIFFERENT `tool_use_id`, which is how the correlation
 * requirement is exercised: an unrelated command's output must not lend its PR number to this act.
 */
const FAKE_OPENER = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-open" }) + "\\n");
const wrongId = process.env.WRONG_ID === "1";
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_pr", name: "Bash", input: { command: "gh pr create --fill" } },
  ] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: wrongId ? "toolu_other" : "toolu_pr", content:
      "warning: 3 uncommitted changes\\nhttps://github.com/o/r/pull/123\\n" },
  ] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "t2" }) + "\\n");
});
`;

describe("HeadlessSession — a `--fill` PR names its number in its own result (#417)", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-acts-pr-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function opener(id: string, env?: Record<string, string>): HeadlessSession {
		const bin = join(dir, `fake-opener-${id}.js`);
		writeFileSync(bin, FAKE_OPENER);
		chmodSync(bin, 0o755);
		return new HeadlessSession({ id, workDir: dir, clientType: "claude", bin, env, statePath: defaultStatePath(dir) });
	}

	it("publishes the number the tool_result printed, so the Pulls panel can badge the row", async () => {
		// Before this, `gh pr create --fill` published `target: null` and #401 rendered an
		// agent-opened PR unattributed — the number was in the runner's hands the whole time.
		const s = opener("pr1");
		s.start();
		await until(() => s.runState() === "idle");
		s.input("open a PR");
		await until(() => s.runState() === "idle" && s.snapshot().includes("pull/123"));

		const acts = s.takeActs();
		expect(acts).toHaveLength(1);
		expect(acts[0]).toMatchObject({ kind: "pr.open", target: "#123", ok: true });
		s.stop();
	}, 20_000);

	it("ignores a PR URL from ANOTHER tool_use_id — attribution is correlated, not nearby", async () => {
		// The one failure this module exists to avoid is a confident wrong number. The result is only
		// evidence for the act when it is that command's OWN answer; a URL in some other tool's output
		// leaves the act exactly as unattributed as it is today.
		const s = opener("pr2", { WRONG_ID: "1" });
		s.start();
		await until(() => s.runState() === "idle");
		s.input("open a PR");
		await until(() => s.runState() === "idle" && s.snapshot().includes("pull/123"));

		const acts = s.takeActs();
		expect(acts).toHaveLength(1);
		// Flushed at end-of-turn with an UNKNOWN outcome: no result was ever addressed to it.
		expect(acts[0]).toMatchObject({ kind: "pr.open", target: null, ok: null });
		s.stop();
	}, 20_000);
});

describe("parseCommand — apostrophes must not pair ACROSS tokens", () => {
	it("keeps an EVEN number of apostrophes as literals in their own tokens", () => {
		// The first fix looked ahead for a closing quote anywhere in the command, so two ordinary
		// apostrophes paired across whitespace: `don't guess and don't stop` collapsed into one
		// argument `dont guess and dont` plus a stray `stop`, handing the engine a mangled prompt.
		expect(parseCommand("claude --append-system-prompt don't guess and don't stop")).toEqual({
			bin: "claude",
			args: ["--append-system-prompt", "don't", "guess", "and", "don't", "stop"],
		});
	});

	it("still honours a REAL quoted span containing whitespace", () => {
		expect(parseCommand(`claude --append-system-prompt "be terse please" --model x`)).toEqual({
			bin: "claude",
			args: ["--append-system-prompt", "be terse please", "--model", "x"],
		});
		expect(parseCommand("grok --agent='my agent' -p")).toEqual({ bin: "grok", args: ["--agent=my agent", "-p"] });
	});

	it("handles the awkward shapes without throwing or losing text", () => {
		expect(parseCommand("   ")).toEqual({ bin: "", args: [] });
		expect(parseCommand('a"b"c')).toEqual({ bin: "abc", args: [] });
		expect(parseCommand(`it's "a b" it's`)).toEqual({ bin: "it's", args: ["a b", "it's"] });
		expect(parseCommand('claude "unclosed')).toEqual({ bin: "claude", args: ['"unclosed'] });
	});
});

describe("HeadlessSession — a tool result records whether the call FAILED (#597)", () => {
	let dir: string;
	let bin: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-tool-ok-"));
		bin = join(dir, "fake-claude-tools.js");
		writeFileSync(bin, FAKE_CLAUDE_TOOLS);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("welds the outcome onto the arrow, so the cloud's per-call record can state it", async () => {
		// The transcript is the ONLY channel an ordinary tool call reaches the cloud through: a read
		// or a grep leaves no `agent_events` row, so the #581 AC7 record could carry the argument and
		// the result and never whether the call worked. `settleAct` read `is_error` and the line was
		// written without it — computed, used locally, dropped.
		const s = new HeadlessSession({ id: "tools-1", workDir: dir, clientType: "claude", bin, statePath: defaultStatePath(dir) });
		s.start();
		await until(() => s.runState() === "idle", 8000, "the engine to initialise");
		s.input("run the tests and read the file");
		await until(() => s.snapshot().includes("File does not exist."), 8000, "both tool results");

		const pane = s.snapshot();
		// The successful call, whose own output starts with `✓` — the marker is about the CALL.
		expect(pane).toContain("↳✓ ✓ src/a.test.ts (3 tests)");
		expect(pane).toContain("↳✗ File does not exist.");
		// The unmarked shape every runner up to 0.4.51 wrote is gone: it is what the cloud reads as
		// "not observed", and a new runner emitting it would report every call as unknown forever.
		expect(pane).not.toContain("  ↳ ");
		s.stop();
	}, 15_000);
});
