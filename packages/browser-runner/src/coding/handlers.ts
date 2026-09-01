/**
 * Per-CLI facts the coding runtime needs before it can spawn an engine.
 *
 * This file used to carry pane heuristics too — `isReady` / `isProcessing` / `extractResponse` /
 * `completion`, ported from AgentCoder's `bridge/src/agents/handlers/*` — which answered
 * "is it ready for input?" by matching strings a vendor prints in its TUI. They died with the
 * tmux backend (commit c94642f): a session is a child process now, so Claude's turn boundary is a
 * `result` event and a raw engine's is process exit. Nothing had called them since, and keeping
 * them left a live-looking `pane.includes("ctrl+c to interrupt")` one vendor release away from
 * being silently wrong — for anyone who wired it back up believing it worked.
 *
 * What remains is data: which binary this engine is, and which env var carries its key.
 */

export type ClientType = "claude" | "gemini" | "codex" | "grok" | "generic";

export interface AgentHandler {
	readonly clientType: ClientType;
	/**
	 * The command that launches this CLI when the session arrives with none of its own.
	 *
	 * Must be the NON-INTERACTIVE form, and must let the engine write. The cloud's
	 * `DEFAULT_ENGINES` presets (`workers/api/src/lib/coding-engines.ts`) are authoritative and
	 * carry these same flags with the full reasoning; this fallback only fires when a session is
	 * started with no command at all — an older cloud, or a preset saved blank. It said `codex` /
	 * `grok` / `gemini`, which is exactly the interactive form those presets exist to avoid: with
	 * no PTY the engine dies on "stdin is not a terminal", and even reaching the model it would
	 * inherit a read-only sandbox and explore the repo without ever editing it.
	 */
	readonly cliCommand: string;
	/** Env var the CLI reads its API key from (empty for generic). */
	readonly envVar: string;
}

const HANDLERS: Record<ClientType, AgentHandler> = {
	claude: { clientType: "claude", cliCommand: "claude --dangerously-skip-permissions", envVar: "ANTHROPIC_API_KEY" },
	gemini: { clientType: "gemini", cliCommand: "gemini --approval-mode yolo --skip-trust --prompt", envVar: "GEMINI_API_KEY" },
	codex: { clientType: "codex", cliCommand: "codex exec --json --sandbox danger-full-access", envVar: "OPENAI_API_KEY" },
	grok: { clientType: "grok", cliCommand: "grok --permission-mode bypassPermissions -p", envVar: "XAI_API_KEY" },
	generic: { clientType: "generic", cliCommand: "bash", envVar: "" },
};

export function handlerFor(clientType: ClientType): AgentHandler {
	return HANDLERS[clientType] ?? HANDLERS.generic;
}
