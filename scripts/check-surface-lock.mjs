#!/usr/bin/env node
// CI guard (#576): the surface lock is APPEND-ONLY. An entry, once recorded, keeps its
// fingerprint — new versions are added, existing ones are never rewritten.
//
// ── What this closes
//
// #573 AC2 (`1d5cb24`) hashes the published MCP surface against the entry `SURFACE_LOCK`
// holds for `MCP_SERVER_VERSION`, so a surface change goes red. Its author wrote the limit
// into its own header: the entry can be edited in place. Change the surface, rewrite
// `SURFACE_LOCK["0.1.2"]` to the new hash instead of adding `["0.1.3"]`, and the version
// never moves.
//
// MEASURED, not argued (#576 AC6, 2026-08-15): one sentence appended to SERVER_INSTRUCTIONS
// — which is what a connecting client receives — plus an in-place rewrite of the 0.1.2
// entry, and ALL TWELVE gates passed: seven check-*.mjs, docs:drift, docs:build, biome,
// the mcp typecheck, and the full 8,7xx-test vitest run. Nothing else in the repo compares
// SERVER_INSTRUCTIONS to anything, so the version stayed frozen and CI stayed green. That
// is precisely the state #573 was filed about — the ChatGPT connector serving a stale tool
// list because nothing signalled a change — reachable through a passing build.
//
// ── Where this DIFFERS from check-migrations.mjs --require-history (#576 AC4)
//
// That guard answers the same KIND of question — "does the history show this was added
// rather than rewritten?" — and the git mechanism is borrowed from it deliberately. Four
// things are genuinely different, and copying its shape would have got each of them wrong:
//
//   1. THE UNIT OF IMMUTABILITY IS AN ENTRY, NOT A FILE. A migration must never change once
//      applied, so that guard compares whole-file DDL. surface-lock.ts is SUPPOSED to change
//      — every version bump adds a line. Freezing the file would forbid the one act it
//      exists for. So this compares a parsed version->hash MAP and permits exactly one
//      transition: additions.
//   2. THE COMPARISON IS A SET DIFF, NOT A TEXT DIFF. Follows from (1). It also means the
//      per-entry COMMENT stays freely editable, which matters for the same reason
//      check-migrations exempts comments: 0080's comment was corrected in place precisely
//      because a wrong idea had been written there and believed.
//   3. NO --follow, AND NO PER-FILE WALK. That guard resolves an introducing commit for each
//      of ~110 migrations. This reads the revisions of ONE path, so it is a single `git log`
//      plus one `git show` per revision of a file with two entries in it. AC3's "costs
//      nothing measurable" is a property of the shape, not a hope.
//   4. THERE IS AN EXTERNAL WITNESS, AND IT IS DELIBERATELY NOT CONSULTED. A migration's
//      "already shipped" is only knowable from history. A version's is published on the MCP
//      registry, which really does hold 0.1.0/0.1.1/0.1.2. Calling it from CI would make a
//      required gate depend on a third-party endpoint being up — a guard that goes red for
//      someone else's outage gets deleted. Git history is the offline proxy, and the
//      registry is the thing to check by hand when an entry is genuinely disputed.
//
// What is NOT different: `--require-history` means the same thing here as there — refuse to
// skip when git history is missing or shallow, so the check cannot quietly become a no-op
// the way a history-dependent check usually does. CI passes it and checks out with
// fetch-depth: 0.
//
// Usage:
//   node scripts/check-surface-lock.mjs [--require-history]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffLock, LOCK_EXPORT, parseSurfaceLock } from "./lib/surface-lock.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "workers/mcp/src/surface-lock.ts";
const REQUIRE_HISTORY = process.argv.slice(2).includes("--require-history");

/**
 * A recorded entry that IS allowed to have been rewritten, and why it could not be left.
 *
 * Same contract as check-migrations.mjs's KNOWN_DUPLICATES and check-file-size.mjs's PINS:
 * every entry carries its reason, and a dead entry — one naming a version that is not in
 * fact rewritten — FAILS. Dead config in a guard is how the guard stops being believed.
 *
 * Empty, and that is the honest state: no lock entry has ever been legitimately rewritten.
 * The case that would earn one is a hash recorded WRONG (a fingerprint taken from a tree
 * that was never published), which is a correction rather than a silent change — and it
 * belongs here, with the registry evidence, rather than in a quiet edit.
 *
 * @type {Record<string, string>}
 */
const KNOWN_REWRITES = {};

const die = (message) => {
	console.error(`✗ Surface lock (#576):\n\n${message}\n`);
	process.exit(1);
};

const git = (args) =>
	execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const abs = resolve(ROOT, LOCK_PATH);
if (!existsSync(abs)) {
	die(
		`  ${LOCK_PATH} does not exist.\n` +
			"  It is the record this check compares history against; if it moved, point LOCK_PATH at it.\n" +
			"  A missing input is a check that has stopped measuring, never a clean tree.",
	);
}

const current = parseSurfaceLock(readFileSync(abs, "utf8"));
if (current === null) {
	die(
		`  ${LOCK_PATH} no longer declares \`export const ${LOCK_EXPORT} = { … }\` in a shape this\n` +
			"  parser can read. That is a check that stopped running, which is why it is a failure\n" +
			"  rather than a pass — see ADR 0002 G3.",
	);
}
if (current.size === 0) {
	die(`  ${LOCK_PATH} records no versions at all; there is nothing to certify.`);
}

// ── History. The input set is asserted, exactly as --require-history promises ───────────
let revisions = [];
let historyError = null;
try {
	revisions = git(["log", "--format=%H", "--", LOCK_PATH]).trim().split("\n").filter(Boolean);
} catch (e) {
	historyError = e instanceof Error ? e.message : String(e);
}

if (historyError || revisions.length === 0) {
	const why = historyError
		? `git log failed: ${historyError}`
		: `git log returned no revisions for ${LOCK_PATH} — a shallow clone, or the file is untracked`;
	if (REQUIRE_HISTORY) {
		die(
			`  ${why}.\n\n` +
				"  --require-history was passed, so this is a failure rather than a skip. The whole\n" +
				"  point of this guard is the history comparison; silently passing without it would\n" +
				"  certify ground it never walked. CI checks out with fetch-depth: 0.",
		);
	}
	console.log(`✓ Surface lock: ${why}; skipped (no --require-history).`);
	process.exit(0);
}

// Every past revision, not just the previous one. Comparing HEAD to HEAD~ would only ever
// catch the most recent rewrite: an entry corrupted three commits ago would then read as
// settled fact from the fourth commit onward.
const offences = [];
let compared = 0;
for (const sha of revisions) {
	let past;
	try {
		past = parseSurfaceLock(git(["show", `${sha}:${LOCK_PATH}`]));
	} catch {
		// The file did not exist at that revision (a rename upstream of it, say). Not an
		// offence, and not silently skipped either — it is simply not a revision OF this
		// file, so it contributes nothing to compare. Counted below by `compared`.
		continue;
	}
	if (past === null) continue;
	compared += 1;
	const { rewritten, removed } = diffLock(past, current);
	for (const r of rewritten) offences.push({ sha, kind: "rewritten", ...r });
	for (const version of removed) offences.push({ sha, kind: "removed", version });
}

if (compared === 0) {
	die(
		`  found ${revisions.length} revision(s) of ${LOCK_PATH} but could not parse the lock out of\n` +
			"  any of them. The parser and the file's history have diverged; this check compared\n" +
			"  nothing and is saying so.",
	);
}

// A dead exception is worse than no exception: it is a hole nobody remembers opening.
const excused = new Set();
for (const o of offences) if (KNOWN_REWRITES[o.version]) excused.add(o.version);
const deadExceptions = Object.keys(KNOWN_REWRITES).filter((v) => !excused.has(v));
if (deadExceptions.length) {
	die(
		`  KNOWN_REWRITES excuses ${deadExceptions.length} version(s) that are not in fact rewritten: ` +
			`${deadExceptions.join(", ")}.\n` +
			"  Remove the entry. An exception whose reason has evaporated is a hole left open.",
	);
}

const real = offences.filter((o) => !KNOWN_REWRITES[o.version]);
if (real.length) {
	die(
		`  ${real.length} lock entry(ies) were changed after being recorded, across ${compared} revision(s)\n` +
			`  of ${LOCK_PATH}:\n\n` +
			real
				.map((o) =>
					o.kind === "removed"
						? `    ${o.version}  REMOVED (recorded in ${o.sha.slice(0, 7)})`
						: `    ${o.version}  recorded in ${o.sha.slice(0, 7)} as ${o.was}\n` +
							`             now reads              ${o.now}`,
				)
				.join("\n") +
			"\n\n  The lock is append-only. A changed surface gets a NEW version: bump\n" +
			"  MCP_SERVER_VERSION in workers/mcp/src/server-version.ts and add an entry for it,\n" +
			"  letting server.json, store/.well-known/mcp-server.json and platform-docs/mcp.md\n" +
			"  follow (pnpm docs:drift names any that do not).\n\n" +
			"  Rewriting an existing entry says the surface published under that version was\n" +
			"  something other than what was recorded — and 0.1.0, 0.1.1 and 0.1.2 are all live on\n" +
			"  the public MCP registry, so it is a claim about an artefact other people have\n" +
			"  fetched. If the recorded hash was genuinely WRONG, that is a correction: add it to\n" +
			"  KNOWN_REWRITES with the evidence.",
	);
}

console.log(
	`✓ Surface lock: ${current.size} entry(ies) (${[...current.keys()].join(", ")}) unchanged ` +
		`across ${compared} revision(s) of ${LOCK_PATH}` +
		`${Object.keys(KNOWN_REWRITES).length ? `, ${Object.keys(KNOWN_REWRITES).length} excused` : ""}`,
);
