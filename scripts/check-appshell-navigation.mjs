#!/usr/bin/env node
/**
 * check-appshell-navigation.mjs — the AppShell navigation contract, executed (#1290).
 *
 *   node scripts/check-appshell-navigation.mjs [paths…] [--strict] [--json]
 *
 * Scans .tsx/.jsx/.ts/.js under the given paths (default: the current directory, skipping node_modules, dist, .git and build output),
 * reports each `ProShell`/`AppShell` whose navigation breaks docs/appshell-navigation-contract.md, and exits 1 on any error
 * (`--strict`: on any warning too). "No shell found" is reported as such and exits 0 — it is not a clean bill for an app that has
 * a shell this reader never saw. See scripts/lib/appshell-navigation.mjs for exactly what it can and cannot see.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { analyzeSources, formatDiagnostic, hasErrors } from "./lib/appshell-navigation.mjs";

const SKIP = new Set(["node_modules", "dist", ".git", ".next", ".turbo", ".wrangler", "coverage", "build", "playwright-report", "test-results"]);
const EXT = /\.(tsx|jsx|ts|js|mjs)$/;

function collect(path, out) {
	const st = statSync(path);
	if (st.isDirectory()) {
		for (const name of readdirSync(path)) if (!SKIP.has(name)) collect(join(path, name), out);
	} else if (EXT.test(path) && !/\.(test|spec)\./.test(path) && !path.endsWith(".d.ts")) out.push(path);
}

export function run(argv, cwd = process.cwd()) {
	const args = argv.filter((a) => !a.startsWith("--"));
	const strict = argv.includes("--strict");
	const json = argv.includes("--json");
	const files = [];
	for (const p of args.length ? args : ["."]) collect(resolve(cwd, p), files);
	const sources = files.map((f) => ({ file: relative(cwd, f), text: readFileSync(f, "utf8") }));
	const { shells, diagnostics } = analyzeSources(sources);
	const failed = hasErrors(diagnostics, strict);
	const lines = [];
	if (json) lines.push(JSON.stringify({ scanned: files.length, shells, diagnostics }, null, 2));
	else if (shells === 0) lines.push(`No ProShell/AppShell found in ${files.length} file(s) — nothing to check.`);
	else {
		for (const d of diagnostics) lines.push(formatDiagnostic(d));
		lines.push(diagnostics.length ? `\n${diagnostics.length} finding(s) across ${shells} shell(s) in ${files.length} file(s).` : `✓ ${shells} shell(s) in ${files.length} file(s): nothing the navigation contract names was found.`);
	}
	return { code: failed ? 1 : 0, output: lines.join("\n") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { code, output } = run(process.argv.slice(2));
	console.log(output);
	process.exit(code);
}
