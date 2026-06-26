import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClientType } from "./handlers.js";

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

	constructor(readonly config: HeadlessSessionConfig) {
		this.sessionName = `pags-${config.clientType}-${config.id}`;
		this.claudeSessionId = readState(config.statePath, config.id);
	}

	/** True while the agent process is running. */
	get alive(): boolean {
		return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
	}

	/** Idle = ready for the next instruction. */
	get ready(): boolean {
		return this.alive && this.run === "idle";
	}

	runState(): "idle" | "thinking" | "responding" {
		return this.alive ? (this.run === "thinking" ? "thinking" : "idle") : "idle";
	}

	/** The rendered conversation the brain/console reads (Claude's real output). */
	snapshot(): string {
		return this.transcript.join("\n");
	}

	/** Launch (or resume) the agent process. Idempotent if already alive. */
	start(): void {
		if (this.alive) return;
		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
		];
		// Continue the prior conversation after a runner restart (state in ~/.claude).
		if (this.claudeSessionId) args.push("--resume", this.claudeSessionId);

		this.proc = spawn(this.config.bin ?? "claude", args, {
			cwd: this.config.workDir,
			env: { ...process.env, ...this.config.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.run = "idle";
		this.proc.stdout?.on("data", (d: Buffer) => this.onStdout(d.toString("utf8")));
		this.proc.stderr?.on("data", (d: Buffer) => {
			const text = d.toString("utf8").trim();
			if (text) this.push(`[claude] ${text}`);
		});
		this.proc.on("exit", (code) => {
			this.run = "idle";
			if (code && code !== 0) this.push(`[claude exited with code ${code}]`);
			// A bad --resume can kill the process instantly; drop it so the next
			// start is a clean session rather than looping on a dead id.
			if (code && code !== 0 && this.claudeSessionId) {
				this.claudeSessionId = null;
				writeState(this.config.statePath, this.config.id, null);
			}
		});
	}

	/** Send a user turn to Claude (the agent acts on it). */
	input(text: string): void {
		if (!this.alive) this.start();
		this.push(`\n❯ ${text}`); // ❯ — your turn, mirrors the old prompt marker
		this.run = "thinking";
		const msg = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
		try {
			this.proc?.stdin?.write(`${msg}\n`);
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
		this.buf += chunk;
		let nl: number;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard line-buffer drain
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (line) this.handle(line);
		}
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
						this.push(block.text.trim());
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
