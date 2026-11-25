/**
 * A stand-in engine CLI the tests can really launch, on POSIX and on Windows (#1724).
 *
 * POSIX: a `#!/usr/bin/env node` script, chmod +x, launched by its own path — what a global install of a Node CLI gives.
 *
 * Windows cannot execute a shebang ("spawn EFTYPE"), and a real Node CLI never reaches it as one: npm installs
 * `<prefix>\<name>.cmd` beside `<prefix>\node_modules\<pkg>\<script>.js`, and `resolveEngineSpawn` (engine-spawn.ts)
 * reads that shim for its target and runs it with this runner's own Node. So on win32 the fake is laid out the same way —
 * the script under `node_modules\<name>\`, the `.cmd` beside it with the `"%dp0%\node_modules\…"` line `shimTarget` reads —
 * and the returned path is the `.cmd`. The code under test then takes the very resolution it takes for a real codex or
 * gemini install, rather than a path the tests invented.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** Install `source` (a Node script, shebang first) as the engine `binPath` names; returns the path to launch it by. */
export function fakeEngine(binPath: string, source: string): string {
	if (process.platform !== "win32") {
		writeFileSync(binPath, source);
		chmodSync(binPath, 0o755);
		return binPath;
	}
	const stem = basename(binPath, extname(binPath));
	const scriptDir = join(dirname(binPath), "node_modules", stem);
	mkdirSync(scriptDir, { recursive: true });
	writeFileSync(join(scriptDir, `${stem}.js`), source);
	const cmd = join(dirname(binPath), `${stem}.cmd`);
	writeFileSync(cmd, `@ECHO off\r\nSETLOCAL\r\nSET "dp0=%~dp0"\r\n"node" "%dp0%\\node_modules\\${stem}\\${stem}.js" %*\r\n`);
	return cmd;
}
