import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * What `spawn` is actually given for an engine — one answer for the spawn (`headless.ts`) and for
 * the pre-launch check (`engine-check.ts`), so the check cannot pass a binary the spawn then fails
 * on (#1044).
 *
 * Off Windows a bare name is spawned as-is: the kernel resolves it on PATH, shebangs included.
 *
 * On Windows `CreateProcess` runs only real executables, and libuv only tries `.exe`/`.com`. An npm
 * global install puts nothing of the sort on PATH — just `claude.cmd`, `claude.ps1` and an sh
 * script — so `spawn("claude")` fails with ENOENT on a machine where `claude` works in a terminal.
 * So on win32 the name is resolved before the spawn:
 *
 *   1. `<bin>.exe` / `<bin>.com` anywhere on PATH — spawned directly.
 *   2. else `<bin>.cmd` / `<bin>.bat` — an npm shim is read for its target:
 *      - a native executable (Claude Code's `bin\claude.exe`) is spawned directly;
 *      - a Node script (codex, gemini) is run with this runner's own Node — no shell, so a
 *        multi-line prompt arrives intact, which `cmd.exe` cannot carry;
 *      - anything else is run through `cmd.exe /d /s /c` with every argument quoted and
 *        caret-escaped for both parses a `%*`-forwarding shim gets (#1033: never unquoted).
 */
export interface EngineSpawn {
	command: string;
	args: string[];
	/** Pass to `spawn`: the `cmd.exe` line is already quoted and must reach it unchanged. */
	windowsVerbatimArguments?: true;
	/** The file that will run — the executable, the shim's target, or the shim itself. Null when not found. */
	binaryPath: string | null;
	/** How it runs: as itself, through Node (a script shim), or through `cmd.exe` (any other shim). */
	via: "direct" | "node" | "cmd";
}

export interface EngineSpawnDeps {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Is `p` an existing executable file? */
	isExecutable?: (p: string) => boolean;
	/** A shim's text, or null when it cannot be read. */
	readText?: (p: string) => string | null;
	/** The Node that runs a script shim's target. */
	nodePath?: string;
	/** The user's home, where xAI's installer puts the Grok CLI. */
	home?: string;
}

/**
 * xAI's Grok CLI for a bare `grok`, wherever PATH points (#1156). Its installer (x.ai/cli/install.sh, install.ps1) always
 * puts it in `~/.grok/bin` (`GROK_BIN_DIR` overrides), and adds that to PATH only in the SHELL's profile — so a
 * `pags up` started by launchd, systemd, a Scheduled Task or an older terminal does not see it. And an npm package of
 * the same name, the community `@vibe-kit/grok-cli` (API-key billed, different flags), can sit earlier on PATH: on the
 * Mac mini it did, in nvm's bin. The preset means xAI's CLI, so its own location wins when it is there. An explicit path
 * in a preset is the owner's choice and is never rewritten.
 */
export function officialEngineBinary(bin: string, deps: EngineSpawnDeps = {}): string | null {
	if (bin !== "grok") return null;
	const windows = (deps.platform ?? process.platform) === "win32";
	const env = deps.env ?? process.env;
	const dir = envVar(env, "GROK_BIN_DIR", windows)?.trim() || (windows ? win32 : posix).join(deps.home ?? homedir(), ".grok", "bin");
	const file = (windows ? win32 : posix).join(dir, windows ? "grok.exe" : "grok");
	return (deps.isExecutable ?? defaultIsExecutable)(file) ? file : null;
}

function defaultIsExecutable(p: string): boolean {
	try {
		if (!statSync(p).isFile()) return false;
		accessSync(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function defaultReadText(p: string): string | null {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

/** Windows env names are case-insensitive, but a copied env object is not (`Path`, `ComSpec`). */
function envVar(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
	if (!windows) return env[name];
	const key = Object.keys(env).find((k) => k.toUpperCase() === name);
	return key ? env[key] : undefined;
}

const isPathLike = (bin: string, windows: boolean) => bin.includes("/") || (windows ? bin.includes("\\") || win32.isAbsolute(bin) : posix.isAbsolute(bin));

/** The same resolution `spawn(bin)` does: a path is taken as-is, a bare name is searched on PATH (with PATHEXT on Windows). */
export function resolveBinary(bin: string, deps: Pick<EngineSpawnDeps, "env" | "platform" | "isExecutable"> = {}): string | null {
	const isExec = deps.isExecutable ?? defaultIsExecutable;
	if (!bin) return null;
	const windows = (deps.platform ?? process.platform) === "win32";
	const path = windows ? win32 : posix;
	if (isPathLike(bin, windows)) {
		const p = path.resolve(bin);
		return isExec(p) ? p : null;
	}
	const env = deps.env ?? process.env;
	const exts = windows ? (envVar(env, "PATHEXT", true) || ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (envVar(env, "PATH", windows) || "").split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const p = path.join(dir, bin + ext);
			if (isExec(p)) return p;
		}
	}
	return null;
}

/** The first `%dp0%\node_modules\…` target an npm (cmd-shim) `.cmd` launches, absolute. */
export function shimTarget(shimPath: string, text: string): string | null {
	const m = /"%~?dp0%?\\(node_modules\\[^"]+)"/i.exec(text);
	return m ? win32.join(win32.dirname(shimPath), m[1]) : null;
}

// cmd.exe metacharacters (cross-spawn's set). A caret makes the next one literal for one parse.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for `cmd.exe /s /c "<shim> <args>"`: quoted for the CRT's argv parser, then
 * caret-escaped twice — once for cmd's own parse, once more for the shim's `%*` re-parse.
 */
export function quoteCmdArg(arg: string): string {
	let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
	a = `"${a}"`;
	return a.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

export function resolveEngineSpawn(requested: string, args: string[], deps: EngineSpawnDeps = {}): EngineSpawn {
	const bin = officialEngineBinary(requested, deps) ?? requested;
	const windows = (deps.platform ?? process.platform) === "win32";
	if (!windows) return { command: bin, args, binaryPath: resolveBinary(bin, deps), via: "direct" };
	const env = deps.env ?? process.env;
	// Real executables first: PATHEXT order would otherwise pick `.CMD` over a later `.EXE` in no order we chose.
	const exe = resolveBinary(bin, { ...deps, env: { ...env, PATHEXT: ".exe;.com" } });
	const found = exe ?? resolveBinary(bin, { ...deps, env: { ...env, PATHEXT: ".cmd;.bat" } });
	if (!found) return { command: bin, args, binaryPath: null, via: "direct" };
	if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args, binaryPath: found, via: "direct" };

	const isExec = deps.isExecutable ?? defaultIsExecutable;
	const text = (deps.readText ?? defaultReadText)(found);
	const target = text ? shimTarget(found, text) : null;
	if (target && isExec(target)) {
		if (/\.(exe|com)$/i.test(target)) return { command: target, args, binaryPath: target, via: "direct" };
		if (/\.[cm]?js$/i.test(target)) return { command: deps.nodePath ?? process.execPath, args: [target, ...args], binaryPath: target, via: "node" };
	}
	const line = [found.replace(CMD_META, "^$1"), ...args.map(quoteCmdArg)].join(" ");
	return {
		command: envVar(env, "COMSPEC", true) || "cmd.exe",
		args: ["/d", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
		binaryPath: found,
		via: "cmd",
	};
}
