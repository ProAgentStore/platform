import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, win32 } from "node:path";

/** Windows cannot execute pnpm's .cmd shim without a shell. Resolve its native or
 * Node entry point instead, so paths and arguments remain literal argv values. */
export function commandInvocation(command, args, { platform = process.platform, env = process.env, node = process.execPath, exists = existsSync } = {}) {
	if (command === "node") return [node, args];
	if (platform !== "win32" || command !== "pnpm") return [command, args];
	const inherited = env.npm_execpath;
	if (inherited && /(?:^|[/\\])pnpm\.(?:c?js|mjs)$/i.test(inherited) && exists(inherited)) return [node, [inherited, ...args]];
	const dirs = [...new Set([...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean), dirname(node)])];
	for (const dir of dirs) {
		const native = join(dir, "pnpm.exe");
		if (exists(native)) return [native, args];
		for (const entry of [join(dir, "pnpm.cjs"), join(dir, "node_modules/pnpm/bin/pnpm.cjs"), join(dir, "node_modules/corepack/dist/pnpm.js")]) {
			if (exists(entry)) return [node, [entry, ...args]];
		}
	}
	throw new Error("Cannot locate a native pnpm executable or pnpm/Corepack Node entry point. Install pnpm or run the hook through pnpm.");
}

export function spawnPortableSync(command, args, options) {
	const [executable, argv] = commandInvocation(command, args);
	return spawnSync(executable, argv, options);
}

// cmd.exe metacharacters; a caret makes the next one literal for one parse (cross-spawn's set, as packages/cli/src/bootstrap/payload.ts).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for `cmd.exe /s /c "<shim> …"`: CRT-quoted, then caret-escaped for cmd and again for the shim's `%*`. */
export function quoteCmdArg(arg) {
	const quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

const envVar = (env, name) => env[Object.keys(env).find((k) => k.toUpperCase() === name) ?? name];

/**
 * How to run a tool installed as a Windows shim (npm, or a `gh` that is a `.cmd`). `execFile` finds only `.exe`/`.com` and cannot start a
 * `.cmd`, so a bare `npm` fails there with ENOENT. On win32 the name is looked up the way `cmd.exe` does (PATH x PATHEXT): a real
 * executable is run as itself, a `.cmd`/`.bat` through `cmd.exe /d /s /c` with every argument quoted. Off Windows, or when nothing
 * is found, the name is returned unchanged, so a missing tool fails exactly as it did before.
 */
export function shimInvocation(command, args, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
	if (platform !== "win32") return { file: command, args };
	const exts = (envVar(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	for (const dir of (envVar(env, "PATH") ?? "").split(win32.delimiter).filter(Boolean)) {
		for (const ext of exts) {
			const found = win32.join(dir, command + ext.toLowerCase());
			if (!exists(found)) continue;
			if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args };
			const line = [found.replace(CMD_META, "^$1"), ...args.map(quoteCmdArg)].join(" ");
			return { file: envVar(env, "COMSPEC") || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
		}
	}
	return { file: command, args };
}

/** `execFileSync` for a tool that may be a Windows shim. */
export function execShimSync(command, args, options) {
	const run = shimInvocation(command, args, { env: options?.env ?? process.env });
	return execFileSync(run.file, run.args, { ...options, ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}
