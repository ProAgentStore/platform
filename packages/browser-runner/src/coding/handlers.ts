/**
 * Per-CLI behaviour for the coding runtime.
 *
 * Each AI coding CLI renders its TUI differently, so "is it ready for input?",
 * "is it still working?", and "where does its answer start/end in the pane?" are
 * CLI-specific. These handlers encapsulate that, ported from the AgentCoder
 * `bridge/src/agents/handlers/*`. A `generic` shell handler is included so the
 * runtime (and tests) can drive a plain shell deterministically.
 */

export type ClientType = "claude" | "gemini" | "codex" | "grok" | "generic";

export interface CompletionConfig {
	/** Minimum wait after first seeing a prompt before declaring done (ms). */
	minWait?: number;
	/** Idle time with stable output before declaring done (ms). */
	stableThreshold: number;
	/** Hard cap — force completion even if no prompt detected (ms). */
	forceCompleteAfter: number;
	/** Poll cadence (ms). */
	pollInterval: number;
}

export interface AgentHandler {
	readonly clientType: ClientType;
	/** Command that launches the CLI inside the tmux pane. */
	readonly cliCommand: string;
	/** Env var the CLI reads its API key from (empty for generic). */
	readonly envVar: string;
	isReady(pane: string): boolean;
	isProcessing(pane: string): boolean;
	extractResponse(captured: string, userInput: string): string;
	completion(): CompletionConfig;
}

/** Shared "find the user's input line, return everything after it up to the next prompt". */
function sliceAfterInput(captured: string, userInput: string, isPromptLine: (line: string) => boolean): string {
	const lines = captured.split("\n");
	const needle = userInput.slice(0, 25);
	let start = -1;
	if (needle) {
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].includes(needle)) {
				start = i;
				break;
			}
		}
	}
	if (start === -1) return lines.slice(-200).join("\n").trim();
	let end = lines.length;
	for (let i = lines.length - 1; i > start; i--) {
		if (isPromptLine(lines[i].trim())) {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n").trim();
}

export class ClaudeHandler implements AgentHandler {
	readonly clientType = "claude" as const;
	readonly cliCommand = "claude --dangerously-skip-permissions";
	readonly envVar = "ANTHROPIC_API_KEY";

	isProcessing(pane: string): boolean {
		return pane.includes("ctrl+c to interrupt") || /Working|Thinking|Reading|Searching|Running|Editing|Writing/.test(pane);
	}

	isReady(pane: string): boolean {
		if (this.isProcessing(pane)) return false;
		const tail = pane.split("\n").slice(-15).join("\n");
		return (
			tail.includes("bypass permissions") ||
			tail.includes("? for shortcuts") ||
			/❯\s*$/.test(tail) ||
			/❯ .*↵ send/.test(tail)
		);
	}

	extractResponse(captured: string, userInput: string): string {
		return sliceAfterInput(captured, userInput, (l) => l === "❯" || l.startsWith("❯ "));
	}

	completion(): CompletionConfig {
		return { minWait: 1000, stableThreshold: 0, forceCompleteAfter: 5 * 60 * 1000, pollInterval: 500 };
	}
}

export class GeminiHandler implements AgentHandler {
	readonly clientType = "gemini" as const;
	readonly cliCommand = "gemini";
	readonly envVar = "GEMINI_API_KEY";

	isProcessing(pane: string): boolean {
		return /thinking|processing|generating|working|loading/i.test(pane);
	}

	isReady(pane: string): boolean {
		const last = pane.split("\n").slice(-1)[0]?.trim() ?? "";
		const hasPrompt = /[>$]\s*$/.test(last) || /^>/.test(last);
		return hasPrompt && !this.isProcessing(pane);
	}

	extractResponse(captured: string, userInput: string): string {
		return sliceAfterInput(captured, userInput, (l) => /^[>$]\s*$/.test(l) || /^[>$]\s+\S/.test(l));
	}

	completion(): CompletionConfig {
		return { stableThreshold: 1500, forceCompleteAfter: 5 * 60 * 1000, pollInterval: 500 };
	}
}

/** Codex / Grok render close enough to a generic prompt; reuse the shell heuristics. */
export class GenericHandler implements AgentHandler {
	constructor(
		readonly clientType: ClientType = "generic",
		readonly cliCommand = "bash",
		readonly envVar = "",
	) {}

	isProcessing(pane: string): boolean {
		const last = pane.split("\n").slice(-1)[0]?.trim() ?? "";
		return /\.\.\.$/.test(last);
	}

	isReady(pane: string): boolean {
		const last = pane.split("\n").slice(-1)[0]?.trim() ?? "";
		// A shell prompt ends in $, #, >, or %  (optionally followed by a cursor space).
		return /[$#>%]\s*$/.test(last) && !this.isProcessing(pane);
	}

	extractResponse(captured: string, userInput: string): string {
		return sliceAfterInput(captured, userInput, (l) => /[$#>%]\s*$/.test(l));
	}

	completion(): CompletionConfig {
		return { stableThreshold: 800, forceCompleteAfter: 60 * 1000, pollInterval: 300 };
	}
}

const HANDLERS: Record<ClientType, AgentHandler> = {
	claude: new ClaudeHandler(),
	gemini: new GeminiHandler(),
	codex: new GenericHandler("codex", "codex", "OPENAI_API_KEY"),
	grok: new GenericHandler("grok", "grok", "XAI_API_KEY"),
	generic: new GenericHandler(),
};

export function handlerFor(clientType: ClientType): AgentHandler {
	return HANDLERS[clientType] ?? HANDLERS.generic;
}
