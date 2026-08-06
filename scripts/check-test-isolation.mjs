#!/usr/bin/env node
/**
 * check-test-isolation.mjs — keep the heavy-integration tests out of the parallel
 * group (issue #253).
 *
 * The mechanism behind that flake was plain wall-clock starvation — see the long note
 * in `vitest.config.ts`. Nothing raced; there was simply not enough CPU to finish
 * inside the budget, and the tests with the largest appetite tip first.
 *
 * `packages/browser-runner` (real Chrome over CDP, bound sockets, spawned tmux panes,
 * `git clone`) therefore runs as its own `integration` project, where it gets a
 * timeout budget sized for real I/O instead of vitest's 5s default — a number chosen
 * for pure functions.
 *
 * That boundary is only as durable as what enforces it. A real-browser or real-socket
 * test written next to its subject somewhere else would silently inherit the 5s
 * default and run in the parallel group, so this guard fails if a test file outside
 * the isolated directory launches a browser or binds a listening socket.
 *
 * String paths like `"/browser/act"` are deliberately NOT markers: cloud-side tests
 * assert on the runner's HTTP surface without ever launching anything.
 *
 * Run: `node scripts/check-test-isolation.mjs`
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(ROOT, "vitest.config.ts");

/** Calls that start a real browser, or bind a real listening socket, in the test's
 *  own process — the two things that make a test's result depend on machine load. */
const HEAVY = [
	"browserAct(",
	"browserSnapshot(",
	"browserHandoff(",
	"browserHandoffStatus(",
	"browserResume(",
	"browserComplete(",
	"new McpRuntime(",
	"startTestJobServer(",
	"startTestJobServerAuth(",
	"chromium.launch",
	"launchPersistentContext(",
];

const SEARCH_DIRS = ["packages", "workers", "agents", "store"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", "docs"]);

/** The `integration` project's globs, read straight out of the vitest config so the
 *  guard and the runner can never disagree about where the boundary is. */
function isolatedGlobs() {
	const src = readFileSync(CONFIG, "utf8");
	const block = src.match(/const INTEGRATION_TESTS = \[([\s\S]*?)\];/);
	if (!block) {
		console.error(
			"✗ Could not find `const INTEGRATION_TESTS = [...]` in vitest.config.ts.\n" +
				"  This guard reads that array. If the config was restructured, update this script\n" +
				"  too — do not delete the check.",
		);
		process.exit(1);
	}
	const globs = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	if (!globs.length) {
		console.error("✗ INTEGRATION_TESTS is empty — nothing would be isolated.");
		process.exit(1);
	}
	return globs;
}

/** Only the directory prefix matters here: every glob in the isolated project is a
 *  `dir/**` shape, and a prefix test is honest about that rather than pretending to
 *  be a general glob engine. */
function prefixesOf(globs) {
	return globs.map((g) => {
		const star = g.indexOf("*");
		const head = star === -1 ? g : g.slice(0, star);
		return head.replace(/\/+$/, "");
	});
}

function* testFiles(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			yield* testFiles(full);
			continue;
		}
		if (!entry.isFile()) continue;
		if (/\.(test|spec)\.tsx?$/.test(entry.name)) yield full;
	}
}

const globs = isolatedGlobs();
const prefixes = prefixesOf(globs);
const isIsolated = (rel) => prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));

const offenders = [];
let isolatedCount = 0;

for (const dir of SEARCH_DIRS) {
	const base = resolve(ROOT, dir);
	try {
		if (!statSync(base).isDirectory()) continue;
	} catch {
		continue;
	}
	for (const file of testFiles(base)) {
		const rel = relative(ROOT, file).split(sep).join("/");
		if (isIsolated(rel)) {
			isolatedCount++;
			continue;
		}
		const src = readFileSync(file, "utf8");
		const hits = HEAVY.filter((m) => src.includes(m));
		if (hits.length) offenders.push({ rel, hits });
	}
}

// An isolated project matching nothing would silently drop the whole category from
// `pnpm test:integration` — green, and running none of the hard tests.
if (isolatedCount === 0) {
	console.error(
		"✗ The `integration` project matches no test files. Its globs point somewhere that\n" +
			"  does not exist, so `pnpm test:integration` would pass without running anything.",
	);
	process.exit(1);
}

if (!offenders.length) {
	console.log(
		`✓ test isolation intact: ${isolatedCount} heavy-integration file(s) under ${prefixes.join(", ")},\n` +
			"  and no test file outside it launches a browser or binds a socket.",
	);
	process.exit(0);
}

console.error(
	`\n✗ ${offenders.length} test file(s) do real I/O but run in the PARALLEL \`unit\` group:\n`,
);
for (const o of offenders) {
	console.error(`  ${o.rel}`);
	console.error(`     uses: ${o.hits.join(", ")}`);
}
console.error(
	`\n  Move each under ${prefixes.join(" / ")}, or widen INTEGRATION_TESTS in vitest.config.ts.\n` +
		"  Competing with the fork pool for wall-clock is what made runner-browser.test.ts and\n" +
		"  test-job-server.test.ts fail while passing in isolation (#253).",
);
process.exit(1);
