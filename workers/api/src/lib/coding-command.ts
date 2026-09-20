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
