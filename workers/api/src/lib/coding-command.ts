import type { CodingClientType } from "./coding-types.js";

// Finding the real engine binary in a preset's launch command. A leaf, so `coding-engines.ts`
// (which CLI is this) and `coding-engine-model.ts` (which model does it run) can both read a
// command the same way without importing each other.

/** Command wrappers to skip when finding the real engine binary in a launch command. */
const COMMAND_LAUNCHERS = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "bun", "env", "exec", "dlx", "run", "sudo", "time"]);

export function commandEngineParts(command: string): { bin: string; args: string[] } {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t || t.includes("=") || t.startsWith("-")) continue;
		const base = (t.split("/").pop() || "").toLowerCase();
		if (COMMAND_LAUNCHERS.has(base)) continue;
		return { bin: base, args: tokens.slice(i + 1) };
	}
	return { bin: "", args: [] };
}

/**
 * Derive the engine client type from a launch command's real binary — skipping
 * `FOO=bar` env prefixes and wrappers like `npx`/`bunx`/`env`. This decides whether
 * the runner uses the structured Claude engine (claude) or runs the CLI raw (else).
 * An unknown binary maps to "codex" so it runs RAW, not mis-driven as Claude.
 */
export function deriveClientType(command: string): CodingClientType {
	const { bin: base } = commandEngineParts(command);
	if (!base) return "claude";
	if (base === "claude" || base.startsWith("claude")) return "claude";
	if (base.startsWith("gemini")) return "gemini";
	if (base.startsWith("grok")) return "grok";
	if (base.startsWith("codex")) return "codex";
	return "codex"; // an unknown binary → run it raw (NOT as Claude stream-json)
}
