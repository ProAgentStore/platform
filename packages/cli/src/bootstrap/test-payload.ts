/** Test helper: write a CLI payload the way `npm install --prefix` lays one out. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A package at `pkgDir` whose entry, when imported, records `version` on `globalThis.__pagsRan`. */
export function writePackage(pkgDir: string, version: string, entry = "dist/index.js", name = "@proagentstore/cli"): string {
	const file = join(pkgDir, entry);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version, pagsPayload: entry }));
	writeFileSync(file, `globalThis.__pagsRan = [...(globalThis.__pagsRan ?? []), ${JSON.stringify(version)}];\n`);
	return file;
}

/** The same, under an npm prefix: `<prefix>/node_modules/@proagentstore/cli`. */
export function writeInstalled(prefix: string, version: string, entry?: string): string {
	return writePackage(join(prefix, "node_modules", "@proagentstore", "cli"), version, entry);
}
