import { spawnSync } from "node:child_process";
import { unwrapLauncher } from "./launcher-wrapper.js";
import { realpathSync, statSync } from "node:fs";
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
	/** What `<bin> --version` printed, reduced to its version (#1156). Asked for Grok always, others on request. */
	version?: string | null;
	/**
	 * Grok only (#1156): whose `grok` this is. `xai` — xAI's Grok CLI (`grok 1.0.62 (…)`); `community` — an npm package
	 * of the same name (`@vibe-kit/grok-cli`, API-key billed, other flags), which the shipped preset cannot drive.
	 */
	vendor?: "xai" | "community" | "unknown";
}

export interface EngineCheckDeps extends EngineSpawnDeps {
	home?: string;
	exists?: (p: string) => boolean;
	/** Exit status of `security find-generic-password -s <service>`; null when it could not run. */
	keychainItemStatus?: (service: string) => number | null;
	/** What a `--version` run printed (stdout + stderr), or null when it did not run or failed. */
	versionText?: (spawn: EngineSpawn, env: NodeJS.ProcessEnv) => string | null;
	/** Where a PATH entry really points — nvm's `bin/grok` is a symlink into `node_modules`. */
	realpath?: (p: string) => string;
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function defaultVersionText(launch: EngineSpawn, env: NodeJS.ProcessEnv): string | null {
	// The file the check FOUND, not the bare name: off Windows `command` is the name as given, which spawnSync would
	// resolve against this process's PATH rather than the one being checked — and report another binary's version.
	const command = launch.via === "direct" && launch.binaryPath ? launch.binaryPath : launch.command;
	const r = spawnSync(command, launch.args, { encoding: "utf8", env, timeout: 5_000, windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments });
	return r.error || r.status !== 0 ? null : `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/** `codex-cli 0.146.0`, `2.1.3 (Claude Code)`, `grok 1.0.62 (1474f9cbdd91)` → the version. Null when there is none. */
export function parseEngineVersion(text: string | null): string | null {
	return text?.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

/** Whose `grok` answered: xAI's names itself; the community npm one prints a bare version from a node_modules script. */
export function grokVendor(text: string | null, binaryPath: string | undefined): "xai" | "community" | "unknown" {
	if (text && /^\s*grok \d+\.\d+/m.test(text)) return "xai";
	if (/[\\/]node_modules[\\/]|@vibe-kit/.test(binaryPath ?? "")) return "community";
	return "unknown";
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
	if (engine === "grok") {
		// xAI's Grok CLI keeps its subscription login (grok.com / accounts.x.ai) in auth.json under GROK_HOME, default
		// ~/.grok. An external auth provider or OIDC setup signs in another way, so absence is not proof there.
		if (env.GROK_AUTH_PROVIDER_COMMAND?.trim() || env.GROK_OIDC_ISSUER?.trim() || env.GROK_DEPLOYMENT_KEY?.trim()) return { login: "unknown" };
		const file = join(env.GROK_HOME?.trim() || join(home, ".grok"), "auth.json");
		return { login: exists(file) ? "found" : "missing", where: file };
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
	input: { clientType?: string; command?: string; credentialInjected?: boolean; withVersion?: boolean },
	deps: EngineCheckDeps = {},
): EngineCheck {
	const engine = (["claude", "gemini", "codex", "grok", "generic"].includes(input.clientType ?? "") ? input.clientType : "claude") as ClientType;
	// The ENGINE is what must be installed — after a `pas mcp-auth exec --` wrapper (#1006), not the wrapper.
	const command = parseCommand(input.command);
	const parsed = unwrapLauncher(command.bin, command.args);
	const bin = parsed.bin || parseCommand(handlerFor(engine).cliCommand).bin || engine;
	const { binaryPath, via } = resolveEngineSpawn(bin, [], deps);
	const login = input.credentialInjected ? { login: "found" as const, where: "platform" } : detectEngineLogin(engine, deps);
	// Grok's version is what tells xAI's CLI from a same-named npm package, so it is always read for Grok (a native
	// binary, milliseconds); the others only when asked (coding_engine_get), because each is a Node startup.
	const versionText = binaryPath && (engine === "grok" || input.withVersion) ? (deps.versionText ?? defaultVersionText)(resolveEngineSpawn(bin, ["--version"], deps), deps.env ?? process.env) : null;
	return {
		checked: true,
		engine,
		bin,
		binaryFound: binaryPath !== null,
		...(binaryPath ? { binaryPath, binaryVia: via } : {}),
		login: login.login,
		...(login.where ? { loginWhere: login.where } : {}),
		...(binaryPath && (engine === "grok" || input.withVersion) ? { version: parseEngineVersion(versionText) } : {}),
		...(engine === "grok" && binaryPath ? { vendor: grokVendor(versionText, (deps.realpath ?? safeRealpath)(binaryPath)) } : {}),
	};
}

/**
 * The models an engine's CLI says it offers, asked live (#1199) — what `coding_engine_set` checks a pinned model id
 * against, so `grok --model grok-4` is refused with the list instead of failing at the next turn ("unknown model id").
 *
 * Only Grok publishes one: `grok models` (xAI Grok CLI 1.0.62, 2026-10-19) prints
 *
 *     Default model: grok-4.7
 *
 *     Available models:
 *       * grok-4.7 (default)
 *       - grok-4.7-build-fast
 *
 * Claude Code, Codex and Gemini take `--model` but list nothing, so for them `models` is null and the answer says so —
 * the platform then saves the id unchecked rather than guessing a list.
 */
export interface EngineModels {
	clientType: ClientType;
	/** The ids the CLI offered; null when this engine has no list to ask, or asking failed (`reason`). */
	models: string[] | null;
	defaultModel: string | null;
	reason?: string;
}

/** `grok models` → its ids and default; null when the output has no model list in it. */
export function parseGrokModels(text: string): { models: string[]; defaultModel: string | null } | null {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((l) => /^\s*Available models:\s*$/i.test(l));
	if (start < 0) return null;
	const models: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const m = /^\s*[*-]\s+(\S+)/.exec(line);
		if (m) models.push(m[1]);
		else if (line.trim()) break;
	}
	if (!models.length) return null;
	const named = /^\s*Default model:\s*(\S+)/im.exec(text)?.[1] ?? null;
	const starred = lines.slice(start + 1).find((l) => /^\s*\*\s+/.test(l))?.trim().split(/\s+/)[1] ?? null;
	return { models, defaultModel: named ?? starred };
}

export function listEngineModels(input: { clientType?: string; command?: string }, deps: EngineCheckDeps & { listText?: (spawn: EngineSpawn, env: NodeJS.ProcessEnv) => string | null } = {}): EngineModels {
	const engine = (["claude", "gemini", "codex", "grok", "generic"].includes(input.clientType ?? "") ? input.clientType : "claude") as ClientType;
	if (engine !== "grok") return { clientType: engine, models: null, defaultModel: null, reason: `the ${engine} CLI publishes no model list` };
	const command = parseCommand(input.command);
	const bin = unwrapLauncher(command.bin, command.args).bin || "grok";
	const launch = resolveEngineSpawn(bin, ["models"], deps);
	if (!launch.binaryPath) return { clientType: engine, models: null, defaultModel: null, reason: "grok is not installed on this machine" };
	const text = (deps.listText ?? defaultListText)(launch, deps.env ?? process.env);
	const parsed = text ? parseGrokModels(text) : null;
	if (!parsed) return { clientType: engine, models: null, defaultModel: null, reason: "`grok models` gave no model list (is the CLI signed in?)" };
	return { clientType: engine, ...parsed };
}

function defaultListText(launch: EngineSpawn, env: NodeJS.ProcessEnv): string | null {
	const command = launch.via === "direct" && launch.binaryPath ? launch.binaryPath : launch.command;
	const r = spawnSync(command, launch.args, { encoding: "utf8", env, timeout: 20_000, windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments });
	return r.error || r.status !== 0 ? null : `${r.stdout ?? ""}${r.stderr ?? ""}`;
}
