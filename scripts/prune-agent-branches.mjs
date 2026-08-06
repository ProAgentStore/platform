#!/usr/bin/env node
// Local hygiene (#316): delete the `worktree-agent-*` branches left behind by finished
// Claude Code agent sessions, and report the worktree directories that outlived them.
//
// NOT a CI guard. Nothing here runs in ci.yml — these branches are purely local (the repo
// has no remote branches beyond main) and a machine with no agent sessions has nothing to
// prune. This exists because the SAFE command is long enough that nobody ran it, which is
// how 40 orphans accumulated and 559M sat in .claude/worktrees.
//
// ── Why this is not `git branch -D $(git branch | grep worktree-agent-)`
//
// Two things make the obvious one-liner dangerous, and both have actually bitten:
//
//   1. A LIVE session's branch is checked out in a locked worktree. Deleting it pulls the
//      branch out from under a running agent. `git branch -D` will happily do this — the
//      refusal only covers the branch checked out in the CURRENT worktree, not the other
//      four. So live branches are read from `git worktree list --porcelain` and excluded.
//
//   2. A branch may hold the ONLY copy of an agent's work. Agents commit to their worktree
//      branch and push to main at the end; one that died mid-task leaves commits that exist
//      nowhere else. On 2026-08-07 several agents' commits were sitting in worktrees waiting
//      to be pushed while this ticket was open. `-D` (which is what the one-liner needs,
//      because `-d` refuses anything not merged into the CURRENT branch) discards them with
//      a one-line "Deleted branch" that reads exactly like the safe case.
//
// So the classification is the whole point of the script:
//
//   MERGED   tip is an ancestor of the integration ref -> every commit is already in main,
//            the branch is a label on history that exists anyway. Safe to delete.
//   UNPUSHED tip is NOT an ancestor -> it carries commits main has never seen. REFUSED,
//            loudly, with the commits listed and the command to read them.
//
// The integration ref is `origin/main` when it exists (what is actually published) and
// falls back to local `main`. Ancestry, not `git branch --merged`, because --merged is
// relative to the currently checked-out branch — run from inside an agent worktree it would
// classify against that agent's branch and get a different, wrong answer.
//
// Dry run is the default. `--delete` performs it.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--delete") || args.has("--yes");
const PREFIX = "worktree-agent-";

const git = (...a) => execFileSync("git", a, { encoding: "utf-8" }).trim();
const gitOk = (...a) => {
	try {
		execFileSync("git", a, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

// Run from the repo root even when invoked from a worktree or a subdirectory.
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);

// ── The integration ref. Prefer the published one.
const base = gitOk("rev-parse", "--verify", "--quiet", "origin/main")
	? "origin/main"
	: gitOk("rev-parse", "--verify", "--quiet", "main")
		? "main"
		: null;
if (!base) {
	console.error("✗ Neither origin/main nor main exists — cannot tell merged work from unpushed work. Refusing to delete anything.");
	process.exit(1);
}

// ── Branches that are checked out in a worktree right now, live or not.
//
// `git worktree list` also reports registrations whose directory is gone (a stale entry).
// Those are exactly the ones we want to prune, so they are dropped here and the branch is
// treated as a candidate — but only AFTER `git worktree prune`, otherwise git still holds
// the ref and the delete fails.
const worktreeBlocks = git("worktree", "list", "--porcelain").split("\n\n");
const checkedOut = new Set();
const staleRegistrations = [];
for (const block of worktreeBlocks) {
	const path = block.match(/^worktree (.+)$/m)?.[1];
	const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
	if (!path) continue;
	if (block.includes("\nprunable") || !existsSync(path)) {
		staleRegistrations.push(path);
		continue;
	}
	if (branch) checkedOut.add(branch);
}

if (staleRegistrations.length) {
	console.log(`${APPLY ? "Pruning" : "Would prune"} ${staleRegistrations.length} stale worktree registration(s).`);
	if (APPLY) git("worktree", "prune");
}

const branches = git("branch", "--format=%(refname:short)")
	.split("\n")
	.map((b) => b.trim())
	.filter((b) => b.startsWith(PREFIX));

const merged = [];
const unpushed = [];
const live = [];
for (const branch of branches) {
	if (checkedOut.has(branch)) {
		live.push(branch);
		continue;
	}
	if (gitOk("merge-base", "--is-ancestor", branch, base)) merged.push(branch);
	else unpushed.push(branch);
}

// ── Report.
console.log(`\n${branches.length} ${PREFIX}* branch(es); integration ref: ${base}\n`);

if (live.length) {
	console.log(`  ${live.length} live (checked out in a worktree) — never touched:`);
	for (const b of live) console.log(`    · ${b}`);
	console.log("");
}

if (unpushed.length) {
	console.log(`  ${unpushed.length} carry commits that are NOT in ${base} — REFUSED:`);
	for (const b of unpushed) {
		const n = git("rev-list", "--count", `${base}..${b}`);
		const subjects = git("log", "--format=%h %s", "-3", `${base}..${b}`).split("\n");
		console.log(`    ✗ ${b}  (${n} commit${n === "1" ? "" : "s"})`);
		for (const s of subjects) console.log(`        ${s}`);
		console.log(`        read it:  git log -p ${base}..${b}`);
	}
	console.log("      This is an agent that died before pushing. Land the work, or delete it");
	console.log("      by hand once you have decided it is worthless — this script will not.\n");
}

if (!merged.length) {
	console.log("  Nothing to delete.\n");
} else if (APPLY) {
	for (const b of merged) git("branch", "-D", b);
	console.log(`  ✓ Deleted ${merged.length} branch(es) fully contained in ${base}.\n`);
} else {
	console.log(`  ${merged.length} fully contained in ${base} — safe to delete:`);
	for (const b of merged) console.log(`    · ${b}`);
	console.log("\n  Dry run. Re-run with --delete to remove them.\n");
}

// ── Leftover directories.
//
// #316 asked whether directories are left behind too, because 559M for three live
// worktrees did not add up. They are: `git worktree prune` removes the REGISTRATION in
// .git/worktrees, not the checkout on disk, so a directory whose registration is gone (or
// which was never a worktree — a copied folder, a failed create) is invisible to every git
// command and to `du`-blind eyes alike. Reported, never deleted: this script does not
// recursively remove directories it did not create.
const worktreeDir = join(root, ".claude", "worktrees");
if (existsSync(worktreeDir)) {
	const registered = new Set(worktreeBlocks.map((b) => b.match(/^worktree (.+)$/m)?.[1]).filter(Boolean));
	const orphanDirs = readdirSync(worktreeDir)
		.map((n) => join(worktreeDir, n))
		.filter((p) => {
			try {
				return statSync(p).isDirectory() && !registered.has(p);
			} catch {
				return false;
			}
		});
	if (orphanDirs.length) {
		console.log(`  ${orphanDirs.length} director(ies) under .claude/worktrees/ with no worktree registration:`);
		for (const p of orphanDirs) console.log(`    · ${p}`);
		console.log("    Not deleted. Check for uncommitted work, then `rm -rf` them by hand.\n");
	}
}

// Exit 0 even when work was refused: this is a maintenance command a human runs, not a
// gate. It reports; it does not fail a build.
