import { spawnSync } from "node:child_process";
import { unwrapLauncher } from "./launcher-wrapper.js";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handlerFor, type ClientType } from "./handlers.js";
import { parseCommand } from "./headless.js";
import { type EngineSpawn, type EngineSpawnDeps, resolveEngineSpawn } from "./engine-spawn.js";

/**
 * Can this machine run an engine at all — BEFORE a session is launched on it (#879)?
 *
 * Without this, a coder re-pointed at an engine the machine does not have died after launch: the
 * spawn failed with ENOENT, or the CLI started and stopped on "please log in", and the cloud learned
 * about it only from the dead pane (#882). For a session start that is a bad error; for apply-now,
 * which ENDS a working session before starting the new one, it is a working coder replaced by a dead
 * one. The cloud asks this first and refuses with the engine's name instead.
 *
 * Two facts, each three-valued, because a false "missing" would refuse a machine that works:
 *
 *   binary — found on the PATH `pags up` spawns with, by the same resolution the spawn uses
 *            (`resolveEngineSpawn` — on Windows, an npm shim's real target; #1044), or not.
 *   login  — the engine's own INTERACTIVE subscription login is stored on this machine (`found`),
 *            definitely is not (`missing`), or this build cannot tell (`unknown`). Only a
 *            definite `missing` is ever grounds for refusal.
 *
 * **Subscription login only, presence only.** An API key in the environment is deliberately NOT
 * counted as a login: engines here run on the owner's subscription, and every sign-in mode but
 * `api-key` strips provider keys before spawning (`resolveEngineEnv`), so a key would not be what
 * the engine reads anyway. Nothing here reads, returns or logs a credential's value — a file's
 * existence, or the keychain's exit code for an item's existence, is all that is consulted.
 */
export interface EngineCheck {
	checked: true;
	engine: ClientType;
	/** The executable the session would spawn (first token of the command). */
	bin: string;
	binaryFound: boolean;
	/** Absolute path it resolved to, when found — on Windows, what a shim actually launches. */
	binaryPath?: string;
	/** How the spawn will run it, when found (#1044): as itself, through Node, or through `cmd.exe`. */
	binaryVia?: EngineSpawn["via"];
	login: "found" | "missing" | "unknown";
	/** Where the login was looked for — a path or "keychain", never a value. */
	loginWhere?: string;
}

export interface EngineCheckDeps extends EngineSpawnDeps {
	home?: string;
	exists?: (p: string) => boolean;
	/** Exit status of `security find-generic-password -s <service>`; null when it could not run. */
	keychainItemStatus?: (service: string) => number | null;
}

function defaultExists(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

function defaultKeychainItemStatus(service: string): number | null {
	// Existence only: without `-w`/`-g` the secret is never read, so this cannot prompt or leak.
	const r = spawnSync("security", ["find-generic-password", "-s", service], { stdio: "ignore", timeout: 5_000 });
	return r.error ? null : r.status;
}

/** Does this engine have a stored interactive login on the machine? */
export function detectEngineLogin(engine: ClientType, deps: EngineCheckDeps = {}): { login: EngineCheck["login"]; where?: string } {
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const exists = deps.exists ?? defaultExists;
	const platform = deps.platform ?? process.platform;
	if (engine === "codex") {
		// `codex login` (ChatGPT subscription) writes auth.json under CODEX_HOME, default ~/.codex.
		const dir = env.CODEX_HOME?.trim() || join(home, ".codex");
		const file = join(dir, "auth.json");
		return { login: exists(file) ? "found" : "missing", where: file };
	}
	if (engine === "claude") {
		// An exported subscription token is a login the engine can read in `machine` mode.
		if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { login: "found", where: "CLAUDE_CODE_OAUTH_TOKEN" };
		const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
		const file = join(dir, ".credentials.json");
		if (exists(file)) return { login: "found", where: file };
		if (platform === "darwin") {
			// Claude Code keeps its macOS login in the keychain. 0 = the item exists, 44 = it does
			// not; anything else (a locked keychain, no `security`) is not an answer.
			const status = (deps.keychainItemStatus ?? defaultKeychainItemStatus)("Claude Code-credentials");
			if (status === 0) return { login: "found", where: "keychain" };
			if (status === 44) return { login: "missing", where: `keychain / ${file}` };
			return { login: "unknown" };
		}
		return { login: "missing", where: file };
	}
	if (engine === "gemini") {
		// Google sign-in lands here; Gemini also accepts other auth (gcloud, Vertex), so absence is
		// not proof of "signed out".
		const file = join(home, ".gemini", "oauth_creds.json");
		return exists(file) ? { login: "found", where: file } : { login: "unknown" };
	}
	return { login: "unknown" };
}

/**
 * The whole answer. `credentialInjected` is the cloud saying it will hand this spawn a credential
 * of its own (a platform-stored subscription token), in which case the machine's login is not what
 * the engine reads and is not checked.
 */
export function checkEngine(
	input: { clientType?: string; command?: string; credentialInjected?: boolean },
	deps: EngineCheckDeps = {},
): EngineCheck {
	const engine = (["claude", "gemini", "codex", "grok", "generic"].includes(input.clientType ?? "") ? input.clientType : "claude") as ClientType;
	// The ENGINE is what must be installed — after a `pas mcp-auth exec --` wrapper (#1006), not the wrapper.
	const command = parseCommand(input.command);
	const parsed = unwrapLauncher(command.bin, command.args);
	const bin = parsed.bin || parseCommand(handlerFor(engine).cliCommand).bin || engine;
	const { binaryPath, via } = resolveEngineSpawn(bin, [], deps);
	const login = input.credentialInjected ? { login: "found" as const, where: "platform" } : detectEngineLogin(engine, deps);
	return {
		checked: true,
		engine,
		bin,
		binaryFound: binaryPath !== null,
		...(binaryPath ? { binaryPath, binaryVia: via } : {}),
		login: login.login,
		...(login.where ? { loginWhere: login.where } : {}),
	};
}
