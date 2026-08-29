#!/usr/bin/env node
/**
 * check-doc-citations.mjs — a `file:line` citation in docs/ or platform-docs/ that
 * does not resolve to a real path is a claim nothing enforces (#707).
 *
 * ── What this is actually about
 *
 * #707 measured that roughly one issue in three carried at least one `file:line` coordinate
 * that had drifted from the code it described. The dangerous half were citations that pointed
 * at *unrelated live code* — the defect was fully live, but an implementer following the
 * coordinate was sent to the wrong place and would find a false version of the problem.
 *
 * A CI check cannot read GitHub issue bodies, but it CAN protect `docs/` and
 * `platform-docs/` — which have the same problem class and ARE in the repo tree. This
 * guard catches the cheaper half: a cited path that does not resolve to any real file.
 * Semantic drift (the path resolves but the line number has moved) is out of scope for
 * this gate; it is best addressed by quoting the relevant text in the citation rather
 * than relying on a bare coordinate.
 *
 * ── What it checks
 *
 * Every backtick-quoted `path:N` or `path:N-M` pattern in docs/ and platform-docs/ is
 * extracted and the *path* part (before the colon) is resolved:
 *
 *   1. If the path exists verbatim from the repo root → OK.
 *   2. If git ls-files finds it as a unique suffix match → OK (e.g. `coding/headless.ts`
 *      uniquely resolves to `packages/browser-runner/src/coding/headless.ts`).
 *   3. If git ls-files finds zero matches → FAIL: the file does not exist.
 *   4. If git ls-files finds two or more matches → FAIL: the path is ambiguous — use
 *      a longer prefix so the citation is unambiguous (e.g. `lib/connectors/manifest.ts`
 *      instead of the bare `manifest.ts`, which matches three files).
 *
 * Note: line-number drift (the file exists but the number has moved) is NOT checked here.
 * The convention is to include the cited text alongside the coordinate, so a reader can
 * grep for it and learn immediately when the number has moved. See CONTRIBUTING.md.
 *
 * ── Denominator (ADR 0002 G1)
 *
 * The ✓ line names how many doc files were scanned and how many citations were found, so
 * "no broken citations" is distinguishable from "nothing was scanned".
 *
 * Run: `node scripts/check-doc-citations.mjs`
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Directories under the repo root that contain authored documentation. */
const DOC_DIRS = ["docs", "platform-docs"];

/**
 * Regex that matches a backtick-quoted `path.ext:N` or `path.ext:N-M` pattern.
 * The path must start with a letter and contain at least one `.` before the colon.
 * Captures: [1] = full path including extension, [2] = start line, [3] = end line (opt).
 */
const CITATION_RE = /`([a-zA-Z][a-zA-Z0-9_/.-]+\.[a-z]+):(\d+)(?:-(\d+))?`/g;

/** Collect every .md file under a directory recursively. */
function mdFiles(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			mdFiles(p, out);
		} else if (entry.endsWith(".md")) {
			out.push(p);
		}
	}
	return out;
}

/** All tracked file paths, as strings relative to ROOT, via git ls-files. */
function trackedFiles() {
	return execFileSync("git", ["ls-files", "--cached"], { cwd: ROOT, encoding: "utf-8" })
		.split("\n")
		.filter(Boolean);
}

const tracked = trackedFiles();

/**
 * Resolve a cited path to the set of tracked files it could refer to.
 *
 * The path from the doc may be:
 *   - An exact relative path from root  (`store/admin/src/lib/api.ts`) → match exactly.
 *   - A package-relative path          (`coding/headless.ts`) → suffix-match.
 *   - A bare filename                  (`manifest.ts`) → suffix-match; may be ambiguous.
 */
function resolve_path(citedPath) {
	// 1. Exact match from root.
	if (tracked.includes(citedPath)) return [citedPath];

	// 2. Suffix match: any tracked file whose path ends with `/<citedPath>`.
	const suffix = `/${citedPath}`;
	return tracked.filter((f) => f.endsWith(suffix));
}

// ── Collect all citations ────────────────────────────────────────────────────────────

const files = DOC_DIRS.flatMap((d) => {
	const abs = join(ROOT, d);
	return mdFiles(abs);
});

if (files.length < 5) {
	console.error(`✗ check-doc-citations: only found ${files.length} doc file(s) — expected at least 5. The scan is broken (ADR 0002 G1).`);
	process.exit(1);
}

const broken = [];
let totalCitations = 0;

for (const file of files) {
	const src = readFileSync(file, "utf-8");
	const rel = relative(ROOT, file);
	let m;
	CITATION_RE.lastIndex = 0;
	while ((m = CITATION_RE.exec(src)) !== null) {
		const citedPath = m[1];
		totalCitations++;
		const matches = resolve_path(citedPath);
		if (matches.length === 1) {
			// Resolves unambiguously — OK.
			continue;
		}
		if (matches.length === 0) {
			broken.push({ rel, citedPath, reason: "file not found in the repo" });
		} else {
			broken.push({
				rel,
				citedPath,
				reason: `ambiguous — ${matches.length} files match: ${matches.join(", ")}. Use a longer path prefix.`,
			});
		}
	}
}

if (broken.length) {
	console.error(`\n✗ check-doc-citations: ${broken.length} unresolvable citation(s) in ${files.length} doc files (#707):\n`);
	for (const { rel, citedPath, reason } of broken) {
		console.error(`  ${rel}: \`${citedPath}\` — ${reason}`);
	}
	console.error(
		"\n  Fix: use a path that resolves to exactly one file in the repo tree.\n" +
			"  Short names like `manifest.ts` are ambiguous when multiple packages contain that file.\n" +
			"  Use a longer prefix (e.g. `lib/connectors/manifest.ts`) so the citation is unambiguous.\n" +
			"  Also consider quoting the relevant text alongside the coordinate — quoted text survives\n" +
			"  line-number drift and is self-verifying (grep finds it or tells you it moved). (#707)\n",
	);
	process.exit(1);
}

console.log(
	`✓ Doc citations OK — ${totalCitations} citation(s) across ${files.length} doc file(s), all paths resolve unambiguously (#707).`,
);
