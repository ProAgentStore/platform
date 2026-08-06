#!/usr/bin/env node
// CI guard (#290): the quality-scan config is only worth having if it excludes the right
// things. Three findings this week turned out to be scanner artefacts rather than bugs
// (#288 an unbuilt SDK dist, #292 `<path>` inside SVG logos, #293 type-only import edges),
// and the biggest single source of noise was `.claude/worktrees/**` being scanned once per
// live agent session. A config that drifts back into any of those states makes the next
// report untrustworthy in exactly the way that cost that time — so the config is checked
// the same way `agents/` and the test split already are.
//
// Five failures, each of which has either happened or was one edit away.
import { readFileSync } from "node:fs";

const problems = [];

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));

// ── 1. Every .vcqa.json ignore entry must be a form VCQA's matcher can actually match.
//
// VCQA's `shouldIgnore` is not a glob engine. It supports exactly three shapes
// (fs-utils.ts): `prefix/**` -> path-prefix, `*suffix` -> endsWith, anything else ->
// path-prefix. `**/dist/**` LOOKS like the most natural way to write "any dist folder"
// and is what every other config in this repo uses — biome.json and vitest.config.ts both
// say `**/dist/**` — but VCQA would turn it into the prefix `**/dist/`, which no real path
// ever starts with. It would match nothing, silently, and read as if it worked. Dead
// config in a file whose entire job is to be trusted is worse than no file.
const vcqa = readJson(".vcqa.json");
const ignore = vcqa.ignore ?? [];
if (ignore.length === 0) problems.push(".vcqa.json has no `ignore` list — it is doing nothing.");
//
// Note the shape of the check below. "ends with `/**`" is NOT sufficient — `**/dist/**`
// ends with `/**` and is still dead, because the prefix it leaves behind is `**/dist`.
// This mirrors VCQA's three branches literally and asks, for each, whether a real
// relative path could ever satisfy it.
const deadPattern = (pattern) => {
	// Branch 1: `prefix/**` -> relPath.startsWith(`${prefix}/`) || relPath === prefix.
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return prefix.includes("*") ? `the prefix it leaves ("${prefix}") contains a wildcard, which is matched literally` : null;
	}
	// Branch 2: `*...` -> relPath.endsWith(pattern.slice(1)).
	if (pattern.startsWith("*")) {
		const suffix = pattern.slice(1);
		return suffix.includes("*") ? `it becomes an endsWith("${suffix}") test, and no path contains a literal "*"` : null;
	}
	// Branch 3: anything else -> relPath.startsWith(pattern).
	return pattern.includes("*") ? `it becomes a startsWith("${pattern}") test, and no path contains a literal "*"` : null;
};

for (const pattern of ignore) {
	const dead = deadPattern(pattern);
	if (dead) {
		problems.push(
			`.vcqa.json ignore "${pattern}" can never match: ${dead}. VCQA understands exactly ` +
				"`prefix/**`, `*suffix`, or a plain path prefix — write the real path (e.g. `store/console/dist/**`), " +
				"or rely on VCQA's built-in directory-name exclusions, which already cover `dist` at any depth.",
		);
	}
	if (pattern.startsWith("/") || pattern.startsWith("./")) {
		problems.push(
			`.vcqa.json ignore "${pattern}": patterns are matched against paths relative to the repo root, with no leading slash.`,
		);
	}
}

// ── 2. Nothing under agents/ may be excluded.
//
// The premise this guard was written against was that ~11 inert vendored seed copies live
// under `agents/` and should be excluded from scans. They were removed on 2026-08-01
// (platform main f9980a8) and `scripts/check-agents-allowlist.mjs` has kept them out since.
// What is left is `coder` and `job-application-assistant` — both pnpm workspace members,
// both typechecked by ci.yml, both deployed — plus `repo-chat`, which is a single
// agent.json. So an `agents/**` exclusion would no longer skip anything stale; it would
// blind the scanner to two live, built, shipping codebases, while still reading as a
// sensible cleanup to whoever added it.
for (const pattern of ignore) {
	if (pattern.replace(/^!/, "").startsWith("agents/") || pattern.replace(/^!/, "") === "agents") {
		problems.push(
			`.vcqa.json ignore "${pattern}": agents/coder and agents/job-application-assistant are Tier-0 — ` +
				"workspace members that CI typechecks and builds. The inert seed copies this would have " +
				"targeted were deleted in f9980a8; see scripts/check-agents-allowlist.mjs.",
		);
	}
}

// ── 3. biome.json must exclude .claude.
//
// This one is not about noise, it is a hard break. Biome refuses to run at all when it
// finds a nested ROOT configuration below the root config it already loaded — and every
// agent worktree under `.claude/worktrees/` contains a copy of this very biome.json.
// Reproduced at the repo root on 2026-08-06: `pnpm lint` exited 1 with "Found a nested
// root configuration" and linted nothing whatsoever. Not "lint was noisy" — lint was dead,
// on any machine with a live agent session, which is most of them.
//
// The pattern must be `!.claude`, NOT `!**/.claude`, and the difference is not cosmetic.
// Every other exclusion in that list is written `!**/x`, so `!**/.claude` is the one a
// reader will reach for — and it is wrong in a way that only shows up where it matters
// most. Biome matches it against the whole path, and an agent worktree LIVES at
// `<repo>/.claude/worktrees/<agent>/`, so an ancestor directory matches and the entire
// checkout is excluded from itself. Measured: `!**/.claude` inside a worktree gave
// "Checked 0 files" and exit 0 — lint reporting success having examined nothing, which is
// worse than the crash it was fixing. `!.claude` is resolved relative to the config root,
// so it skips the worktrees dir at the repo root and nothing inside a worktree. Verified
// in both places: 891 files at the repo root, 807 inside a worktree.
const biome = readJson("biome.json");
const biomeIncludes = biome.files?.includes ?? [];
if (biomeIncludes.includes("!**/.claude")) {
	problems.push(
		'biome.json uses "!**/.claude" — inside an agent worktree (which lives under .claude/) that ' +
			'matches an ancestor and excludes the whole checkout: "Checked 0 files", exit 0. Use "!.claude", ' +
			"which is relative to the config root.",
	);
} else if (!biomeIncludes.includes("!.claude")) {
	problems.push(
		'biome.json files.includes is missing "!.claude". Without it Biome aborts on the nested ' +
			"biome.json inside every .claude/worktrees/* checkout and `pnpm lint` lints nothing at all.",
	);
}

// ── 4. The gitleaks allowlist must cover .claude, and must not have been widened into source.
//
// `gitleaks detect` is an external process spawned by VCQA's `secrets` check; VCQA's own
// ignore list never reaches it. Measured before .gitleaks.toml existed: 462 findings, 451
// of them (97.6%) duplicates from .claude/worktrees. After: 11. That is the difference
// between the worst check in the report and a short list a human can actually triage.
//
// The second half matters as much as the first: this file narrows WHERE gitleaks looks and
// must never narrow WHAT it looks for. `useDefault = false` would drop the upstream
// ruleset, and a `regexes`/`stopwords` allowlist silences findings by CONTENT — which is
// how a real leak gets waved through by a file that was only ever meant to skip worktrees.
const gitleaks = readFileSync(".gitleaks.toml", "utf-8");
if (!/useDefault\s*=\s*true/.test(gitleaks)) {
	problems.push(".gitleaks.toml must set `useDefault = true` — otherwise the upstream ruleset is dropped.");
}

// Read the `paths = [...]` array specifically, with `#` comment lines stripped, rather than
// grepping the whole file. The first cut of this check searched the raw text for `\.claude/`
// and passed after the pattern had been DELETED — because the comment above the array
// explains the anchoring using that exact string. A guard that is satisfied by prose about
// the rule, rather than by the rule, is not a guard.
const pathsBlock = gitleaks.match(/^paths\s*=\s*\[([\s\S]*?)^\]/m)?.[1] ?? "";
const pathPatterns = pathsBlock
	.split("\n")
	.map((l) => l.trim())
	.filter((l) => l && !l.startsWith("#"));
if (!pathPatterns.some((p) => p.includes("\\.claude/"))) {
	problems.push(
		".gitleaks.toml `paths` no longer covers .claude/ — the agent-worktree duplication that produced " +
			"451 of 462 findings will come straight back.",
	);
}
for (const key of ["regexes", "stopwords", "commits"]) {
	if (new RegExp(`^\\s*${key}\\s*=`, "m").test(gitleaks)) {
		problems.push(
			`.gitleaks.toml declares \`${key}\` — this file is for excluding PATHS that are not part of the ` +
				"checkout. Silencing findings by content or commit belongs in a reviewed .gitleaksignore, not here.",
		);
	}
}

// ── 5. .gitignore must ignore .claude/ (#295).
//
// The fourth tool that walks this directory is git itself, and it was the last one still
// reporting the worktrees: `git status -sb` on any machine with a live agent session showed
// `?? .claude/`. That is not a scan artefact, it is worse — a permanent line of noise in the
// output a developer reads most often, which is exactly how a genuinely untracked file gets
// skimmed past. The other three configs (.vcqa.json, .gitleaks.toml, biome.json) all skip
// this path already; checking the four together in one place is the reason this script
// exists, rather than four half-remembered conventions.
//
// Matched against the `.claude/` line specifically rather than `git check-ignore`, so the
// guard needs no git invocation and gives the same answer in a bare checkout. A negation
// (`!.claude/...`) anywhere would re-expose it, so those are rejected too.
const gitignore = readFileSync(".gitignore", "utf-8")
	.split("\n")
	.map((l) => l.trim())
	.filter((l) => l && !l.startsWith("#"));
if (!gitignore.some((l) => l === ".claude/" || l === ".claude")) {
	problems.push(
		".gitignore does not ignore `.claude/` — every machine running agent sessions shows `?? .claude/` " +
			"in `git status`, burying real untracked files in noise (#295).",
	);
}
for (const line of gitignore) {
	if (line.startsWith("!") && line.slice(1).replace(/^\/*/, "").startsWith(".claude")) {
		problems.push(`.gitignore re-includes .claude via "${line}" — agent worktrees would become untracked repo files again.`);
	}
}

if (problems.length) {
	console.error("✗ Quality-scan config problems (#290, #295):\n");
	for (const p of problems) console.error(`  - ${p}\n`);
	process.exit(1);
}
console.log(`✓ QA config OK — ${ignore.length} VCQA ignore patterns, biome + git skip .claude, gitleaks allowlists worktrees.`);
