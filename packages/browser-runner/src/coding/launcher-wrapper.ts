/**
 * `pas mcp-auth exec -- <engine …>` (#1006, PAS #356) on the runner.
 *
 * The ProAppStore CLI runs a command with the owner's remote PAS MCP credential in that process's
 * environment only. So the runner must SPAWN the wrapper (it is what supplies the token) while
 * everything that understands an engine — the adapter choice (`codex exec` → structured), the turn
 * and resume argument builders, the engine-installed check — works on the ENGINE command after `--`.
 *
 * Matched exactly, as in the API (`workers/api/src/lib/coding-command.ts`) and the SDK
 * (`packages/sdk/src/engine-posture.ts`): `pas` followed by anything other than `mcp-auth exec --`
 * is not a wrapper, and stays the binary.
 */
export const PAS_MCP_AUTH_WRAPPER = ["mcp-auth", "exec", "--"] as const;

export interface UnwrappedCommand {
	/** The wrapper to spawn in front of the engine, e.g. `["pas", "mcp-auth", "exec", "--"]`; empty when none. */
	prefix: string[];
	/** The engine binary after the wrapper (or the command's own binary when there is no wrapper). */
	bin: string;
	args: string[];
}

export function unwrapLauncher(bin: string, args: readonly string[]): UnwrappedCommand {
	const isPas = (bin.split("/").pop() || "").toLowerCase() === "pas";
	if (!isPas || !PAS_MCP_AUTH_WRAPPER.every((t, k) => args[k] === t) || args.length <= PAS_MCP_AUTH_WRAPPER.length) {
		return { prefix: [], bin, args: [...args] };
	}
	const rest = args.slice(PAS_MCP_AUTH_WRAPPER.length);
	return { prefix: [bin, ...PAS_MCP_AUTH_WRAPPER], bin: rest[0], args: rest.slice(1) };
}

/** What to actually spawn: the wrapper (if any) carrying the engine and its built args. */
export function spawnTarget(prefix: readonly string[], bin: string, args: readonly string[]): { command: string; args: string[] } {
	return prefix.length ? { command: prefix[0], args: [...prefix.slice(1), bin, ...args] } : { command: bin, args: [...args] };
}
