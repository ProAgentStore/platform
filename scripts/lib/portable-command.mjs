import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

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
