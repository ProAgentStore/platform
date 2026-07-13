import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ClientType, handlerFor } from "./handlers.js";

/**
 * The coding engine — Claude Code driven through its structured **stream-json**
 * interface, NOT a scraped tmux TUI. One forward, LLM-powered path:
 *
 *   `claude -p --input-format stream-json --output-format stream-json` is a
 *   persistent agent process. We write user turns as JSON to its stdin and read
 *   real events from its stdout (assistant text, tool_use, tool_result, result).
 *
 * Why this is strictly better than pane-scraping:
 *  - **Real run-state.** A `result` event ends a turn → idle is a fact, not a
 *    regex guess. No "is it still thinking?" heuristics, no premature-finish bugs.
 *  - **Claude's actual words.** The transcript IS Claude's structured output, so
 *    the console shows the real conversation — no second "narrator" LLM needed.
 *  - **Survives a runner restart** without tmux: Claude Code persists the session
 *    to ~/.claude, so we re-spawn with `--resume <session_id>` and continue.
 *
 * Implements the same surface the {@link CodingRuntime} expects (start / snapshot
 * / runState / ready / input / interrupt / stop / alive), so the brain workflow,
 * routes and console keep working unchanged — only the guts move from tmux to
 * structured JSON.
 */
export interface HeadlessSessionConfig {
	/** Stable id (the coding_sessions row id). */
	id: string;
	/** Working directory the CLI runs in (the repo). */
	workDir: string;
	clientType: ClientType;
	/**
	 * The exact CLI launch command for this engine, e.g.
	 * `claude --dangerously-skip-permissions` or `codex`. Claude is driven via the
	 * structured stream-json protocol (we add the stream-json flags); any other
	 * engine is spawned as-is and its stdout is captured as the raw transcript.
	 * Defaults to the Claude command.
	 */
	command?: string;
	/** Extra env (the BYOK key) injected into the process. */
	env?: Record<string, string>;
	/** Path to persist the Claude session id (for --resume across runner restarts). */
	statePath?: string;
	/** Override the spawned binary (tests). Defaults to "claude". */
	bin?: string;
}

type Run = "idle" | "thinking";

/** A line emitted on the CLI's stdout, parsed loosely (we tolerate unknown shapes). */
interface StreamEvent {
	type?: string;
	subtype?: string;
	session_id?: string;
	is_error?: boolean;
	result?: string;
	message?: { content?: Array<Record<string, unknown>> };
}

export class HeadlessSession {
	readonly sessionName: string;
	private proc: ChildProcess | null = null;
	private buf = "";
	private transcript: string[] = [];
	private run: Run = "idle";
	/** Claude Code's own session id (from the init event) — used to --resume. */
	private claudeSessionId: string | null = null;
	/** "stream-json" for Claude (structured) · "raw" for any other CLI (stdout capture). */
	private readonly mode: "stream-json" | "raw";
	private readonly cmdBin: string;
	private readonly cmdArgs: string[];
	private readonly binName: string;
	/** Wall-clock of the last stdout/stderr byte — drives the raw-mode idle heuristic. */
	private lastOutputAt = 0;
	/** Raw-mode: has any output arrived since the current turn's input? */
	private sawOutputSinceInput = false;
	/** Raw-mode: when the current turn started (absolute idle backstop). */
	private turnStartedAt = 0;

	constructor(readonly config: HeadlessSessionConfig) {
		this.sessionName = `pags-${config.clientType}-${config.id}`;
		this.claudeSessionId = readState(config.statePath, config.id);
		// Claude is the structured engine; everything else is a raw CLI.
		this.mode = config.clientType === "claude" ? "stream-json" : "raw";
		const { bin, args } = parseCommand(config.command);
		// When no explicit command is configured, fall back to THIS engine's default
		// command (codex/gemini/grok/…) — not a hard-coded "claude", which would drive a
		// non-Claude session with the wrong CLI (and mode is already "raw" for it).
		const fallback = parseCommand(handlerFor(config.clientType).cliCommand);
		// A test/override bin wins for the binary only; the command's args are kept.
		this.cmdBin = config.bin ?? (bin || fallback.bin || "claude");
		// Use the configured command's args when a command was given (bin set), else the
		// engine default's args.
		this.cmdArgs = bin ? args : fallback.args;
		this.binName = (this.cmdBin.split("/").pop() || this.cmdBin) || "cli";
	}

	/** True while the agent process is running. NOTE: do NOT use `proc.killed` — Node sets
	 *  it true the instant a signal is DELIVERED, not when the process exits. interrupt()
	 *  SIGINTs to abort a turn while the process keeps running, so `killed` gave a false
	 *  "dead" → input() then spawned a SECOND process (orphaning the first). exitCode is
	 *  null while running and set on normal exit; signalCode is set when a signal actually
	 *  terminated it — together they're the real liveness signal. */
	get alive(): boolean {
		return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
	}

	/** Idle = ready for the next instruction. */
	get ready(): boolean {
		return this.alive && this.runState() === "idle";
	}

	runState(): "idle" | "thinking" | "responding" {
		if (!this.alive) return "idle";
		// Raw engines have no "turn over" event, so we INFER idle. Three rules, in order:
		//  1. produced output, then went quiet for 1.5s → settled (the common case).
		//  2. NEVER produced output but 8s elapsed → a silent turn (just a prompt) is done.
		//  3. absolute 15-min backstop → never wedge "thinking" forever (e.g. a heartbeat
		//     that keeps refreshing lastOutputAt). The user can also Restart from diagnostics.
		// Rule 1 deliberately waits for first output so a slow first token can't flip us
		// to idle mid-turn (which would make the brain proceed against a half-done turn).
		//
		// This is derived PURELY from timers each call — it does NOT latch `this.run` to
		// "idle". Latching was a one-way trap: once a >1.5s pause (slow compile / test run /
		// network) flipped us idle, resumed output couldn't restore "thinking" (onStdout only
		// bumps lastOutputAt), so the brain proceeded against a still-running turn and
		// double-sent or falsely called done. Recomputing means fresh output → quiet resets →
		// "thinking" again, all on its own.
		if (this.mode === "raw" && this.run === "thinking") {
			const now = Date.now();
			const quiet = now - this.lastOutputAt;
			const elapsed = now - this.turnStartedAt;
			const settled =
				(this.sawOutputSinceInput && quiet > 1500) ||
				(!this.sawOutputSinceInput && elapsed > 8000) ||
				elapsed > 15 * 60 * 1000;
			return settled ? "idle" : "thinking";
		}
		return this.run === "thinking" ? "thinking" : "idle";
	}

	/** The rendered conversation the brain/console reads (Claude's real output). */
	snapshot(): string {
		return this.transcript.join("\n");
	}

	/** Launch (or resume) the agent process. Idempotent if already alive. */
	start(): void {
		if (this.alive) return;
		// stream-json: we own the structural flags + --resume; merge the user's extras
		// (e.g. --model) without letting them clobber or orphan-value our flags. raw:
		// run exactly what the user configured and capture stdout.
		const args = this.mode === "stream-json" ? buildClaudeArgs(this.cmdArgs, this.claudeSessionId) : [...this.cmdArgs];

		const proc = spawn(this.cmdBin, args, {
			cwd: this.config.workDir,
			env: { ...process.env, ...this.config.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		this.run = "idle";
		this.lastOutputAt = Date.now();
		// MUST handle 'error' — without a listener, a spawn failure (e.g. the binary
		// not on PATH) is thrown as an uncaught exception and crashes the runner.
		proc.on("error", (err: Error) => {
			if (this.proc !== proc) return; // a newer process replaced this one — ignore the stale event
			this.run = "idle";
			this.push(`[cannot run \`${this.cmdBin}\`: ${err.message} — is ${this.binName} installed and on your PATH?]`);
			this.proc = null;
		});
		// Swallow EPIPE when writing to a process that just exited (one-shot turn).
		proc.stdin?.on("error", () => {});
		proc.stdout?.on("data", (d: Buffer) => this.onStdout(d.toString("utf8")));
		proc.stderr?.on("data", (d: Buffer) => {
			this.lastOutputAt = Date.now();
			this.sawOutputSinceInput = true;
			const text = d.toString("utf8").trim();
			if (text) this.push(`[${this.binName}] ${stripAnsi(text)}`);
		});
		proc.on("exit", (code) => {
			// A stop() + re-start() on the SAME session object can leave this old process's
			// async exit to fire AFTER the fresh start — capturing `proc` and bailing when it
			// no longer matches stops the stale handler from resetting the new turn to idle.
			if (this.proc !== proc) return;
			this.run = "idle";
			if (code && code !== 0) this.push(`[${this.binName} exited with code ${code}]`);
			// A bad --resume can kill the process instantly; drop it so the next
			// start is a clean session rather than looping on a dead id.
			if (code && code !== 0 && this.claudeSessionId) {
				this.claudeSessionId = null;
				writeState(this.config.statePath, this.config.id, null);
			}
		});
	}

	/** Send a user turn to the agent (it acts on it). */
	input(text: string): void {
		if (!this.alive) this.start();
		this.push(`\n❯ [${stamp()}] ${text}`); // ❯ — your turn, timestamped
		this.run = "thinking";
		const now = Date.now();
		this.lastOutputAt = now;
		this.turnStartedAt = now;
		this.sawOutputSinceInput = false; // arm the raw idle heuristic for THIS turn
		try {
			if (this.mode === "stream-json") {
				const msg = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
				this.proc?.stdin?.write(`${msg}\n`);
			} else {
				// Raw CLI: write the line to stdin as if typed.
				this.proc?.stdin?.write(`${text}\n`);
			}
		} catch {
			/* process may have died; the next snapshot reports not-alive */
		}
	}

	/** No TTY in headless mode; control is via messages. Kept for interface parity. */
	key(_keys: string): void {
		/* intentionally a no-op — there are no raw keystrokes without a terminal */
	}

	/** Abort the current turn (SIGINT, like Ctrl-C). The process stays usable. */
	interrupt(): void {
		try {
			this.proc?.kill("SIGINT");
		} catch {
			/* ignore */
		}
		this.run = "idle";
		this.lastOutputAt = Date.now();
	}

	/** Tear the process down. */
	stop(): void {
		try {
			this.proc?.kill();
		} catch {
			/* ignore */
		}
		this.proc = null;
		this.run = "idle";
	}

	// ── internals ────────────────────────────────────────────────────────────

	private onStdout(chunk: string): void {
		this.lastOutputAt = Date.now();
		this.sawOutputSinceInput = true; // a slow first token must NOT count as idle
		this.buf += chunk;
		let nl: number;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard line-buffer drain
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			if (this.mode === "stream-json") this.handle(line);
			else this.pushRaw(line); // raw engine — the line IS the terminal output
		}
		// A TUI/raw engine may render without newlines; surface the partial output and cap
		// growth at 16KB. Claude's stream-json, though, emits ONE JSON object per line and a
		// single event (a large tool_result / the final `result`) can legitimately exceed
		// 16KB — truncating mid-line there corrupts the event, and losing a `result` line
		// wedges the turn "thinking" forever (stream-json has no idle backstop). So give the
		// structured path a far larger ceiling; only a pathologically huge line resets it.
		const cap = this.mode === "raw" ? 16 * 1024 : 4 * 1024 * 1024;
		if (this.buf.length > cap) {
			if (this.mode === "raw") this.pushRaw(this.buf);
			this.buf = "";
		}
	}

	/** Raw-engine stdout: strip ANSI control codes and append to the transcript. */
	private pushRaw(line: string): void {
		const clean = stripAnsi(line);
		if (clean.trim()) this.push(clean);
		if (this.transcript.length > 4000) this.transcript = this.transcript.slice(-3000);
	}

	private handle(line: string): void {
		let ev: StreamEvent;
		try {
			ev = JSON.parse(line) as StreamEvent;
		} catch {
			return; // tolerate non-JSON noise
		}
		switch (ev.type) {
			case "system":
				if (ev.subtype === "init" && ev.session_id) {
					this.claudeSessionId = ev.session_id;
					writeState(this.config.statePath, this.config.id, ev.session_id);
				}
				break;
			case "assistant":
				for (const block of ev.message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
						this.push(`[${stamp()}] ${block.text.trim()}`); // timestamped agent reply
					} else if (block.type === "tool_use") {
						this.push(`⚙ ${String(block.name ?? "tool")} ${shortInput(block.input)}`); // ⚙
					}
				}
				break;
			case "user": // tool results come back as a synthetic user message
				for (const block of ev.message?.content ?? []) {
					if (block.type === "tool_result") this.push(`  ↳ ${toolResult(block.content)}`); // ↳
				}
				break;
			case "result":
				if (ev.is_error) this.push(`[error] ${ev.result ?? ev.subtype ?? "failed"}`);
				this.run = "idle"; // the turn is OVER — a fact, not a guess
				break;
			default:
				break;
		}
		// Keep the in-memory transcript bounded.
		if (this.transcript.length > 4000) this.transcript = this.transcript.slice(-3000);
	}

	private push(line: string): void {
		this.transcript.push(line);
	}
}

/** Local wall-clock "HH:MM:SS" for transcript timestamps (runner is a Node process). */
function stamp(): string {
	return new Date().toTimeString().slice(0, 8);
}

/** Split a launch command into bin + args, respecting single/double quotes. */
export function parseCommand(command: string | undefined): { bin: string; args: string[] } {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: tokenizer drain
	while ((m = re.exec(command ?? "")) !== null) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
	return { bin: tokens[0] ?? "", args: tokens.slice(1) };
}

/** Structural flags PAGS owns for the Claude stream-json engine — a user command
 *  must not override or duplicate these (and must not orphan their values). */
const RESERVED_CLAUDE_FLAGS = new Set(["-p", "--print", "--input-format", "--output-format", "--verbose", "--resume"]);

/**
 * Build Claude's argv: our structural stream-json flags + the user's extra args
 * (e.g. `--model`), with reserved flags (and their values) stripped so the user
 * can't clobber the protocol or leave an orphaned positional. `--resume` is added
 * last from our persisted session id, never from the user's command.
 */
export function buildClaudeArgs(userArgs: string[], resumeId: string | null): string[] {
	const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
	for (let i = 0; i < userArgs.length; i++) {
		const a = userArgs[i];
		if (RESERVED_CLAUDE_FLAGS.has(a)) {
			// drop the flag AND its value (when the next token isn't itself a flag)
			if (i + 1 < userArgs.length && !userArgs[i + 1].startsWith("-")) i++;
			continue;
		}
		// Push every user token as-is. A previous `!args.includes(a)` dedup silently
		// dropped a REPEATED flag token (e.g. the 2nd `--add-dir` in `--add-dir /a
		// --add-dir /b`), which orphaned its value (`/b` became a stray positional).
		// Our own structural flags are already protected via RESERVED_CLAUDE_FLAGS, so
		// no dedup is needed here.
		args.push(a);
	}
	if (!args.includes("--dangerously-skip-permissions")) args.push("--dangerously-skip-permissions");
	if (resumeId) args.push("--resume", resumeId);
	return args;
}

/** Strip ANSI/VT escape sequences so a raw CLI's coloured output reads as plain text. */
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape/control codes from terminal output.
	return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][AB0-2]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** Compact a tool_use input object to a single readable line. */
function shortInput(input: unknown): string {
	if (input == null) return "";
	try {
		const s = typeof input === "string" ? input : JSON.stringify(input);
		return s.length > 160 ? `${s.slice(0, 160)}…` : s;
	} catch {
		return "";
	}
}

/** Render a tool_result's content (string, or array of {type:text,text}) to text. */
function toolResult(content: unknown): string {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
			.join(" ");
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

// ── tiny on-disk store: our session id → Claude's session id (resume key) ──────
// So a runner restart can `--resume` the conversation. One JSON file, best-effort.

interface StateFile {
	[sessionId: string]: string;
}

function loadFile(path: string | undefined): StateFile {
	if (!path || !existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as StateFile;
	} catch {
		return {};
	}
}

function readState(path: string | undefined, id: string): string | null {
	return loadFile(path)[id] ?? null;
}

function writeState(path: string | undefined, id: string, claudeSessionId: string | null): void {
	if (!path) return;
	try {
		const data = loadFile(path);
		if (claudeSessionId) data[id] = claudeSessionId;
		else delete data[id];
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(data));
	} catch {
		/* best-effort persistence */
	}
}

/** Default location for the resume-id store, under the repos base dir. */
export function defaultStatePath(reposBaseDir: string): string {
	return join(reposBaseDir, "headless-sessions.json");
}
