#!/usr/bin/env node
/**
 * check-e2e-projects.mjs — the Playwright projects still select the tests they claim to,
 * and a phone-geometry block still lands in the engine phones run (#740).
 *
 * WHY. `playwright.config.ts` scopes the WebKit project with `grep: /mobile — /` and
 * nothing counts what that matches. Measured 2026-08-23: change the regex to
 * `/mobile — NOTHING-MATCHES-THIS/` and `playwright test --list` reports
 * `Total: 270 tests in 2 files`, exit 0, **0 webkit entries**, no warning. (Playwright
 * does say `No tests found` when WebKit runs alone — with chromium in the same run, which
 * is the real run, it does not.) So the entire WebKit engine can go to zero coverage and
 * `pnpm test:e2e` stays green.
 *
 * That engine is not a second opinion. #384 built it after measuring
 * `main.scrollWidth − clientWidth` at 59px on /console/preferences in Safari and 0 in
 * Chromium — #333 had measured that page 153 times in Chromium, correctly found nothing,
 * and closed a defect that was really there.
 *
 * TWO ASSERTIONS, both counts:
 *
 *   1. Every project selects at least its pinned floor. A floor, not an exact number,
 *      because specs are added constantly — a project SHRINKING is the signal. A project
 *      with no floor recorded fails too, so a new one cannot arrive unmeasured.
 *   2. A test body that measures phone geometry carries the `mobile — ` prefix
 *      `playwright.config.ts:88` already states as an obligation. Two did not when this
 *      was written, and one of them is literally titled "…in WebKit".
 *
 * ADR 0002 — this asserts NUMBERS (tests selected per project, bodies examined), which is
 * G2. It is not the mechanical G1-presence check ADR 0002's Enforcement section declines.
 *
 * G4, each arm watched going red before landing — recorded 2026-08-23:
 *   • webkit `grep` neutered to a regex matching nothing → red, "0, floor 175"
 *   • the `mobile — ` prefix stripped from a geometry block → red, naming it
 *   • a project added to playwright.config.ts with no floor here → red
 *
 * Run: `node scripts/check-e2e-projects.mjs`
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockEnd, widthsIn } from "./lib/e2e-blocks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Per-project floors. Today's counts, recorded on the day the guard landed; a project may
 * grow freely and must never shrink below these without someone changing this line and
 * saying why in the commit. The same ratchet shape check-file-size.mjs and
 * check-design-tokens.mjs use.
 *
 * 2026-08-23: chromium 271, webkit 184. Before #740 they were 270 and 182 — chromium +1
 * from splitting the #311 block in two, webkit +2 because both halves of this change
 * (the retitled #443 block and the new #311 one) now reach the engine phones run.
 */
const FLOORS = {
	chromium: 260,
	webkit: 175,
};

/** A phone width. Anything at or below this is a geometry measurement, not a layout the
 *  desktop project covers — 480px is the widest phone in portrait this suite asserts. */
const PHONE_WIDTH = 480;

/** The prefix `playwright.config.ts` greps for. Kept as a constant so a change to one is
 *  a visible change to the other. */
const PREFIX = "mobile — ";

/**
 * Blocks that touch `scrollWidth` for a reason that is NOT phone geometry, and therefore
 * do not belong in WebKit. Each entry is a full title path with the reason beside it —
 * a guard that fired on these on the day it landed would teach suppression (#454).
 */
const NOT_GEOMETRY = {};

function fail(lines) {
	console.error(`\n✗ ${lines.join("\n")}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------- the selection itself

let raw;
try {
	raw = execFileSync("npx", ["playwright", "test", "--list", "--reporter=json"], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
} catch (err) {
	fail([
		"`playwright test --list` failed, so this guard measured NOTHING:",
		`  ${(err.stderr || err.message || "").toString().trim().split("\n").slice(-6).join("\n  ")}`,
	]);
}

let report;
try {
	// Playwright prepends nothing today, but a deprecation notice on stdout would make
	// this a parse error rather than a silent zero — so slice from the first brace.
	report = JSON.parse(raw.slice(raw.indexOf("{")));
} catch (err) {
	fail(["Could not parse `playwright test --list --reporter=json` output:", `  ${err.message}`]);
}

// Spec paths in the JSON report are relative to the config's rootDir, not to the repo.
const REPORT_ROOT = report.config?.rootDir;
if (!REPORT_ROOT) {
	fail(["`playwright test --list` reported no config.rootDir, so spec paths cannot be resolved."]);
}

/** @type {{project:string,file:string,line:number,title:string}[]} */
const entries = [];
function walk(suite, titles) {
	const path = suite.title && !suite.file?.endsWith(suite.title) ? [...titles, suite.title] : titles;
	for (const spec of suite.specs ?? []) {
		for (const t of spec.tests ?? []) {
			entries.push({
				project: t.projectName,
				file: spec.file,
				line: spec.line,
				title: [...path, spec.title].join(" > "),
			});
		}
	}
	for (const child of suite.suites ?? []) walk(child, path);
}
for (const suite of report.suites ?? []) walk(suite, []);

if (!entries.length) {
	fail([
		"`playwright test --list` selected 0 tests in total.",
		"  That is the config failing to find the spec files, not a clean suite.",
	]);
}

const counts = {};
for (const e of entries) counts[e.project] = (counts[e.project] ?? 0) + 1;

const problems = [];
for (const [project, count] of Object.entries(counts).sort()) {
	if (!(project in FLOORS)) {
		problems.push(
			`project "${project}" has no floor recorded in scripts/check-e2e-projects.mjs (it selects ${count}).\n` +
				"    A project nothing counts can select zero and still report green — pin it.",
		);
	}
}
for (const [project, floor] of Object.entries(FLOORS).sort()) {
	const count = counts[project] ?? 0;
	if (count === 0) {
		problems.push(
			`project "${project}" selects 0 tests (floor ${floor}).\n` +
				"    Playwright exits 0 for an empty project when another project has tests, so this\n" +
				"    would otherwise be indistinguishable from a passing run. If the project was\n" +
				"    removed from playwright.config.ts, remove its floor in the same commit.",
		);
	} else if (count < floor) {
		problems.push(
			`project "${project}" selects ${count} tests, below its floor of ${floor}.\n` +
				"    Either its selector stopped matching, or specs were deliberately removed — in\n" +
				"    which case lower the floor here in the same commit and say why.",
		);
	}
}

// ------------------------------------------------- the `mobile — ` convention, by count

/**
 * A test's body runs from the line Playwright reported to that block's own closing line
 * (`blockEnd`, in scripts/lib/e2e-blocks.mjs, which carries its own unit test). Not a JS
 * parser: the START comes from Playwright rather than from a regex, and the END is an
 * indentation convention this repo's formatter guarantees.
 *
 * The first draft of this guard ran each body to the NEXT test's line instead, and that
 * is wrong at a describe boundary: the region after a describe's last test holds the next
 * describe's helpers and header comments. It reported two false positives on the day it
 * was written — `Usage — the daily chart counts cache (#547)`, whose slice swallowed the
 * shared overflow-helper comment 35 lines below it, and `feedback is readable per agent
 * (#514)`, whose slice swallowed a later `openSolo(page, width)` helper. A guard with
 * false positives on the day it lands teaches suppression (#454), so the bound is exact
 * and an un-bounded block is REPORTED rather than guessed at.
 */
const byFile = new Map();
for (const e of entries) {
	if (!byFile.has(e.file)) byFile.set(e.file, new Map());
	const lines = byFile.get(e.file);
	// A `test()` inside a loop reports EVERY generated test at the same line, so a line
	// carries a SET of titles (29 do today). They share one body, so the body's verdict
	// applies to all of them — and if any one of those titles lacks the prefix, that
	// iteration runs in Chromium only. Keeping the last title would have hidden exactly
	// that.
	if (!lines.has(e.line)) lines.set(e.line, new Set());
	lines.get(e.line).add(e.title);
}

let bodiesExamined = 0;
let geometryBlocks = 0;
const offenders = [];
const unbounded = [];
const unreadable = [];

for (const [file, lines] of byFile) {
	let src;
	try {
		src = readFileSync(resolve(REPORT_ROOT, file), "utf8").split(/\r?\n/);
	} catch (err) {
		// G3: a file the guard cannot read is a smaller measurement, not a clean one.
		fail([`Could not read the spec file ${file} that Playwright listed:`, `  ${err.message}`]);
	}
	for (const [start, titleSet] of [...lines].sort((a, b) => a[0] - b[0])) {
		const titles = [...titleSet];
		const title = titles.length === 1 ? titles[0] : `${titles[0]} (+${titles.length - 1} more at this line)`;
		const end = blockEnd(src, start);
		if (end === null) {
			unbounded.push(`${file}:${start} — ${title}`);
			continue;
		}
		const body = src.slice(start - 1, end).join("\n");
		bodiesExamined++;

		const setsViewport = body.includes("setViewportSize(");
		const readsScrollWidth = body.includes("scrollWidth");
		if (!setsViewport && !readsScrollWidth) continue;

		const widths = widthsIn(body);
		const narrow = widths.some((w) => w <= PHONE_WIDTH);
		// EVERY title generated at this line must carry it — one that does not is an
		// iteration the WebKit project never selects.
		const carriesPrefix = titles.every((t) => t.includes(PREFIX));

		// A body that resizes to a width this reader cannot see. Only a decision the guard
		// would otherwise get WRONG is worth reporting: a block already carrying the prefix
		// is already in the WebKit project whatever its width turns out to be, so the width
		// changes nothing. A prefix-less one is exactly where an unreadable width would be
		// silently treated as a wide layout, so that one is a failure (G3).
		if (setsViewport && !widths.length) {
			if (!carriesPrefix) unreadable.push(`${file}:${start} — ${title}`);
			if (carriesPrefix) geometryBlocks++;
			continue;
		}
		if (!narrow && !readsScrollWidth) continue;

		geometryBlocks++;
		if (carriesPrefix) continue;
		if (titles.every((t) => t in NOT_GEOMETRY)) continue;
		offenders.push({ where: `${file}:${start}`, title, widths: widths.filter((w) => w <= PHONE_WIDTH) });
	}
}

for (const u of unbounded) {
	problems.push(
		`this guard could not find the closing line of the block at ${u}.\n` +
			"    Its body is therefore unmeasured. The bound is `<the test's indentation>});` — if\n" +
			"    the file's formatting changed, teach blockEnd(); do not let the block pass unread.",
	);
}
for (const u of unreadable) {
	problems.push(
		`this guard could not read the viewport width in ${u}.\n` +
			"    It resizes the page in a shape widthsIn() does not understand, and its title carries\n" +
			`    no "${PREFIX}" prefix — so whether it belongs in WebKit is undecidable. Teach\n` +
			"    widthsIn() the shape, or give it the prefix. Do not let it pass as a wide layout.",
	);
}
for (const o of offenders) {
	problems.push(
		`${o.where} measures phone geometry${o.widths.length ? ` (${o.widths.join("px, ")}px)` : " (reads scrollWidth)"} ` +
			`but its title carries no "${PREFIX}" prefix, so it runs in Chromium only:\n` +
			`    ${o.title}\n` +
			`    Retitle it with the "${PREFIX}" prefix so the WebKit project selects it — that is the\n` +
			"    engine every phone runs, and the one #384 proved differs. If it touches scrollWidth\n" +
			"    for a reason that is NOT phone geometry, record it in NOT_GEOMETRY with that reason.",
	);
}

if (problems.length) {
	fail([
		`${problems.length} problem(s) across ${entries.length} selected test(s) in ${Object.keys(counts).length} project(s):`,
		"",
		...problems.map((p) => `  • ${p}`),
	]);
}

const summary = Object.entries(counts)
	.sort()
	.map(([p, c]) => `${p} ${c} (floor ${FLOORS[p]})`)
	.join(", ");
console.log(`✓ e2e projects: ${summary}.`);
console.log(
	`  ${geometryBlocks} phone-geometry block(s) of ${bodiesExamined} distinct test block(s) read carry the "${PREFIX}" prefix` +
		(Object.keys(NOT_GEOMETRY).length ? `, ${Object.keys(NOT_GEOMETRY).length} recorded as not-geometry.` : "."),
);
