import {
	capturePane,
	createSession,
	killSession,
	paneTarget,
	sanitizeSessionName,
	sendKey,
	sendText,
	sessionExists,
} from "./tmux.js";
import { type ClientType, handlerFor } from "./handlers.js";

/** Called with the current pane snapshot as it streams; `done` marks the final frame. */
export type StreamCallback = (content: string, done: boolean) => void | Promise<void>;

export interface CodingSessionConfig {
	/** Stable id (e.g. repo id) used to derive the tmux session name. */
	id: string;
	/** Working directory the CLI launches in (the cloned repo). */
	workDir: string;
	clientType: ClientType;
	/** Extra env injected when launching the CLI (e.g. the BYOK key). */
	env?: Record<string, string>;
}

/**
 * One AI-coding-CLI session living in a tmux pane.
 *
 * This is the coding runtime's analogue of a Playwright `Page`: the unit the
 * remote brain "sees" (via {@link snapshot}) and "acts on" (via {@link send}),
 * and the unit a human attaches to during takeover. The brain/hands split and
 * the streaming-until-idle loop mirror the browser runtime exactly — only the
 * mechanism (tmux send-keys + capture-pane) differs.
 */
export class CodingSession {
	readonly sessionName: string;
	private readonly target: string;
	private readonly handler;

	constructor(readonly config: CodingSessionConfig) {
		this.sessionName = sanitizeSessionName(`pags-${config.clientType}-${config.id}`);
		this.target = paneTarget(this.sessionName);
		this.handler = handlerFor(config.clientType);
	}

	/** True if the underlying tmux session is alive. */
	get alive(): boolean {
		return sessionExists(this.sessionName);
	}

	/** Launch the CLI inside a fresh tmux session. Idempotent if already alive. */
	start(): void {
		if (this.alive) return;
		// Launch a shell first so we can export the BYOK env, then exec the CLI.
		createSession(this.sessionName, this.config.workDir);
		if (this.config.env) {
			for (const [k, v] of Object.entries(this.config.env)) {
				// Use printf-safe assignment; values never reach a shell as code because
				// we send them as a single literal then press Enter.
				sendText(this.target, `export ${k}=${JSON.stringify(v)}`);
				sendKey(this.target, "Enter");
			}
		}
		if (this.handler.cliCommand && this.handler.cliCommand !== "bash") {
			sendText(this.target, this.handler.cliCommand);
			sendKey(this.target, "Enter");
		}
	}

	/** The pane content the brain reasons over (the "snapshot"). */
	snapshot(lines = 200): string {
		return capturePane(this.target, lines);
	}

	/** True when the CLI is idle and ready for the next message. */
	get ready(): boolean {
		return this.handler.isReady(this.snapshot());
	}

	/** Send a raw key (Enter, Escape, C-c) — used by takeover and control flows. */
	key(name: string): void {
		sendKey(this.target, name);
	}

	/**
	 * Submit a message to the CLI without waiting for the reply (text + Enter).
	 * The brain-driven loop calls this, then polls {@link snapshot}/{@link ready}
	 * until idle — the tmux analogue of the browser runtime's non-blocking act.
	 */
	input(text: string): void {
		sendText(this.target, text);
		sendKey(this.target, "Enter");
	}

	/** Interrupt the current run (Ctrl-C), e.g. to stop a runaway CLI. */
	interrupt(): void {
		sendKey(this.target, "C-c");
	}

	/** Current run-state inferred from the pane: idle / thinking / responding. */
	runState(): "idle" | "thinking" | "responding" {
		const pane = this.snapshot();
		if (this.handler.isProcessing(pane)) {
			return pane.includes("ctrl+c to interrupt") ? "responding" : "thinking";
		}
		return this.handler.isReady(pane) ? "idle" : "thinking";
	}

	/**
	 * Send a message to the CLI and resolve with its extracted response once the
	 * pane goes idle. Streams intermediate frames through `onStream`.
	 *
	 * The completion heuristic is the same staged one AgentCoder proved against
	 * real CLIs: wait for "processing" to appear, then for the prompt to return
	 * and output to stabilise, with a hard timeout backstop.
	 */
	async send(message: string, onStream?: StreamCallback): Promise<string> {
		sendText(this.target, message);
		sendKey(this.target, "Enter");

		const cfg = this.handler.completion();
		const startedAt = Date.now();
		const hardCap = 5 * 60 * 1000;
		let sawProcessing = false;
		let lastContent = "";
		let lastChange = Date.now();
		let lastEmit = 0;
		const emitThrottle = 300;

		while (Date.now() - startedAt < hardCap) {
			await delay(cfg.pollInterval);
			if (!this.alive) break;
			const pane = this.snapshot(5000);
			const ready = this.handler.isReady(pane);
			const processing = this.handler.isProcessing(pane);

			if (onStream) {
				const partial = this.handler.extractResponse(pane, message);
				if (partial && partial !== lastContent) {
					lastChange = Date.now();
					if (Date.now() - lastEmit >= emitThrottle) {
						lastContent = partial;
						lastEmit = Date.now();
						await onStream(partial, false);
					}
				}
			}

			if (processing || !ready) {
				sawProcessing = true;
				lastChange = Date.now();
				continue;
			}

			const idle = Date.now() - lastChange;
			const elapsed = Date.now() - startedAt;
			if (cfg.minWait !== undefined) {
				if (ready && elapsed > (sawProcessing ? 0 : cfg.minWait)) break;
			} else {
				if (ready && sawProcessing && idle >= cfg.stableThreshold) break;
				if (ready && elapsed > 2000) break;
				if (elapsed >= cfg.forceCompleteAfter) break;
			}
		}

		const finalPane = this.snapshot(5000);
		const response = this.handler.extractResponse(finalPane, message);
		if (onStream) await onStream(response, true);
		return response;
	}

	/** Tear down the tmux session. */
	stop(): void {
		killSession(this.sessionName);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
