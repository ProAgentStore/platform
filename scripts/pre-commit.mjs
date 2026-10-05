#!/usr/bin/env node
/**
 * pre-commit.mjs — the OPT-IN pre-commit trip-wire (#902). Seconds, staged files only.
 *
 * Installed by `bash scripts/install-hooks.sh`; never active on a fresh clone. CI enforces all of
 * this and much more on every push, so a hook that is skipped (`--no-verify`) or never installed
 * loses nothing but the early warning. Run it by hand with `node scripts/pre-commit.mjs`.
 *
 * Checks, in order: whitespace errors in what is staged; that no checked file also has unstaged
 * edits (or the checks would pass on a fix that is not in the commit); and CI's Biome lint over
 * the staged files it covers. Typecheck and tests are the pre-push hook's job — they take tens of
 * seconds, which a commit should not cost.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { biomeTargets } from "./lib/hook-plan.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);

function run(cmd, args) {
	console.log(`[pre-commit] ${cmd} ${args.join(" ")}`);
	const r = spawnSync(cmd, args, { stdio: "inherit" });
	if (r.error) console.error(r.error.message);
	if (r.error || r.status !== 0) process.exit(r.status || 1);
}

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);

run("git", ["diff", "--cached", "--check"]);

const lint = biomeTargets(staged);
if (lint.length) {
	if (spawnSync("git", ["diff", "--quiet", "--", ...lint]).status !== 0) {
		console.error("[pre-commit] Some files being checked also have UNSTAGED edits. Stage or stash them first, so the check sees exactly what you commit.");
		process.exit(1);
	}
	run("pnpm", ["exec", "biome", "check", "--error-on-warnings", "--no-errors-on-unmatched", "--files-ignore-unknown=true", ...lint]);
}
console.log("[pre-commit] All checks passed.");
