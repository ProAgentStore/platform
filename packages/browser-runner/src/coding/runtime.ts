import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultStatePath, HeadlessSession } from "./headless.js";
import type { ClientType } from "./handlers.js";
import { ensureRepo, sanitizeSessionName } from "./tmux.js";

/**
 * The coding runtime: the local "hands" that hold live tmux coding sessions, the
 * tmux counterpart of the browser runtime's Playwright page management.
 *
 * The remote brain (CodingSessionWorkflow) drives sessions through the
 * `/coding/*` HTTP surface: start a session, `capture` what the CLI shows, `act`
 * (send a message / keys), and `end`. A human can attach via the takeover
 * helpers (text frames + keystrokes) for the "stuck" handoff.
 *
 * Kept separate from `LocalRunner` (Playwright) so the two runtimes share the
 * runner harness — registration, tunnel, auth — without entangling their guts.
 */

export interface StartCodingInput {
	sessionId: string;
	repoId: string;
	clientType: ClientType;
	/** Explicit working dir (tests / already-cloned). When omitted, derived under the repos base dir. */
	workDir?: string;
	/** Clone source — fetched on first start if the working dir is absent. */
	cloneUrl?: string;
	branch?: string;
	/** GitHub App installation token for cloning private repos. */
	token?: string;
	env?: Record<string, string>;
	/** Override the agent binary (tests / a custom `claude` path). */
	bin?: string;
	/** The exact CLI launch command for this session's engine (e.g. `claude --dangerously-skip-permissions`, `codex`). */
	command?: string;
}

export type CodingAction =
	| { kind: "message"; text: string }
	| { kind: "keys"; keys: string }
	| { kind: "interrupt" };

export interface CodingSnapshot {
	sessionId: string;
	pane: string;
	ready: boolean;
	runState: "idle" | "thinking" | "responding";
	alive: boolean;
}

/** Hard cap on a pane returned to the brain/console (matches the worker MAX_PANE_CHARS). */
const MAX_PANE = 64 * 1024;

export class CodingRuntime {
	private sessions = new Map<string, HeadlessSession>();
	/**
	 * Active human handoffs keyed by session id. `resolved` flips when the human
	 * finishes (console "Resume" / submits a value); the brain workflow polls
	 * {@link takeoverStatus} and continues once it does — the tmux analogue of the
	 * browser runtime's handoff-status machinery.
	 */
	private takeovers = new Map<string, { reason: string; label: string; resolved: boolean; value?: string }>();

	/** Base directory under which repos are cloned (one subdir per repo). */
	constructor(private readonly reposBaseDir: string = join(homedir(), ".config", "proagentstore", "repos")) {}

	/** Capabilities advertised to PAGS at registration. */
	static capabilities(): string[] {
		return ["coding.sessions", "coding.stream", "human.takeover"];
	}

	static taskTypes(): string[] {
		return ["coding.session"];
	}

	/** Start (or return the existing) session and report its first snapshot. */
	start(input: StartCodingInput): CodingSnapshot {
		let session = this.sessions.get(input.sessionId);
		if (!session) {
			// Resolve the working dir and ensure the repo is present (clone on first
			// start). A user-supplied local path may use ~ — expand it; otherwise
			// clone into a managed dir. Without this the CLI would launch nowhere.
			const workDir = input.workDir
				? resolve(input.workDir.replace(/^~(?=$|\/)/, homedir()))
				: join(this.reposBaseDir, sanitizeSessionName(input.repoId));
			ensureRepo(workDir, { cloneUrl: input.cloneUrl, branch: input.branch, token: input.token });
			session = new HeadlessSession({
				id: input.sessionId,
				workDir,
				clientType: input.clientType,
				command: input.command,
				env: input.env,
				statePath: defaultStatePath(this.reposBaseDir),
				bin: input.bin,
			});
			this.sessions.set(input.sessionId, session);
		}
		session.start();
		return this.snapshot(input.sessionId);
	}

	/** The pane the brain reasons over + the inferred run state. */
	snapshot(sessionId: string): CodingSnapshot {
		const session = this.require(sessionId);
		const alive = session.alive;
		const pane = alive ? clip(session.snapshot()) : "";
		return {
			sessionId,
			pane,
			alive,
			ready: alive ? session.ready : false,
			runState: alive ? session.runState() : "idle",
		};
	}

	/** Perform one action, then return the fresh snapshot (non-blocking, like browser act). */
	act(sessionId: string, action: CodingAction): CodingSnapshot {
		const session = this.require(sessionId);
		switch (action.kind) {
			case "message":
				session.input(action.text);
				break;
			case "keys":
				session.key(action.keys);
				break;
			case "interrupt":
				session.interrupt();
				break;
			default:
				throw new Error(`Unknown coding action: ${(action as { kind: string }).kind}`);
		}
		return this.snapshot(sessionId);
	}

	/** Tear down a session. */
	end(sessionId: string): { ok: true } {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.stop();
			this.sessions.delete(sessionId);
		}
		this.takeovers.delete(sessionId);
		return { ok: true };
	}

	list(): Array<{ sessionId: string; alive: boolean; tmuxSession: string }> {
		return [...this.sessions.entries()].map(([sessionId, s]) => ({
			sessionId,
			alive: s.alive,
			tmuxSession: s.sessionName,
		}));
	}

	/** Rich diagnostics for every tracked session — the console's transparency view. */
	diagnostics(): Array<{
		sessionId: string;
		tmuxSession: string;
		alive: boolean;
		runState: "idle" | "thinking" | "responding";
		ready: boolean;
		paneLines: number;
		clientType: string;
		workDir: string;
		takeover: boolean;
	}> {
		return [...this.sessions.entries()].map(([sessionId, s]) => ({
			sessionId,
			tmuxSession: s.sessionName,
			alive: s.alive,
			runState: s.alive ? s.runState() : "idle",
			ready: s.alive ? s.ready : false,
			paneLines: s.alive ? (s.snapshot().split("\n").length) : 0,
			clientType: s.config.clientType,
			workDir: s.config.workDir,
			takeover: this.takeovers.has(sessionId),
		}));
	}

	// ── Human takeover (the "stuck" handoff) ────────────────────────────────
	// A text-frame equivalent of the browser takeover: the console shows the live
	// pane and forwards the human's keystrokes until they Resume.

	/** Begin a handoff (the brain calls this with why it's pausing). */
	beginTakeover(sessionId: string, opts: { reason?: string; label?: string } = {}): CodingSnapshot {
		this.require(sessionId);
		this.takeovers.set(sessionId, { reason: opts.reason ?? "stuck", label: opts.label ?? "this step", resolved: false });
		return this.snapshot(sessionId);
	}

	takeoverFrame(sessionId: string): CodingSnapshot {
		return this.snapshot(sessionId);
	}

	/** Forward a human keystroke/message during takeover. */
	takeoverInput(sessionId: string, value: { text?: string; keys?: string }): CodingSnapshot {
		const session = this.require(sessionId);
		if (value.keys) session.key(value.keys);
		else if (value.text != null) session.input(value.text);
		return this.snapshot(sessionId);
	}

	/** The human finished — mark resolved so the brain workflow can resume. */
	resolveTakeover(sessionId: string, value?: string): { ok: true } {
		const t = this.takeovers.get(sessionId);
		if (t) {
			t.resolved = true;
			t.value = value;
		}
		return { ok: true };
	}

	/**
	 * Polled by the brain workflow: has the human resolved the handoff? Defaults to
	 * NOT resolved when there's no live entry — if the runner restarted mid-handoff
	 * we must NOT auto-resume (the brain would proceed without the value it was told
	 * to wait for); the workflow's poll loop times out safely instead.
	 */
	takeoverStatus(sessionId: string): { resolved: boolean; value?: string } {
		const t = this.takeovers.get(sessionId);
		return { resolved: t?.resolved ?? false, value: t?.value };
	}

	endTakeover(sessionId: string): { ok: true } {
		this.takeovers.delete(sessionId);
		return { ok: true };
	}

	isUnderTakeover(sessionId: string): boolean {
		return this.takeovers.has(sessionId);
	}

	/** Stop every session (runner shutdown). */
	closeAll(): void {
		for (const s of this.sessions.values()) s.stop();
		this.sessions.clear();
		this.takeovers.clear();
	}

	/** True if any session this runtime owns still has a live agent process. */
	hasLiveSessions(): boolean {
		return [...this.sessions.values()].some((s) => s.alive);
	}

	private require(sessionId: string): HeadlessSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`No coding session: ${sessionId}`);
		return session;
	}
}

function clip(pane: string): string {
	return pane.length > MAX_PANE ? pane.slice(pane.length - MAX_PANE) : pane;
}
