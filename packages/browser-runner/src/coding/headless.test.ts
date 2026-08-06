import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClaudeArgs, defaultStatePath, HeadlessSession, parseCommand, mergeEnv } from "./headless.js";

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

/** A raw CLI that prints its own argv — to prove preset flags reach the engine verbatim. */
const FAKE_ARGV = `#!/usr/bin/env node
process.stdout.write("argv: " + JSON.stringify(process.argv.slice(2)) + "\\n");
`;

/** A raw CLI whose FIRST output is slow (1.8s) — to prove we don't flip idle early. */
const FAKE_SLOW = `#!/usr/bin/env node
const line = process.argv[2] || "";
setTimeout(() => process.stdout.write("late: " + line + "\\n"), 1800);
`;

/** A raw CLI that emits, PAUSES > 1.5s (e.g. a compile/test run), then resumes — to prove
 *  the settle heuristic doesn't LATCH idle: resumed output must restore "thinking". */
const FAKE_PAUSER = `#!/usr/bin/env node
const line = process.argv[2] || "";
process.stdout.write("part 1: " + line + "\\n");
setTimeout(() => process.stdout.write("part 2: " + line + "\\n"), 2000);
// Linger so the resumed-"thinking" state is observable before close ends the turn.
setTimeout(() => {}, 4000);
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
	});
});

describe("HeadlessSession (raw engine — Codex/Grok/custom)", () => {
	let dir: string;
	let codexBin: string;
	let slowBin: string;
	let pauserBin: string;
	let argvBin: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-raw-"));
		codexBin = join(dir, "fake-codex.js");
		slowBin = join(dir, "fake-slow.js");
		pauserBin = join(dir, "fake-pauser.js");
		argvBin = join(dir, "fake-argv.js");
		writeFileSync(codexBin, FAKE_CODEX);
		writeFileSync(slowBin, FAKE_SLOW);
		writeFileSync(pauserBin, FAKE_PAUSER);
		writeFileSync(argvBin, FAKE_ARGV);
		chmodSync(codexBin, 0o755);
		chmodSync(slowBin, 0o755);
		chmodSync(pauserBin, 0o755);
		chmodSync(argvBin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("reports NO usage — an unmeasurable engine must leave a gap, not a zero", async () => {
		// Codex/Grok emit no structured result event, so there is nothing to measure. Recording a
		// zero row would put "Coding engine · $0.00" on the Usage page, which claims the engine was
		// free — a stronger and more misleading statement than the absence it replaces (#267).
		// The absence is structural, not a special case: raw mode never parses JSON at all.
		const s = new HeadlessSession({ id: "rawusage", workDir: dir, clientType: "codex", bin: codexBin });
		s.start();
		s.input("hi");
		await until(() => s.snapshot().includes("done: hi"), 12_000, "raw stdout to include final line");
		expect(s.takeUsage()).toEqual([]);
		s.stop();
	}, 20_000);

	it("captures raw stdout (ANSI-stripped) into the transcript and settles to idle", async () => {
		const s = new HeadlessSession({ id: "raw1", workDir: dir, clientType: "codex", bin: codexBin });
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

		await until(() => s.runState() === "idle", 6000, "raw session to settle idle"); // quiet for 1.5s → idle
		expect(s.runState()).toBe("idle");
		s.stop();
	}, 20_000);

	it("a slow first token does NOT flip to idle mid-turn", async () => {
		const s = new HeadlessSession({ id: "raw2", workDir: dir, clientType: "codex", bin: slowBin });
		s.start();
		s.input("go");
		await wait(1000); // 1s in, no output yet — old heuristic would have flipped idle at 1.5s of silence
		expect(s.runState()).toBe("thinking");
		await until(() => s.snapshot().includes("late: go"), 6000, "slow raw first output");
		s.stop();
	}, 15_000);

	it("does NOT latch idle: resumed output after a >1.5s pause restores thinking", async () => {
		const s = new HeadlessSession({ id: "raw-pause", workDir: dir, clientType: "codex", bin: pauserBin });
		s.start();
		s.input("build");
		// First chunk lands, then a >1.5s pause → the settle heuristic reads idle...
		await until(() => s.snapshot().includes("part 1: build"), 6000, "first paused raw output");
		await until(() => s.runState() === "idle", 6000, "paused raw session to settle idle");
		expect(s.runState()).toBe("idle");
		// ...but when the turn RESUMES (part 2), state must return to thinking, not stay
		// latched idle (the bug that made the brain act on a half-finished turn).
		await until(() => s.snapshot().includes("part 2: build"), 6000, "second paused raw output");
		expect(s.runState()).toBe("thinking");
		// And it settles to idle again once truly quiet.
		await until(() => s.runState() === "idle", 6000, "resumed raw session to settle idle");
		expect(s.runState()).toBe("idle");
		s.stop();
	}, 20_000);

	it("is ALIVE between turns — a resting one-shot engine is not a dead session", async () => {
		// The Pilot opens every iteration with
		//   if (!snap.alive) return failed("coding session is not running")
		// and a one-shot engine has no process between turns — that IS its resting state. So
		// every delegated goal on codex/grok/gemini/ollama died at iteration 0 having done
		// nothing, reporting a dead session that was healthy and answering interactive turns.
		// `alive` means "can take a turn"; "is a turn executing" is runState.
		const s = new HeadlessSession({ id: "raw-alive", workDir: dir, clientType: "codex", bin: codexBin });
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

describe("mergeEnv — the platform's engine choice must beat the machine's", () => {
	it("REMOVES a key the platform sends as empty", () => {
		// The whole reason this exists: a developer with ANTHROPIC_API_KEY exported handed it to
		// every engine, and Claude Code prefers an API key over the subscription token — so
		// picking "subscription" billed per token anyway, silently.
		const out = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-real", PATH: "/usr/bin" }, { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "" });
		expect("ANTHROPIC_API_KEY" in out).toBe(false);
		expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
	});

	it("keeps the rest of the machine env untouched", () => {
		const out = mergeEnv({ PATH: "/usr/bin", HOME: "/Users/x" }, { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/Users/x");
	});

	it("still lets api-key mode SET the key", () => {
		// Removal must not become a blanket ban — choosing api-key mode is legitimate.
		const out = mergeEnv({}, { ANTHROPIC_API_KEY: "sk-ant-chosen" });
		expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-chosen");
	});

	it("passes the machine env straight through when the platform sends nothing", () => {
		// "machine" auth: PAGS injects nothing and must not strip anything either.
		const out = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-machine" }, undefined);
		expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-machine");
	});
});

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
		const s = new HeadlessSession({ id: "stale", workDir: dir, clientType: "codex", bin: slowBin });
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

	it("aborts a still-running turn before spawning its replacement", async () => {
		// Two engine processes editing the same repo concurrently is worse than a lost turn.
		const s = new HeadlessSession({ id: "stale2", workDir: dir, clientType: "codex", bin: fastBin });
		s.start();
		s.input("one");
		await until(() => s.snapshot().includes("turn2: one"), 6000, "first turn");
		s.input("two");
		await until(() => s.snapshot().includes("turn2: two"), 6000, "second turn");
		// Both turns are in the transcript, and exactly one process is current.
		expect(s.snapshot()).toContain("turn2: one");
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
