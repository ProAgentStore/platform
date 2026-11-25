/**
 * Test helper: a fake command-line tool (`npm`, `gh`) a script under test finds on PATH, in the shape a real one has on this OS (#1725).
 *
 * POSIX: a `#!/usr/bin/env node` script named `<name>`, chmod +x.
 * Windows: the script as `<name>.fake.js`, with `<name>.cmd` beside it: how npm and many CLIs install (`npm.cmd`), found by PATH x PATHEXT,
 * never by a shebang. A script that calls the tool by bare name must resolve it that way (`scripts/lib/portable-command.mjs`).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Install `body` (JavaScript, run by Node) as the tool `name` in `dir`. */
export function writeFakeTool(dir, name, body) {
	mkdirSync(dir, { recursive: true });
	if (process.platform !== "win32") {
		const file = join(dir, name);
		writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
		chmodSync(file, 0o755);
		return file;
	}
	writeFileSync(join(dir, `${name}.fake.js`), `${body}\n`);
	const cmd = join(dir, `${name}.cmd`);
	writeFileSync(cmd, `@ECHO off\r\n"${process.execPath}" "%~dp0${name}.fake.js" %*\r\n`);
	return cmd;
}

/** `process.env` with `dir` first on PATH, under whatever name PATH has (`Path` on Windows). */
export function envWithTool(dir) {
	const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	return { ...process.env, [key]: `${dir}${delimiter}${process.env[key] ?? ""}` };
}
