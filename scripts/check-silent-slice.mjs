#!/usr/bin/env node
/**
 * check-silent-slice.mjs — no NEW silent head-cut (#898).
 *
 * #898 began with a GitHub comment that ended at "…4. O": an 8 KiB `.slice(0, N)` cut it and
 * nothing in the result said so, so an agent acted on half a comment as if it were all of it. The
 * fix there was to return values whole, page them, refuse an over-length write, or cut VISIBLY with
 * `clipMarked` (workers/api/src/lib/clip-marked.ts) — never a bare `.slice(0, N)` on text a reader
 * will treat as complete.
 *
 * Not every `.slice(0, N)` is that defect: an id prefix, a log label, a display preview the full
 * value sits beside. A machine cannot tell them apart, so this is a RATCHET, not a ban — the same
 * rule `check-bare-catch.mjs` follows: each tree is pinned at its exact count, a new occurrence
 * fails, and a removed one must lower the pin in the same commit (a pin is EXACT, never a `<=`
 * ceiling, or the ground taken becomes headroom).
 *
 * Before adding one: is the cut value read as COMPLETE by an agent, a prompt or a stored record?
 * Then use `clipMarked`, page it, or refuse the write (`lib/write-limits.ts`). If it is genuinely
 * an id or a label, raise the pin and say why in the commit.
 *
 * Run: `node scripts/check-silent-slice.mjs`
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** tree -> exact count of bare `.slice(0, CONST)` head-cuts outside comments. Only ever goes down. */
const PINNED = {
	// Pinned at #898's landing. Most of what remains is ids, labels and display previews; the
	// agent-read cuts the audit found were removed or marked before these numbers were taken.
	"workers/api/src": 430,
	"workers/mcp/src": 11,
	"packages/browser-runner/src": 57,
};

/** `.slice(0, 200)` / `.slice(0, MAX_X)` / `.slice(0, CAPS.git)` — a fixed head-cut. */
const HEAD_CUT = /\.slice\(0,\s*[A-Z0-9_][A-Za-z0-9_.]*\)/g;

const isSource = (f) => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !/\.d\.ts$/.test(f);

function sources(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) sources(p, out);
		else if (isSource(entry)) out.push(p);
	}
	return out;
}

/** Occurrences outside `//` and `/* *\/` comments — a postmortem in prose is not a cut. */
function headCuts(text) {
	const found = [];
	const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
	const lines = stripped.split("\n");
	for (const [i, line] of lines.entries()) for (const _ of line.matchAll(HEAD_CUT)) found.push(i + 1);
	return found;
}

let failed = false;
for (const [tree, pin] of Object.entries(PINNED)) {
	const files = sources(resolve(ROOT, tree));
	if (!files.length) {
		failed = true;
		console.error(`\n✗ ${tree}: the walk found no source files — this gate would report clean over an empty set.\n`);
		continue;
	}
	const found = [];
	for (const file of files) for (const line of headCuts(readFileSync(file, "utf-8"))) found.push(`${relative(ROOT, file)}:${line}`);
	if (found.length === pin) {
		console.log(`✓ ${tree}: ${pin} bare head-cut(s), at its pin, over ${files.length} source file(s).`);
		continue;
	}
	failed = true;
	console.error(`\n✗ ${tree}: ${found.length} bare \`.slice(0, N)\` head-cut(s), pinned at ${pin}.\n`);
	if (found.length > pin) {
		console.error("  A new one. If an agent, a prompt or a stored record reads the cut value as complete, use");
		console.error("  `clipMarked` (lib/clip-marked.ts), page it, or refuse the write (lib/write-limits.ts). If it is");
		console.error("  an id or a label, raise the pin in this file and say why in the commit. See #898.\n");
	} else {
		console.error("  Under the pin: you removed some — lower the pin here in the same commit.\n");
	}
}
process.exit(failed ? 1 : 0);
