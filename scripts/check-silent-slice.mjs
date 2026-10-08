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
	"workers/api/src": 466, // +2 at #984: the recovery card's TITLE and SUBTITLE — "Unfinished work in <repo> — issue #978" and the owning objective, both labels on a card whose `description` carries the sentence through `cardDetail` (so the part a reader acts on is marked when it is cut). +8 at #974: the runner's own busy/refusal message, bounded at each place it is read or stored (4 in the queue decision + its store) and the three queued/failed reasons the drainers write — every one a LABEL the machine produced about itself, shown to the owner beside its own position in line, not content a reader takes as whole. +1 at #973: the revoke reason an owner types, bounded where it is stored — a label on their own withdrawal, not content a reader takes as whole. +12 at #957 (Application Runner: 4 are the vendored local-apply contract's parse-time bounds, the same cuts the runner copy makes; the 500-event run trace cap, which the run row's runner_seq exposes; the 20-question cap on a blocked application, as the Tailor's; error, pause-url/domain/question and runner-message bounds on labels shown to the owner — the owner's own answers are REFUSED past their bounds, not cut); +11 at #956 (Application Tailor: 7 are the vendored local-artifact contract's parse-time bounds on what a runner may report — the same cuts the runner copy makes; the 200-event trace cap, which the run row's runner_seq exposes; two id labels on a malformed lead's record; two runner error messages bounded as local-browser's are); +2 at #962 (run_local_browser: the 8-char run id in its event summary, and parseConfig's 4000-char bound on `objective`, which the write path already refuses past); −1 at #959 (the PR enrichment cap is one cut, and only the no-token fallback now); +1 at #924 (`topSessions`, the three heaviest, named as such); −1 at #954 (a cut line names the column that reads its rest); +1 at #961 (the fleet snapshot's repo cap — every repo past it is reported unread, and the response says how many).
	"workers/mcp/src": 9, // −2 at #959: the terminal fallback's liveError and the audit preview are clipMarked.
	"packages/browser-runner/src": 88, // +1 at 78fe1a71 (#970): the page <title> label bounded inside a supervisor checkpoint's facts, as the in-page probe's title already is; +21 at #957 (the vendored local-apply contract's 4 parse-time bounds; the in-page probe's 20000-char text scan and title, as the research bridge has; a refusal reason and three pause-question labels; the value quoted inside a grounding refusal; envelope list and job-label bounds at the relay boundary (4); the CLI output-line cap and failed-run error bound, as local-browser/runtime.ts has; the owner-answer bounds the API already refuses past; the 500-event status page, now with a cursor so nothing is skipped; the result summary bound); +9 at #956 (the vendored local-artifact contract's 7 parse-time bounds; the CLI output-line cap and the failed-run error bound, as local-browser/runtime.ts has; the profile-version hash prefix, an id; a claim quoted inside a question to the owner)
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
