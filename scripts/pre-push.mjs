#!/usr/bin/env node
/**
 * pre-push.mjs — the OPT-IN pre-push trip-wire (#902). Tens of seconds, scoped to what is pushed.
 *
 * Installed by `bash scripts/install-hooks.sh`; never active on a fresh clone. CI runs every one of
 * these, and the full suite, on every push regardless — this only catches a red CI before it costs
 * a round trip. Run it by hand with `node scripts/pre-push.mjs` (it then checks against origin/main).
 *
 * 1. CI's guard scripts, with CI's arguments (`CI_GUARDS`), and the docs-drift check.
 * 2. The typecheck of each workspace project the push touches, as CI runs it.
 * 3. `vitest related` over the pushed source files — the unit tests that import them. NOT the full
 *    suite (`pnpm -w test:full`), which stays CI's job: a change to a core module can still pull in
 *    a few thousand tests here (about 40s measured), a leaf module a few hundred (about 10s).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CI_GUARDS, relatedTestTargets, typecheckCommands } from "./lib/hook-plan.mjs";
import { workspaceMembers } from "./lib/workspace-members.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);
const ZERO = /^0+$/;
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

function run(cmd, args) {
	console.log(`[pre-push] ${cmd} ${args.join(" ")}`);
	const r = spawnSync(cmd, args, { stdio: "inherit" });
	if (r.error) console.error(r.error.message);
	if (r.error || r.status !== 0) process.exit(r.status || 1);
}

/** Git hands a pre-push hook `<local ref> <local sha> <remote ref> <remote sha>` per ref on stdin. */
function pushedRanges() {
	const stdin = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
	const lines = stdin.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 4);
	if (!lines.length) return [["origin/main", "HEAD"]];
	return lines.flatMap(([, localSha, , remoteSha]) => {
		if (ZERO.test(localSha)) return []; // a deleted ref pushes no code
		if (!ZERO.test(remoteSha) && git("cat-file", "-e", remoteSha).status === 0) return [[remoteSha, localSha]];
		const base = git("merge-base", localSha, "origin/main").stdout.trim();
		return base ? [[base, localSha]] : [];
	});
}

const changed = [
	...new Set(
		pushedRanges().flatMap(([from, to]) => git("diff", "--name-only", "--diff-filter=ACMR", from, to).stdout.split("\n").filter(Boolean)),
	),
];

for (const [script, ...args] of CI_GUARDS) run("node", [script, ...args]);
run("pnpm", ["docs:drift"]);

if (changed.length) {
	const members = workspaceMembers(root, readFileSync("pnpm-workspace.yaml", "utf8")).map((m) => m.replace(`${root}/`, ""));
	const info = (dir) => {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return { typecheck: Boolean(pkg.scripts?.typecheck), testConfig: existsSync(join(dir, "tsconfig.test.json")) };
	};
	for (const [cmd, ...args] of typecheckCommands(changed, members, info)) run(cmd, args);

	const related = relatedTestTargets(changed);
	if (related.length) run("pnpm", ["exec", "vitest", "related", "--run", "--project", "unit", "--passWithNoTests", ...related]);
}
console.log(`[pre-push] All checks passed (${changed.length} changed file${changed.length === 1 ? "" : "s"}).`);
