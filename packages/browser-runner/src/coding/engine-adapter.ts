import type { ClientType } from "./handlers.js";

export type EngineMode = "stream-json" | "raw";

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

export const codexEngineAdapter: EngineAdapter = {
	mode: "stream-json",
	persistent: false,
	buildLaunchArgs: (userArgs) => [...userArgs],
	buildTurnArgs: buildCodexExecArgs,
	parseLine: parseCodexLine,
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
