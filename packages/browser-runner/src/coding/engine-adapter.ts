import type { ClientType } from "./handlers.js";
import { stripAnsi } from "./transcript-lines.js";

export type EngineMode = "stream-json" | "raw";
export type EngineInvocationMode = "structured" | "raw";

export type NormalizedEngineEvent =
	| { kind: "session"; sessionId: string }
	| { kind: "assistant_text"; text: string }
	| { kind: "tool_use"; block: Record<string, unknown>; id: string; name: string; input: unknown }
	| { kind: "tool_result"; block: Record<string, unknown>; toolUseId: string; content: unknown }
	| { kind: "turn_end"; raw: Record<string, unknown>; isError: boolean; result: string };

export interface EngineAdapter {
	readonly mode: EngineMode;
	readonly persistent: boolean;
	buildLaunchArgs(userArgs: string[], resumeId: string | null): string[];
	buildTurnArgs(userArgs: string[], turnText: string): string[];
	parseLine(line: string): NormalizedEngineEvent[];
	/** Identifies an unsupported structured-output flag before a one-shot retry. */
	rejectsStructuredOutput?(line: string): boolean;
}

export function engineInvocationModeFromAdapter(mode: EngineMode): EngineInvocationMode {
	return mode === "stream-json" ? "structured" : "raw";
}

export function structuredCapableEngine(clientType: ClientType): boolean {
	return clientType === "claude" || clientType === "codex";
}

export function engineInvocationWarning(clientType: ClientType, mode: EngineInvocationMode): string | null {
	if (mode !== "raw" || !structuredCapableEngine(clientType)) return null;
	return `running raw — structured not available on this machine's ${clientType} CLI`;
}

const RESERVED_CLAUDE_FLAGS = new Set(["-p", "--print", "--input-format", "--output-format", "--verbose", "--resume"]);

/** Structural flags PAGS owns for Claude's stream-json engine. */
export function buildClaudeArgs(userArgs: string[], resumeId: string | null): string[] {
	const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
	for (let i = 0; i < userArgs.length; i++) {
		const a = userArgs[i];
		if (RESERVED_CLAUDE_FLAGS.has(a)) {
			if (i + 1 < userArgs.length && !userArgs[i + 1].startsWith("-")) i++;
			continue;
		}
		args.push(a);
	}
	if (!args.includes("--dangerously-skip-permissions")) args.push("--dangerously-skip-permissions");
	if (resumeId) args.push("--resume", resumeId);
	return args;
}

function record(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function contentBlocks(ev: Record<string, unknown>): Record<string, unknown>[] {
	const message = record(ev.message);
	const content = Array.isArray(message?.content) ? message.content : [];
	return content.flatMap((block) => {
		const r = record(block);
		return r ? [r] : [];
	});
}

function parseClaudeLine(line: string): NormalizedEngineEvent[] {
	let ev: Record<string, unknown>;
	try {
		const parsed = JSON.parse(line);
		const parsedRecord = record(parsed);
		if (!parsedRecord) return [];
		ev = parsedRecord;
	} catch {
		return [];
	}

	const type = typeof ev.type === "string" ? ev.type : "";
	switch (type) {
		case "system": {
			if (ev.subtype === "init" && typeof ev.session_id === "string" && ev.session_id) return [{ kind: "session", sessionId: ev.session_id }];
			return [];
		}
		case "assistant":
			return contentBlocks(ev).flatMap((block): NormalizedEngineEvent[] => {
				if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return [{ kind: "assistant_text", text: block.text.trim() }];
				if (block.type !== "tool_use") return [];
				const name = String(block.name ?? "tool");
				return [
					{
						kind: "tool_use",
						block,
						id: typeof block.id === "string" ? block.id : "",
						name,
						input: block.input,
					},
				];
			});
		case "user":
			return contentBlocks(ev).flatMap((block): NormalizedEngineEvent[] => {
				if (block.type !== "tool_result") return [];
				return [
					{
						kind: "tool_result",
						block,
						toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
						content: block.content,
					},
				];
			});
		case "result": {
			const result = typeof ev.result === "string" ? ev.result : typeof ev.subtype === "string" ? ev.subtype : "failed";
			return [{ kind: "turn_end", raw: ev, isError: ev.is_error === true, result }];
		}
		default:
			return [];
	}
}

export const claudeEngineAdapter: EngineAdapter = {
	mode: "stream-json",
	persistent: true,
	buildLaunchArgs: buildClaudeArgs,
	buildTurnArgs: (userArgs, turnText) => [...userArgs, turnText],
	parseLine: parseClaudeLine,
};

function hasFlag(args: string[], flag: string): boolean {
	return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

function buildCodexExecArgs(userArgs: string[], turnText: string): string[] {
	const args = [...userArgs];
	if (!hasFlag(args, "--json")) args.splice(1, 0, "--json");
	args.push(turnText);
	return args;
}

/**
 * The only supported runner-owned Codex continuity form (#848).
 *
 * `exec resume` takes the thread id between the subcommand and the prompt, so it cannot use the
 * normal preset-prefix-plus-final-prompt contract. Its write flag is deliberately not inherited
 * from a fresh `exec`: resume accepts the bypass flag but does not accept `--sandbox <mode>`.
 * This remains an opaque, machine-local optimisation until #693's platform timeline owns the
 * conversation; it must never select a conversation with `--last`.
 */
export function buildCodexResumeArgs(userArgs: string[], threadId: string, turnText: string): string[] {
	const extras: string[] = [];
	for (let i = 1; i < userArgs.length; i++) {
		const arg = userArgs[i];
		if (arg === "--json" || arg === "--dangerously-bypass-approvals-and-sandbox") continue;
		if (arg === "--sandbox") {
			i++;
			continue;
		}
		if (arg.startsWith("--sandbox=")) continue;
		extras.push(arg);
	}
	return ["exec", "resume", threadId, "--json", "--dangerously-bypass-approvals-and-sandbox", ...extras, turnText];
}

function parseCodexLine(line: string): NormalizedEngineEvent[] {
	let ev: Record<string, unknown>;
	try {
		const parsed = JSON.parse(line);
		const parsedRecord = record(parsed);
		if (!parsedRecord) return [];
		ev = parsedRecord;
	} catch {
		return [];
	}

	const type = typeof ev.type === "string" ? ev.type : "";
	const item = record(ev.item);
	if (type === "thread.started" && typeof ev.thread_id === "string" && ev.thread_id) return [{ kind: "session", sessionId: ev.thread_id }];
	if (type === "turn.completed" || type === "turn.failed") {
		const result =
			typeof ev.error === "string" ? ev.error : typeof ev.message === "string" ? ev.message : type === "turn.failed" ? "failed" : "";
		return [{ kind: "turn_end", raw: ev, isError: type === "turn.failed", result }];
	}
	if (!item) return [];

	const itemType = typeof item.type === "string" ? item.type : "";
	if (type === "item.completed" && itemType === "agent_message" && typeof item.text === "string" && item.text.trim()) {
		return [{ kind: "assistant_text", text: item.text.trim() }];
	}
	if (itemType !== "command_execution") return [];

	const id = typeof item.id === "string" ? item.id : "";
	const command = typeof item.command === "string" ? item.command : "";
	const block = type === "item.completed"
		? {
				type: "tool_result",
				tool_use_id: id,
				is_error: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0),
				content: typeof item.aggregated_output === "string" ? item.aggregated_output : "",
			}
		: {
				type: "tool_use",
				id,
				name: "Bash",
				input: { command },
			};

	if (type === "item.completed") {
		return [{ kind: "tool_result", block, toolUseId: id, content: block.content }];
	}
	if (type === "item.started" && command) return [{ kind: "tool_use", block, id, name: "Bash", input: { command } }];
	return [];
}

/**
 * An older Codex CLI exits before doing work when it does not know `--json`. Do not treat every
 * plain line as a downgrade signal: current Codex can interleave malformed/tool stderr with valid
 * JSONL, and retrying after that could run a real instruction twice.
 */
function codexRejectsJson(line: string): boolean {
	const plain = stripAnsi(line).toLowerCase();
	if (!plain.includes("--json")) return false;
	return /(?:unexpected argument|unknown (?:argument|option)|unrecognized (?:argument|option)|invalid option)/.test(plain);
}

export const codexEngineAdapter: EngineAdapter = {
	mode: "stream-json",
	persistent: false,
	buildLaunchArgs: (userArgs) => [...userArgs],
	buildTurnArgs: buildCodexExecArgs,
	parseLine: parseCodexLine,
	rejectsStructuredOutput: codexRejectsJson,
};

export const genericRawEngineAdapter: EngineAdapter = {
	mode: "raw",
	persistent: false,
	buildLaunchArgs: (userArgs) => [...userArgs],
	buildTurnArgs: (userArgs, turnText) => [...userArgs, turnText],
	parseLine: () => [],
};

export function engineAdapterFor(clientType: ClientType, userArgs: string[] = []): EngineAdapter {
	if (clientType === "claude") return claudeEngineAdapter;
	if (clientType === "codex" && userArgs[0] === "exec" && !["resume", "fork", "review", "help"].includes(userArgs[1] ?? "")) return codexEngineAdapter;
	return genericRawEngineAdapter;
}
