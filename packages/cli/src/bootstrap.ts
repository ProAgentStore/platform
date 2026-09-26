#!/usr/bin/env node
/**
 * `pags` — the bootstrap stub (#862). Installed once per machine; runs the newest CLI it has and, on
 * `pags up`, fetches a newer one first. See `bootstrap/stub.ts`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { payloadAt } from "./bootstrap/payload.js";
import { runStub } from "./bootstrap/stub.js";

const self = fileURLToPath(import.meta.url);
const packageDir = join(dirname(self), "..");

try {
	await runStub({
		bundled: payloadAt(packageDir),
		args: process.argv.slice(2),
		self,
		fromSource: existsSync(join(packageDir, "src", "bootstrap.ts")),
	});
} catch (e) {
	process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
}
