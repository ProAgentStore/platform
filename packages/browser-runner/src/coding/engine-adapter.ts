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
	buildLaunchArgs(userArgs: string[], resumeId: string | null): string[];
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
	buildLaunchArgs: buildClaudeArgs,
	parseLine: parseClaudeLine,
};

export const genericRawEngineAdapter: EngineAdapter = {
	mode: "raw",
	buildLaunchArgs: (userArgs) => [...userArgs],
	parseLine: () => [],
};

export function engineAdapterFor(clientType: ClientType): EngineAdapter {
	return clientType === "claude" ? claudeEngineAdapter : genericRawEngineAdapter;
}
