/**
 * Can this engine preset actually change files? — pure, framework-free, no imports.
 *
 * Every coding CLI defaults to read-only or ask-first when run non-interactively, and headless
 * mode has no TTY to approve with. `codex exec` shipped without `--sandbox`, so it inherited
 * `sandbox: read-only`: the engine explored the repo, reasoned well, wrote a good explanation, and
 * could not change a byte — not even `git pull`. Nothing failed loudly, which is why the preset
 * editor has to say so as you type.
 *
 * This mirrors `ENGINE_WRITE_FLAGS` in `workers/api/src/lib/coding-engines.ts`, which is the
 * authority for what the platform SHIPS as a default. The duplication is deliberate and small:
 * the worker has no dependency on this package, and a hint that needs a round-trip per keystroke
 * is not a hint. See `docs/coding-engines.md`.
 */

/** Command wrappers to skip when finding the real engine binary (mirrors the API's list). */
const LAUNCHERS = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "bun", "env", "exec", "dlx", "run", "sudo", "time"]);

/** The engine's real binary name, skipping `FOO=bar` prefixes and wrappers like `npx`. */
export function engineBin(command: string): string {
	return engineParts(command).bin;
}

function engineParts(command: string): { bin: string; args: string[] } {
	const tokens = (command ?? "").trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t || t.includes("=") || t.startsWith("-")) continue;
		const base = (t.split("/").pop() || "").toLowerCase();
		if (LAUNCHERS.has(base)) continue;
		return { bin: base, args: tokens.slice(i + 1) };
	}
	return { bin: "", args: [] };
}

/** Whether a preset's binary is driven as Claude (persistent stream-json) or run raw. */
export function isClaudeEngine(command: string): boolean {
	const base = engineBin(command);
	return !base || base.startsWith("claude");
}

export type EngineInvocationMode = "structured" | "raw";

const CODEX_RAW_SUBCOMMANDS = new Set(["resume", "fork", "review", "help"]);

/** Whether this editable preset will be driven through structured events or plain stdout. */
export function engineInvocationMode(command: string): EngineInvocationMode | null {
	if (!command.trim()) return null;
	const { bin, args } = engineParts(command);
	if (!bin || bin.startsWith("claude")) return "structured";
	if (bin.startsWith("codex") && args[0] === "exec" && !CODEX_RAW_SUBCOMMANDS.has(args[1] ?? "")) return "structured";
	return "raw";
}

const WRITE_FLAGS: Record<string, { accepts: string[]; suggest: string }> = {
	// `danger-full-access` rather than `workspace-write`: workspace-write also blocks network, so
	// `git pull`, `pnpm install` and `gh pr create` would still fail, just less obviously.
	codex: { accepts: ["--sandbox", "--dangerously-bypass-approvals-and-sandbox"], suggest: "--sandbox danger-full-access" },
	gemini: { accepts: ["--approval-mode", "--yolo", "-y"], suggest: "--approval-mode yolo" },
	grok: { accepts: ["--permission-mode", "--always-approve"], suggest: "--permission-mode bypassPermissions" },
	claude: { accepts: ["--dangerously-skip-permissions", "--permission-mode"], suggest: "--dangerously-skip-permissions" },
};

/**
 * The flag to add when a preset would launch an engine that cannot write — else null.
 *
 * Returns null for an engine it does not recognise (a local model, a custom wrapper): those have
 * no permission concept, and a false warning on every custom preset trains people to ignore the
 * real one.
 */
export function missingWriteFlag(command: string): string | null {
	const spec = WRITE_FLAGS[engineBin(command)];
	if (!spec) return null;
	return spec.accepts.some((f) => command.includes(f)) ? null : spec.suggest;
}
