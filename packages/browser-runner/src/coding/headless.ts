import { type ChildProcess, spawn } from "node:child_process";
import { classifyCommand, commandFromToolInput, type EngineActRecord, fillTargetFromResult } from "./engine-acts.js";
import { type EngineUsageRecord, parseEngineUsage } from "./engine-usage.js";

/**
 * Merge the platform's resolved engine env over the machine's, where an EMPTY value means
 * REMOVE rather than "set to empty".
 *
 * Needed because the machine env is inherited wholesale: a developer with ANTHROPIC_API_KEY in
 * their shell handed it to every engine, and Claude Code prefers an API key over the
 * subscription token — so choosing "subscription" injected CLAUDE_CODE_OAUTH_TOKEN and then
 * silently lost, billing per token anyway. Without a way to express removal the setting could
 * not mean what it said.
 */
export function mergeEnv(
	base: NodeJS.ProcessEnv,
	overlay: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...base };
	for (const [k, v] of Object.entries(overlay ?? {})) {
		if (v === "") delete out[k];
		else out[k] = v;
	}
	return out;
}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ClientType, handlerFor } from "./handlers.js";
import { type EngineAuthResolved, resolveEngineAuth } from "./engine-auth.js";

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
	/**
	 * A PREVIOUS coding-session id whose conversation this session should adopt (#408).
	 *
	 * The resume store is keyed by {@link HeadlessSessionConfig.id}, so it only ever survived a
	 * runner restart for the SAME row. A reaped session gets a new row and therefore a new id, so
	 * re-opening a repo silently started a brand-new Claude conversation — the "it forgot
	 * everything" report. The cloud decides whether continuing is still appropriate
	 * (`resolveSessionContinuity`) and names the row to continue here; this side only looks it up.
	 *
	 * Consulted ONLY when this session's own id has no entry. Our own key is always the better
	 * answer — it is this exact session's conversation — and preferring it keeps a re-attach
	 * byte-identical to what it was before this field existed.
	 */
	resumeFrom?: string;
	/** Override the spawned binary (tests). Defaults to "claude". */
	bin?: string;
	/** Override the one-shot turn ceiling in ms (tests). Defaults to {@link MAX_ONE_SHOT_TURN_MS}. */
	maxTurnMs?: number;
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

/**
 * How many un-drained usage records a session holds (#267).
 *
 * Records are drained by the cloud on capture, which polls every 3s while a session is watched,
 * so this only fills when nobody is looking. Dropping the OLDEST past the cap is the right
 * direction: an unbounded queue on a long-running runner is a leak, and the alternative
 * (refusing new records) would lose the turns that just happened rather than ancient ones.
 */
const MAX_PENDING_USAGE = 200;

/**
 * How many un-drained consequential acts a session holds (#294).
 *
 * Smaller than the usage cap because acts are rare by construction — an ordinary turn produces
 * none — so filling this means something has gone very wrong (a loop force-pushing repeatedly),
 * and in that case the FIRST ones are the ones that explain it. So this cap drops the NEWEST rather
 * than the oldest, the opposite of the usage queue: a spend record is fungible and the recent ones
 * matter most, whereas the merge that started an incident is the one you cannot afford to lose.
 */
const MAX_PENDING_ACTS = 100;

/**
 * Absolute ceiling on ONE one-shot turn (#391).
 *
 * The old idle heuristic carried a 15-minute backstop so a wedged engine could not sit "thinking"
 * forever. Now that exit is the only thing that ends a one-shot turn, that ceiling has to be
 * ENFORCED rather than inferred: a rule that merely relabels a still-running process as idle is
 * the very defect #391 is about — it hands the next turn a repo another engine is still editing.
 *
 * So the timer ends the turn (SIGTERM) and says so in the transcript. Removing the ceiling
 * outright would trade an early kill for a permanent hang, which is worse: nothing else on this
 * path can unstick a process that never exits, and the console's Restart is a human noticing.
 */
const MAX_ONE_SHOT_TURN_MS = 15 * 60 * 1000;

export class HeadlessSession {
	/**
	 * A human-readable label for this engine process (#247).
	 *
	 * Was `sessionName`, formatted `pags-<client>-<id>` — which looked exactly like a tmux
	 * target and was reported to the console as `tmuxSession`. The engine has not used tmux
	 * since it moved to the stream-json interface, so a user who did the obvious thing with a
	 * name like that (`tmux attach -t pags-claude-…`) got "session not found" and reasonably
	 * concluded their engine was broken. It addresses nothing — it is only ever displayed.
	 */
	readonly engineLabel: string;
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
	/** Wall-clock of the last stdout/stderr byte — drives the persistent-raw idle heuristic. */
	private lastOutputAt = 0;
	/** Persistent-raw: has any output arrived since the current turn's input? */
	private sawOutputSinceInput = false;
	/** Persistent-raw: when the current turn started (absolute idle backstop). */
	private turnStartedAt = 0;
	/** Set by stop() — the only thing that ends a one-shot session (see `alive`). */
	private stopped = false;
	/** Measured engine spend not yet handed to the cloud (#267). Drained by {@link takeUsage}. */
	private pendingUsage: EngineUsageRecord[] = [];
	/**
	 * Consequential acts observed but not yet handed to the cloud (#294). Drained by
	 * {@link takeActs}.
	 */
	private pendingActs: EngineActRecord[] = [];
	/**
	 * Acts whose `tool_result` has not come back yet, keyed by the engine's `tool_use` id.
	 *
	 * They are held here rather than published immediately so the record can say whether the
	 * command SUCCEEDED. A `gh pr merge` that failed on a branch-protection rule, published as a
	 * merge, would put an unattended merge to `main` in the audit trail that never happened — which
	 * damages the record exactly as much as missing a real one.
	 */
	private awaitingResult = new Map<string, EngineActRecord[]>();
	/** Turn counter — only used to build a fallback id when the CLI's event has no `uuid`. */
	private usageSeq = 0;
	/**
	 * Per-PROCESS salt for that fallback id.
	 *
	 * Without it, a runner restart resets `usageSeq` and the new session's first turn reuses the
	 * id of a turn from before the restart — which the cloud's conflict-ignoring insert would
	 * silently drop, undercounting exactly the long-lived sessions this feature exists to measure.
	 * The queue is in memory and dies with the process, so a salt can never cause a double-count.
	 */
	private readonly usageRunId = Math.random().toString(36).slice(2, 10);
	/** Fallback counter for an act whose `tool_use` block carries no id of its own. */
	private actSeq = 0;
	/**
	 * Per-PROCESS salt for act ids, for the same reason as {@link usageRunId}.
	 *
	 * Claude Code's `tool_use` ids are unique within a conversation, not across restarts. Without a
	 * salt, a resumed session could re-emit an id the cloud has already written, and the
	 * conflict-ignoring insert would silently drop the SECOND act — a real merge, discarded because
	 * an older one happened to share an id. The queue is in memory and dies with the process, so a
	 * salt can never cause a double-write.
	 */
	private readonly actsRunId = Math.random().toString(36).slice(2, 10);
	/**
	 * The engine binary could not be spawned (ENOENT, not executable).
	 *
	 * Without this, `alive = !stopped` made a MISCONFIGURED engine indistinguishable from a
	 * healthy idle one — so `runCodingLoop`'s `if (!snap.alive)` guard, the thing that catches a
	 * bad command, became structurally unreachable for every one-shot engine and the Pilot burned
	 * all 40 BYOK decisions re-spawning a binary that isn't there.
	 */
	private spawnFailed = false;

	/**
	 * What this engine IS, so the question is answerable instead of implied (#248, #247).
	 *
	 * Sessions have not used tmux since the move to stream-json, but the surface kept saying
	 * `tmuxSession`/`pagsTmuxTotal` long enough that a user's reasonable next move
	 * (`tmux attach -t …`) failed and looked like a broken engine. Stating the runtime beats
	 * removing the wrong word and leaving nothing in its place.
	 */
	readonly engineRuntime = "child-process" as const;

	/**
	 * The credential this engine actually runs on — computed from the SAME expression `spawn`
	 * uses, so it reports what happened rather than what was configured (#248). A getter, not a
	 * cached field, because it must never drift from the env the next turn is spawned with.
	 * Presence only: no key or token value leaves this class.
	 */
	get authResolved(): EngineAuthResolved {
		return resolveEngineAuth(this.config.clientType, mergeEnv(process.env, this.config.env) as Record<string, string | undefined>);
	}

	/**
	 * Did this engine launch with a conversation to continue (#408)?
	 *
	 * Reported back to the cloud by `/coding/start` so the sentence the agent says to the user is
	 * something this side CONFIRMED rather than something the cloud asked for. The distinction is
	 * not academic: a runner published before #408 ignores `resumeFrom` entirely and always starts
	 * clean, so a cloud that announced "resumed where we left off" on its own intent would be
	 * telling most of the fleet's users the opposite of what happened.
	 *
	 * False for a raw (non-Claude) engine under every circumstance — `--resume` is a Claude Code
	 * flag and {@link buildClaudeArgs} is only reached in stream-json mode.
	 */
	get resumedConversation(): boolean {
		return this.mode === "stream-json" && this.claudeSessionId !== null;
	}

	constructor(readonly config: HeadlessSessionConfig) {
		this.engineLabel = `${config.clientType}:${config.id}`;
		// Our own key first, the cloud's nominated predecessor second. See `resumeFrom`.
		this.claudeSessionId = readState(config.statePath, config.id) ?? (config.resumeFrom ? readState(config.statePath, config.resumeFrom) : null);
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

	/**
	 * Can this session take a turn? — NOT "is a process executing right now".
	 *
	 * The distinction only appeared with one-shot engines. A persistent Claude session has a
	 * process alive between turns, so the two questions had the same answer and one getter served
	 * both. A one-shot engine has NO process between turns — that is its resting state — so the
	 * process-liveness answer is `false` for every question asked while the session sits idle,
	 * which is exactly when the Pilot asks.
	 *
	 * The cost of conflating them was total: `runCodingLoop` opens with
	 * `if (!snap.alive) return failed("coding session is not running")`, so every delegated goal
	 * on codex/grok/gemini/ollama died at iteration 0 having done nothing, reporting a dead
	 * session that was in fact healthy and answering interactive turns fine.
	 *
	 * So: a one-shot session is alive until `stop()`. Whether a turn is currently executing is
	 * `runState`, which is the question the loop actually has a use for.
	 *
	 * NOTE for the persistent path: do NOT use `proc.killed` — Node sets it true the instant a
	 * signal is DELIVERED, not when the process exits. interrupt() SIGINTs to abort a turn while
	 * the process keeps running, so `killed` gave a false "dead" → input() then spawned a SECOND
	 * process (orphaning the first). exitCode is null while running and set on normal exit;
	 * signalCode is set when a signal actually terminated it — together they're the real signal.
	 */
	get alive(): boolean {
		if (this.oneShot) return !this.stopped && !this.spawnFailed;
		return this.procAlive;
	}

	/** Is a process running THIS instant? The persistent engine's liveness, and the spawn guard. */
	private get procAlive(): boolean {
		return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
	}

	/** Idle = ready for the next instruction. */
	get ready(): boolean {
		return this.alive && this.runState() === "idle";
	}

	runState(): "idle" | "thinking" | "responding" {
		if (!this.alive) return "idle";
		// A ONE-SHOT engine's turn IS a process, so its exit is an exact end-of-turn signal and no
		// timer may pre-empt it (#391). Idle is set by the `close` handler; here the only question
		// is whether that process is still running.
		//
		// This used to fall through to the timer rules below, which were written for a PERSISTENT
		// interactive CLI — one with no other signal to read. Against a one-shot engine the 1.5s
		// quiet rule could only ever fire EARLY: any pause inside a turn (a test suite, an install,
		// a slow network fetch) read as "finished", the Pilot sent turn 2, and `runOneShot` killed
		// turn 1 to keep two engines off one repo. The heuristic that existed to prevent a
		// premature finish was causing one, and destroying the work in flight to do it.
		//
		// The ceiling that stops a wedged process is armed in `runOneShot` — it ENDS the turn
		// rather than relabelling a live one as idle, which is the same mistake in slower form.
		if (this.oneShot) return this.procAlive ? "thinking" : "idle";
		// Below: a PERSISTENT non-Claude engine — alive between turns, so exit says nothing about
		// a turn and idle must be inferred. None ships today; every raw engine is one-shot. The
		// gate is `!oneShot` rather than `mode === "raw"` because the latter now means the
		// OPPOSITE of the condition these rules were written for.
		//
		// Three rules, in order:
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
	/**
	 * Raw engines run ONE-SHOT PER TURN, not as a persistent interactive process.
	 *
	 * The persistent design assumed an interactive CLI reading stdin — which is what tmux used to
	 * provide, via a PTY. Without one, `codex` (and grok, and any TUI) dies immediately with
	 * "stdin is not a terminal", so three of the four engines were simply broken.
	 *
	 * AgentCoder solved this before PAGS existed and ran fine on it: `claude -p '<instruction>'`
	 * per turn, plain exec, no PTY and no tmux. Codex's exact analogue is `codex exec`. So the
	 * process is spawned when a turn ARRIVES and exits when the turn ends, rather than being
	 * kept alive for stdin writes that a non-interactive binary will never read.
	 *
	 * Claude keeps its persistent stream-json process — it is explicitly non-interactive and
	 * multi-turn, which is why it survived the migration untouched.
	 */
	private get oneShot(): boolean {
		return this.mode === "raw";
	}

	start(): void {
		// Starting always un-stops: `stop()` is what ends a one-shot session, so a (re)start
		// after one has to bring it back or the session is permanently unusable.
		this.stopped = false;
		this.spawnFailed = false; // a restart is also a retry of a command that could not run
		// A one-shot engine has nothing to start until there is a turn to run; starting it here
		// is what produced the instant "exited with code 1".
		if (this.oneShot) {
			this.run = "idle";
			return;
		}
		if (this.procAlive) return;
		// stream-json: we own the structural flags + --resume; merge the user's extras
		// (e.g. --model) without letting them clobber or orphan-value our flags. raw:
		// run exactly what the user configured and capture stdout.
		const args = this.mode === "stream-json" ? buildClaudeArgs(this.cmdArgs, this.claudeSessionId) : [...this.cmdArgs];

		const proc = spawn(this.cmdBin, args, {
			cwd: this.config.workDir,
			env: mergeEnv(process.env, this.config.env),
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
		this.sawOutputSinceInput = false; // arm the persistent-raw idle heuristic for THIS turn
		try {
			if (this.mode === "stream-json") {
				const msg = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
				this.proc?.stdin?.write(`${msg}\n`);
			} else {
				// Raw CLI: spawn THIS turn. See `oneShot` — there is no persistent process to
				// write to, because a non-interactive binary would never have read it.
				this.runOneShot(text);
			}
		} catch {
			/* process may have died; the next snapshot reports not-alive */
		}
	}

	/**
	 * Run ONE turn as its own process, the way AgentCoder did (`claude -p '<instruction>'`).
	 *
	 * Contract, deliberately general so it is not a Codex special case: **the preset command is a
	 * prefix and the turn text is appended as the final argument.** That makes every prompt-in /
	 * text-out CLI usable by configuration alone —
	 *
	 *   codex exec              → codex exec "<turn>"
	 *   claude -p               → claude -p "<turn>"
	 *   ollama run llama3       → ollama run llama3 "<turn>"
	 *   my-model --flag         → my-model --flag "<turn>"
	 *
	 * — including a local model, with no platform change and no cloud key. Whoever configures the
	 * preset decides what runs and what it costs; the platform does not need to know the engine.
	 */
	private runOneShot(text: string): void {
		const proc = spawn(this.cmdBin, [...this.cmdArgs, text], {
			cwd: this.config.workDir,
			env: mergeEnv(process.env, this.config.env),
			stdio: ["ignore", "pipe", "pipe"],
		});
		// A turn already running is aborted before its replacement starts: `input()` accepts a turn
		// at any time — a human typing in the console, a takeover, a Loop that stopped waiting —
		// so without this TWO engine processes edit the same repo at once. Still needed after #391
		// made exit authoritative: that stops the Pilot from being TOLD a running turn is over, it
		// does not stop anyone from sending anyway.
		//
		// It SAYS what it destroyed, for the same reason the non-zero exit code goes into the
		// transcript below: a turn's work vanishing with no line in the record is how the Pilot
		// ends up reasoning about a turn that never finished, with nothing to explain the gap.
		if (this.procAlive) {
			this.push(`[${this.config.clientType} turn aborted — a new instruction arrived while the previous one was still running]`);
			try {
				this.proc?.kill();
			} catch {
				/* already gone */
			}
		}
		this.proc = proc;
		// Without an 'error' listener a spawn failure (binary not on PATH) is an uncaught
		// exception that takes the whole runner down, not just this session.
		proc.on("error", (err: Error) => {
			if (this.proc !== proc) return; // stale: a newer turn owns the session now
			this.push(`[${this.config.clientType}] failed to start: ${err.message}`);
			this.run = "idle";
			this.proc = null;
			// The command itself is unrunnable — report the session dead so the loop stops with a
			// real reason instead of retrying a binary that does not exist.
			this.spawnFailed = true;
		});
		proc.stdout?.on("data", (d: Buffer) => this.onStdout(d.toString()));
		proc.stderr?.on("data", (d: Buffer) => this.onStdout(d.toString()));
		// The enforced ceiling (#391). `unref` so a pending timer can never keep the runner's
		// event loop alive past its own shutdown.
		const maxTurnMs = this.config.maxTurnMs ?? MAX_ONE_SHOT_TURN_MS;
		const ceiling = setTimeout(() => {
			if (this.proc !== proc) return; // a newer turn owns the session; this one is already gone
			this.push(`[${this.config.clientType} turn ended after ${Math.round(maxTurnMs / 60000)}m — the engine never exited, so the session was unwedged]`);
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		}, maxTurnMs);
		ceiling.unref();
		proc.on("close", (code: number | null) => {
			clearTimeout(ceiling); // cleared before the staleness guard: the timer belongs to THIS process
			// A non-zero exit is the engine's own failure (bad flags, not signed in) and the
			// operator needs to see it — silently going idle is how "stdin is not a terminal"
			// looked like an idle session for a whole afternoon.
			if (code) this.push(`[${this.config.clientType} exited with code ${code}]`);
			// STALENESS GUARD, matching the persistent path's. Without it, an older turn's
			// `close` clobbered the newer one: `run = "idle"` while process B was still working
			// (so the brain acted on a half-done turn and could double-send), and `proc = null`
			// so stop()/interrupt()/end() could no longer kill B — ending the session left a
			// codex process still editing the repo, invisible to `alive`, diagnostics and
			// kill-tmux.
			if (this.proc !== proc) return;
			this.run = "idle";
			this.proc = null;
		});
	}

	/**
	 * No TTY in headless mode; control is via messages. Kept for interface parity — the human
	 * takeover path can still route a keypress here.
	 *
	 * RECORDED rather than silently dropped. As a pure no-op it was indistinguishable from
	 * success: `act` returned an ordinary snapshot with an unchanged pane, so the caller could not
	 * tell "sent, nothing happened" from "never sent". The transcript is what the brain and the
	 * console both read, so the truth belongs there.
	 */
	key(keys: string): void {
		this.push(`[ignored keypress ${keys.slice(0, 40)} — this session has no terminal attached]`);
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

	/** Tear the process down. For a one-shot engine this is the ONLY thing that ends the session. */
	stop(): void {
		try {
			this.proc?.kill();
		} catch {
			/* ignore */
		}
		this.proc = null;
		this.run = "idle";
		this.stopped = true;
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
						this.noteAct(block);
					}
				}
				break;
			case "user": // tool results come back as a synthetic user message
				for (const block of ev.message?.content ?? []) {
					if (block.type === "tool_result") {
						this.push(`  ↳ ${toolResult(block.content)}`); // ↳
						this.settleAct(block);
					}
				}
				break;
			case "result": {
				if (ev.is_error) this.push(`[error] ${ev.result ?? ev.subtype ?? "failed"}`);
				// The same event that ends the turn also reports what the turn COST (#267). It was
				// parsed and thrown away, which is why Engine spend was absent from the ledger.
				// An errored turn still burned tokens, so this is recorded regardless of is_error.
				const usage = parseEngineUsage(ev, `${this.config.id}:${this.usageRunId}:${this.usageSeq++}`);
				if (usage) {
					this.pendingUsage.push(usage);
					if (this.pendingUsage.length > MAX_PENDING_USAGE) this.pendingUsage.shift();
				}
				// The turn ended, so no further `tool_result` is coming for anything still waiting.
				// Publish it with an UNKNOWN outcome rather than dropping it: "it ran this and we
				// never saw whether it worked" is a materially different claim from silence, and
				// silence is what a supervisor would read as "it did nothing".
				this.flushAwaitingActs();
				this.run = "idle"; // the turn is OVER — a fact, not a guess
				break;
			}
			default:
				break;
		}
		// Keep the in-memory transcript bounded.
		if (this.transcript.length > 4000) this.transcript = this.transcript.slice(-3000);
	}

	private push(line: string): void {
		this.transcript.push(line);
	}

	/**
	 * A `tool_use` block just went past — record it if the command it carries is consequential
	 * (#294). Nearly every call classifies to nothing and costs one regex sweep.
	 */
	private noteAct(block: Record<string, unknown>): void {
		const command = commandFromToolInput(block.input);
		if (!command) return;
		const toolUseId = typeof block.id === "string" && block.id ? block.id : `${this.config.id}:${this.actSeq++}`;
		const acts = classifyCommand(`${this.actsRunId}:${toolUseId}`, command);
		if (!acts.length) return;
		this.awaitingResult.set(toolUseId, acts);
	}

	/**
	 * The matching `tool_result` arrived — stamp the outcome and publish.
	 *
	 * The result carries more than the outcome: `gh pr create --fill` states its PR number nowhere
	 * but its own stdout, so an unnumbered `pr.open`/`pr.merge` takes it from here (#417). It is read
	 * from the RAW `block.content`, never from `toolResult()`'s display line — that truncates to 240
	 * characters for the transcript and would cut the URL off a verbose result.
	 *
	 * This path (and `noteAct`) is reachable ONLY from the structured stream-json handling above
	 * (`assistant` → `tool_use`, `user` → `tool_result`). A Codex/Grok session is a raw spawn with no
	 * such framing, so its PRs stay unattributed by construction; scraping its transcript instead
	 * would be the temporal guess `pull-attribution.ts` refuses.
	 */
	private settleAct(block: Record<string, unknown>): void {
		const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
		const acts = this.awaitingResult.get(id);
		if (!acts) return;
		this.awaitingResult.delete(id);
		const ok = block.is_error !== true;
		for (const a of fillTargetFromResult(acts, block.content)) this.publishAct({ ...a, ok });
	}

	/** Publish everything still waiting, with an unknown outcome. */
	private flushAwaitingActs(): void {
		for (const acts of this.awaitingResult.values()) {
			for (const a of acts) this.publishAct(a);
		}
		this.awaitingResult.clear();
	}

	private publishAct(act: EngineActRecord): void {
		// Drops the NEWEST at the cap — see MAX_PENDING_ACTS for why this queue is the opposite
		// way round from the usage one.
		if (this.pendingActs.length >= MAX_PENDING_ACTS) return;
		this.pendingActs.push(act);
	}

	/**
	 * Hand over the consequential acts seen since the last drain, and forget them (#294).
	 *
	 * Drained rather than re-reported for the same reason as {@link takeUsage}: a 3s capture poll
	 * must not re-send the same merge forever. The cloud's insert is keyed on
	 * {@link EngineActRecord.id}, so the genuine race — the console's poll and the Pilot's own
	 * capture draining at the same moment — still cannot write the act twice.
	 *
	 * A raw engine returns an empty array, always. Nothing parses its stdout, so it has nothing to
	 * hand over; an empty list here means "not observed", never "nothing happened".
	 */
	takeActs(): EngineActRecord[] {
		const out = this.pendingActs;
		this.pendingActs = [];
		return out;
	}

	/**
	 * Hand over the measured spend since the last drain, and forget it (#267).
	 *
	 * Draining rather than re-reporting keeps a 3s capture poll from re-sending the same rows
	 * forever; the cloud's insert is keyed on {@link EngineUsageRecord.id} and ignores conflicts,
	 * so the genuine race — two callers draining at once, or a retry — still cannot double-count.
	 *
	 * A raw engine returns an empty array here, always: nothing parses its stdout for usage, so
	 * there is nothing to hand over and the cloud writes no row for it.
	 */
	takeUsage(): EngineUsageRecord[] {
		const out = this.pendingUsage;
		this.pendingUsage = [];
		return out;
	}
}

/** Local wall-clock "HH:MM:SS" for transcript timestamps (runner is a Node process). */
function stamp(): string {
	return new Date().toTimeString().slice(0, 8);
}

/**
 * Split a launch command into bin + args, respecting single/double quotes — the way a shell
 * would, because that is what a user editing an engine preset is writing.
 *
 * Quotes are stripped wherever they appear in a token, not only when they wrap the whole thing.
 * The earlier alternation (`"…" | '…' | \S+`) only recognised a fully-quoted token, so
 * `-c model="o3"` reached the engine as the literal `model="o3"` and
 * `--append-system-prompt="be terse"` split at the space. A preset is free text; it has to
 * tokenize like the command line it looks like.
 */
export function parseCommand(command: string | undefined): { bin: string; args: string[] } {
	const src = command ?? "";
	const tokens: string[] = [];
	const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
	let i = 0;
	while (i < src.length) {
		while (i < src.length && isSpace(src[i])) i++;
		if (i >= src.length) break;
		const tokenStart = i;
		let out = "";
		while (i < src.length) {
			const ch = src[i];
			// A DOUBLE quote always opens a span — that is what `--flag "two words"` means and
			// what anyone typing this expects.
			//
			// A SINGLE quote opens one only at a token boundary (token start, or right after `=`),
			// because in ordinary English it is an apostrophe. This field is a preset text box, not
			// a shell: a real shell would pair the two apostrophes in `don't guess and don't stop`
			// and hand the engine `dont guess and dont` plus a stray `stop`, which is exactly the
			// mangling seen here. `--agent='my agent'` and `'my agent'` still work.
			const opens = ch === '"' || (ch === "'" && (i === tokenStart || src[i - 1] === "="));
			if (opens) {
				const close = src.indexOf(ch, i + 1);
				if (close !== -1) {
					out += src.slice(i + 1, close);
					i = close + 1;
					continue;
				}
				// Unterminated — the character is literal, not the start of a span.
				out += ch;
				i++;
				continue;
			}
			if (isSpace(ch)) break;
			out += ch;
			i++;
		}
		tokens.push(out);
	}
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
