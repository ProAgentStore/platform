#!/usr/bin/env node
// CI guard (#369): the two things about `workers/api/migrations/` that a reviewer cannot
// see and D1 will not tell you — the NUMBER on a filename, and whether a file that has
// already run somewhere was edited afterwards.
//
// ── Why filenames
//
// Wrangler applies migrations in FILENAME order and records the applied ones BY FILENAME.
// Both halves of that sentence are load-bearing here:
//
//   ORDER    — the number is how a reader reasons about what ran before what. #369 found
//              `0092_ai_usage_payer.sql` and `0092_coder_repo_engine_copy.sql` at main.
//              They happen to run in a sensible order, but only because `ai…` sorts before
//              `coder…` — the words after the number are doing the work the number is
//              supposed to do, and the next collision may not be lucky.
//   IDENTITY — a rename makes an applied migration look unapplied, so it RE-RUNS.
//
// That second half is why this guard exists in the shape it does rather than as a cleanup
// commit. See KNOWN_DUPLICATES below: the collision is inert and the rename is the hazard.
//
// How it happened is the part worth defending against: four agents were landing migrations
// in parallel and two picked the same free number within minutes of each other. Nobody was
// careless; the number was simply chosen from a directory listing that was already stale
// when it was read. That is a race, and a race is caught by an assertion, not by care.
//
// ── Why DDL
//
// Editing a migration that has already been applied changes nothing in the database that
// applied it — wrangler will never run it again — while a fresh database gets the new text.
// The two schemas then differ silently, and the difference surfaces months later as a bug
// that reproduces on one environment only. `0072_seed_tmux_operator_agent.sql` is the live
// example in this repo: its seeded tool list was rewritten a day after it shipped, so
// production still holds `tmux_*` while a fresh DB seeds `terminal_*`.
//
// COMMENTS ARE EXEMPT, deliberately and by construction — the comparison is over DDL with
// comments stripped. `0080_ai_usage_cost_source.sql` had its comment corrected in place on
// 2026-08-07 (comment only; DDL untouched) precisely BECAUSE that comment was where a wrong
// idea had been written down, and the wrong idea had already been read back out of it and
// believed. A guard that forbade that edit would be protecting the mistake.
//
// ── Exceptions
//
// Both lists below are ratchets, in the shape `check-file-size.mjs` and #307's
// `security-invariants.test.ts` already use here: each entry carries WHY it cannot simply
// be fixed, and the assertions compare sets rather than accepting a subset — so an entry
// can only leave the list deliberately. An exception whose reason has evaporated is dead
// config, and dead config in a guard is how the guard stops being believed.
//
// Usage:
//   node scripts/check-migrations.mjs                       # workers/api/migrations
//   node scripts/check-migrations.mjs <dir> [--require-history]
//
// `--require-history` refuses to skip the DDL half when git history is missing or shallow.
// CI passes it, and checks out with `fetch-depth: 0`, so the check cannot quietly become a
// no-op there the way a history-dependent check usually does.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(ROOT, "workers/api/migrations");

const args = process.argv.slice(2);
const REQUIRE_HISTORY = args.includes("--require-history");
const DIR = resolve(args.find((a) => !a.startsWith("--")) ?? DEFAULT_DIR);
/** The exception lists describe THIS directory. Pointed elsewhere (the guard's own tests),
 *  an entry naming a file that is not there is out of scope rather than dead config. */
const IS_DEFAULT_DIR = DIR === resolve(DEFAULT_DIR);

/** `NNNN_lower_snake.sql`. Four fixed digits is what makes filename order == numeric order. */
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * Numeric prefix -> the collision that is allowed to exist, and why it may not be resolved.
 *
 * A NEW duplicate fails. This one does not, and renaming either file to clear it would be
 * strictly worse than the collision:
 */
const KNOWN_DUPLICATES = {
	"0092": {
		files: ["0092_ai_usage_payer.sql", "0092_coder_repo_engine_copy.sql"],
		why:
			"Both are APPLIED IN PRODUCTION (0092_coder_repo_engine_copy shipped in a9f4cd7). Wrangler\n" +
			"      records applied migrations by the FULL filename, so renaming either one makes it look\n" +
			"      unapplied and it runs a second time against live D1 — and 0092_ai_usage_payer's\n" +
			"      `ALTER TABLE ai_usage ADD COLUMN payer` has no idempotent form in SQLite: the re-run\n" +
			"      fails with `duplicate column name: payer`, mid-batch. Ordering today is correct on the\n" +
			"      merits — the two touch unrelated objects, and `ai…` sorts before `coder…` — so the\n" +
			"      collision is inert and the rename is the hazard. It stays. This guard exists so that it\n" +
			"      is the LAST one, rather than the first of a series.",
	},
};

/**
 * Filename -> the commit its DDL is compared against, instead of the commit that introduced
 * it, plus why the drift is not recoverable.
 *
 * Every entry here is a migration whose DDL was edited after it shipped, before this guard
 * existed. The edit cannot be undone (production ran the original; a revert would only move
 * the divergence) and it cannot be re-applied (wrangler will not run the file again). What
 * is fixable is FURTHER drift, so the baseline moves to the last such commit and the file is
 * frozen from there: the same check, from a later starting line.
 *
 * Correcting one of these properly means a NEW migration that brings existing databases to
 * the text the file now claims. Delete the entry when that lands.
 */
const GRANDFATHERED = {
	"0043_multi_instance.sql": {
		baseline: "a662efc",
		why:
			"Rolled back ON DEPLOY twice (D1 rejected `defer_foreign_keys = on`, then the RENAME\n" +
			"      form), so the first two versions were never applied anywhere and editing in place was\n" +
			"      the correct move. a662efc is the shape that actually ran.",
	},
	"0057_seed_site_builder_agent.sql": {
		baseline: "2c284bd",
		why:
			"The seeded site-builder pipeline gained `emit: site.drafted` and four contact fields a\n" +
			"      week after it shipped. The seed is INSERT OR IGNORE, so the row already in production\n" +
			"      kept the older pipeline while a fresh DB seeds the newer one.",
	},
	"0063_seed_coder2_agents.sql": {
		baseline: "a9f4cd7",
		why:
			"The Repo Coder's `engine` setting description was corrected in the seed (#348, 'drives in\n" +
			"      tmux' -> 'drives on your machine'). Production was NOT fixed by that edit — it took\n" +
			"      migration 0092_coder_repo_engine_copy, an UPDATE over the live rows, to do that. The\n" +
			"      pair is the worked example of why editing a shipped seed is not a fix.",
	},
	"0072_seed_tmux_operator_agent.sql": {
		baseline: "6cbd8dc",
		why:
			"The seeded tool list was rewritten from `tmux_*` to `terminal_*` a day after it shipped,\n" +
			"      when the generic terminal connector replaced the tmux-specific one. INSERT OR IGNORE\n" +
			"      again: production still seeds the retired names, a fresh DB seeds the current ones.",
	},
};

// ── SQL, with the prose taken out ───────────────────────────────────────────────────────
//
// Single-quoted literals are tracked (with `''` as the escape) so a `--` INSIDE a seeded
// string — these files are full of JSON payloads — is not mistaken for the start of a
// comment, which would hide the rest of that line from the comparison. What is left is the
// part the database will actually see.
function ddlOnly(sql) {
	const parts = [];
	let code = "";
	// Layout is not content: whitespace runs collapse and spacing around `(),;` is dropped, so
	// re-indenting a statement does not read as an edit. Applied to CODE only — a literal is
	// appended verbatim, because whitespace inside a seeded prompt or JSON payload IS content.
	const flush = () => {
		parts.push(code.replace(/\s+/g, " ").replace(/\s*([(),;])\s*/g, "$1"));
		code = "";
	};
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i];
		if (c === "'") {
			flush();
			let lit = c;
			for (i++; i < sql.length; i++) {
				lit += sql[i];
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") lit += sql[++i];
					else break;
				}
			}
			parts.push(lit);
			continue;
		}
		if (c === "-" && sql[i + 1] === "-") {
			while (i < sql.length && sql[i] !== "\n") i++;
			code += " ";
			continue;
		}
		if (c === "/" && sql[i + 1] === "*") {
			i += 2;
			while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
			i++;
			code += " ";
			continue;
		}
		code += c;
	}
	flush();
	return parts.join("").trim();
}

// ── git, relative to the migrations directory ───────────────────────────────────────────

const git = (gitArgs) => {
	try {
		return execFileSync("git", gitArgs, { cwd: DIR, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return null;
	}
};

const inRepo = git(["rev-parse", "--git-dir"]) !== null;
const commitExists = (sha) => git(["cat-file", "-e", `${sha}^{commit}`]) !== null;
const nameSet = (gitArgs) => new Set((git(gitArgs) ?? "").trim().split("\n").filter(Boolean));

/**
 * filename -> the commits that touched it, newest first.
 *
 * One `git log` for the whole directory rather than one per file. 94 migrations × a spawn each
 * put this guard within a second of vitest's 5s default when it runs as a test, and #253 is the
 * standing lesson about what a wall-clock-hungry check does to a busy machine.
 */
function commitsByFile() {
	const out = git(["log", "--format=%H", "--name-only", "--relative", "--", "."]);
	if (out === null) return null;
	const map = new Map();
	let sha = null;
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		if (/^[0-9a-f]{40}$/.test(t)) {
			sha = t;
			continue;
		}
		map.set(t, [...(map.get(t) ?? []), sha]);
	}
	return map;
}

const problems = [];

// ── 1. Shape ────────────────────────────────────────────────────────────────────────────

const entries = readdirSync(DIR).sort();
const files = entries.filter((e) => NAME.test(e));

for (const entry of entries) {
	if (NAME.test(entry)) continue;
	problems.push(
		`${entry} is not a migration filename.\n` +
			`      Expected NNNN_lower_snake_case.sql. The four fixed digits are what make wrangler's\n` +
			`      alphabetical order the same as numeric order — \`100_x.sql\` would run before \`0099\`.`,
	);
}

// ── 2. One number, one migration ────────────────────────────────────────────────────────

const byPrefix = new Map();
for (const f of files) {
	const n = f.match(NAME)[1];
	byPrefix.set(n, [...(byPrefix.get(n) ?? []), f]);
}

for (const [prefix, group] of [...byPrefix].sort()) {
	const known = KNOWN_DUPLICATES[prefix];
	if (group.length > 1 && !known) {
		problems.push(
			`Migrations ${group.join(" and ")} share the number ${prefix}.\n` +
				`      The number is the only thing that says what ran before what; two files claiming one\n` +
				`      means the sequence can no longer be read off the names, and which runs first is then\n` +
				`      decided by the words after it. Renumber the one that has NOT been deployed to the\n` +
				`      next free number. If both have already been applied to production, do not rename\n` +
				`      either (wrangler keys applied migrations by filename — a rename re-runs it) and add\n` +
				`      an entry to KNOWN_DUPLICATES in scripts/check-migrations.mjs saying so.`,
		);
		continue;
	}
	if (!known) continue;

	const present = known.files.filter((f) => group.includes(f));
	if (present.length === 0) continue; // this directory is not the one the entry describes
	if (present.length === known.files.length && group.length === known.files.length) continue;

	const extra = group.filter((f) => !known.files.includes(f));
	if (extra.length) {
		problems.push(
			`${extra.join(", ")} joined the recorded ${prefix} collision.\n` +
				`      ${prefix} is allowed to hold exactly ${known.files.join(" + ")}, and only because\n` +
				`      neither can now be renamed. That is not a licence to keep adding to it — renumber to\n` +
				`      the next free number.`,
		);
	}
	const missing = known.files.filter((f) => !group.includes(f));
	if (missing.length && IS_DEFAULT_DIR) {
		problems.push(
			`${missing.join(", ")} is recorded in KNOWN_DUPLICATES but is not in ${DIR}.\n` +
				`      If it was RENAMED to clear the ${prefix} collision, revert that: wrangler records\n` +
				`      applied migrations by filename, so the new name looks unapplied and runs again on a\n` +
				`      database that already has it. If it was deleted on purpose, delete its entry too.`,
		);
	}
}

// ── 3. A migration that has shipped is frozen — its DDL, not its comments ────────────────

// A SHALLOW clone is not fatal here, and this is the one place that judgement matters.
// Truncated history can only make the check miss an edit older than the boundary; it cannot
// invent one, because whatever version it does find is a real earlier version of the file.
// So the thing worth refusing is not shallowness — it is a checkout so shallow that a
// TRACKED migration has no commits at all, which is what `fetch-depth: 1` produces and which
// turns the whole check into a silent no-op.
let checked = 0;
const unverified = [];
if (inRepo) {
	const history = commitsByFile() ?? new Map();
	const tracked = nameSet(["ls-files", "--", "."]);
	const dirty = nameSet(["diff", "--name-only", "--relative", "HEAD", "--", "."]);
	for (const f of files) {
		const shas = history.get(f) ?? [];
		if (shas.length === 0) {
			// Untracked means a migration being written right now: nothing has shipped, edit freely.
			if (tracked.has(f)) unverified.push(f);
			continue;
		}
		const pin = GRANDFATHERED[f];
		let baseline = shas[shas.length - 1];
		if (pin) {
			if (!commitExists(pin.baseline)) {
				unverified.push(f);
				continue;
			}
			const full = (git(["rev-parse", pin.baseline]) ?? "").trim();
			if (!shas.includes(full)) {
				if (IS_DEFAULT_DIR) {
					problems.push(
						`GRANDFATHERED["${f}"] pins baseline ${pin.baseline}, which is not a commit that touched\n` +
							`      the file. Stale exception — repin it to the last commit that edited the DDL, or\n` +
							`      remove the entry.`,
					);
				}
				continue;
			}
			baseline = full;
		}
		// The baseline IS what is on disk when it is the newest commit to touch the file and
		// nothing is staged or modified — nothing to read, and nothing that could differ.
		if (baseline === shas[0] && !dirty.has(f)) {
			checked++;
			continue;
		}
		const before = git(["show", `${baseline}:./${f}`]);
		if (before === null) {
			unverified.push(f);
			continue;
		}
		const after = readFileSync(join(DIR, f), "utf-8");
		checked++;
		if (ddlOnly(before) === ddlOnly(after)) continue;
		problems.push(
			`${f} has had its DDL changed since ${baseline.slice(0, 7)}${pin ? " (its recorded baseline)" : ", the commit that introduced it"}.\n` +
				`      If it has been applied anywhere, that edit reaches nothing: wrangler will not run the\n` +
				`      file again, so production keeps the old text while a fresh database gets the new one,\n` +
				`      and the two diverge silently. Write a NEW migration that brings existing databases to\n` +
				`      the state this file now describes. If it has NOT shipped (rolled back on deploy, never\n` +
				`      merged), record that: add it to GRANDFATHERED in scripts/check-migrations.mjs with the\n` +
				`      reason. Comments are exempt — this compares DDL with comments stripped — so correcting\n` +
				`      a comment that says something untrue is always allowed, and is what 0080 did.`,
		);
	}

	for (const f of Object.keys(GRANDFATHERED)) {
		if (!IS_DEFAULT_DIR || existsSync(join(DIR, f))) continue;
		problems.push(`GRANDFATHERED["${f}"] names a file that is no longer in ${DIR}. Remove the entry.`);
	}
}

if (REQUIRE_HISTORY && (!inRepo || unverified.length)) {
	problems.push(
		`The DDL half of this guard could not read history for ${!inRepo ? `${DIR} (not a git repository)` : `${unverified.length} of ${files.length} migrations (e.g. ${unverified.slice(0, 3).join(", ")})`},\n` +
			`      and it was asked to (--require-history). Check out with \`fetch-depth: 0\`. A\n` +
			`      history-dependent check that degrades to a silent no-op is worse than no check: it\n` +
			`      keeps reporting success from a job that verified nothing.`,
	);
}

if (problems.length) {
	console.error("✗ Migration hygiene (#369):\n");
	for (const p of problems) console.error(`  - ${p}\n`);
	const reasons = [...Object.entries(KNOWN_DUPLICATES).map(([k, v]) => [`${k} — ${v.files.join(" + ")}`, v.why]), ...Object.entries(GRANDFATHERED).map(([k, v]) => [`${k} — baseline ${v.baseline}`, v.why])];
	console.error("  Recorded exceptions, and why each one cannot simply be tidied away:\n");
	for (const [head, why] of reasons) console.error(`    ${head}\n      ${why}\n`);
	process.exit(1);
}

const dupes = Object.keys(KNOWN_DUPLICATES).length;
console.log(`✓ Migration hygiene OK — ${files.length} migrations, ${byPrefix.size} distinct numbers (${dupes} recorded collision${dupes === 1 ? "" : "s"}); ${inRepo ? `${checked} checked for DDL edits since they shipped${unverified.length ? `, ${unverified.length} unreadable (shallow history)` : ""}` : "DDL check skipped (not a git repository)"}.`);
