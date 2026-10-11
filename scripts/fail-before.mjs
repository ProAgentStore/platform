#!/usr/bin/env node
/**
 * fail-before.mjs — run a test against the OLD source of named files, then restore them exactly (#1021).
 *
 *   node scripts/fail-before.mjs [--base REV] --path a.ts --path b.ts -- npx vitest run --project unit x.test.ts
 *
 * Each file is its own `--path` (never one space-separated string). Everything after `--` is the test argv,
 * run with no shell. Never touches `git stash`, the index or any other file — see scripts/lib/fail-before.mjs.
 *
 *   node scripts/fail-before.mjs --restore .git/pags-fail-before/<id>   finish an interrupted run
 *
 * Exit: the test's own status after a clean restore; 64 refused (nothing changed); 70 a file changed during
 * the run (left as it is, journal kept); 75 unknown state — an unfinished earlier run, or a journal that does
 * not verify or belongs to another repository (nothing changed, journal kept).
 * The receipt is the last line, as JSON.
 */
import { EXIT, failBefore, restoreFromJournal } from "./lib/fail-before.mjs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const receipt = (r) => {
	process.stdout.write(`${JSON.stringify(r)}\n`);
	process.exit(r.exit);
};

if (argv[0] === "--restore") {
	// The journal names its own repository; restoring from any other repository is refused (#1021).
	const r = restoreFromJournal(resolve(argv[1] ?? ""), { root: process.cwd() });
	receipt({ ...r, phase: "restore" });
}

const paths = [];
let base = "HEAD";
let i = 0;
for (; i < argv.length && argv[i] !== "--"; i++) {
	if (argv[i] === "--path") paths.push(argv[++i]);
	else if (argv[i] === "--base") base = argv[++i];
	else receipt({ ok: false, phase: "preflight", exit: EXIT.refused, mutated: false, detail: `unknown argument ${JSON.stringify(argv[i])}; use --path <file> (repeatable), --base <rev>, then -- <test command>. Nothing was changed.` });
}
receipt(failBefore({ cwd: process.cwd(), base, paths, command: argv.slice(i + 1) }));
