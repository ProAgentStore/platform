#!/usr/bin/env node
/**
 * pre-push.mjs — the pre-push trip-wire (#902). Tens of seconds, scoped to what is pushed.
 *
 * Active in every checkout via husky, which `pnpm install` sets up (#1103). CI runs every one of
 * these, and the full suite, on every push regardless — this only catches a red CI before it costs
 * a round trip. Run it by hand with `node scripts/pre-push.mjs` (it then checks against origin/main).
 *
 * 1. CI's guard scripts, with CI's arguments (`CI_GUARDS`), and the docs-drift check.
 * 2. The typecheck of each workspace project the push touches, as CI runs it. Where that needs the host
 *    Worker's generated pages (#1564) they are built if their inputs exist, else the hook stops and says what to build.
 * 3. `vitest related` over the pushed source files — the unit tests that import them. NOT the full
 *    suite (`pnpm -w test:full`), which stays CI's job: a change to a core module can still pull in
 *    a few thousand tests here (about 40s measured), a leaf module a few hundred (about 10s).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { spawnPortableSync } from "./lib/portable-command.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CI_GUARDS, hostPagesPlan, relatedTestTargets, typecheckCommands } from "./lib/hook-plan.mjs";
import { workspaceMembers } from "./lib/workspace-members.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);
const ZERO = /^0+$/;
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

/** A backstop, not a budget: the slowest step measured is about 40s, and a hung test is named sooner by the stall reporter (#1665). */
const STEP_TIMEOUT_MS = 20 * 60_000;

/**
 * Git runs a hook with GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at THIS repository. A test that builds a fixture repo in a
 * temp dir and inherits them operates on the real one instead: it commits "fixture base" over the pushing branch, rewrites the index,
 * creates `wip/recovery`, and writes `core.bare=true` and a fixture identity into the shared config (scripts/lib/fail-before.test.mjs
 * did exactly that during a push). Every step runs from the repo root, so none of them needs the variables.
 */
const REPO_LOCATION_VARS = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];
const stepEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !REPO_LOCATION_VARS.includes(k)));

function run(cmd, args) {
	console.log(`[pre-push] ${cmd} ${args.join(" ")}`);
	const r = spawnPortableSync(cmd, args, { stdio: "inherit", timeout: STEP_TIMEOUT_MS, env: stepEnv() });
	if (r.error?.code === "ETIMEDOUT") {
		console.error(`[pre-push] TIMED OUT after ${STEP_TIMEOUT_MS / 60_000} minutes: ${cmd} ${args.slice(0, 6).join(" ")}. The step never finished; nothing was pushed.`);
		// The timeout kills only the process it started; on Windows its children outlive it.
		if (process.platform === "win32" && r.pid) spawnSync("taskkill", ["/PID", String(r.pid), "/T", "/F"]);
	} else if (r.error) console.error(r.error.message);
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
	const typechecks = typecheckCommands(changed, members, info);
	// #1564: `tsc` has no stub resolver, so a clean checkout's missing generated host pages are built (as CI does) or reported precisely.
	const host = hostPagesPlan(typechecks, (p) => existsSync(join(root, p)));
	if (host.action === "build") run(host.command[0], host.command.slice(1));
	else if (host.action === "report") {
		console.error(host.message);
		process.exit(1);
	}
	for (const [cmd, ...args] of typechecks) run(cmd, args);

	const related = relatedTestTargets(changed);
	if (related.length) run("pnpm", ["exec", "vitest", "related", "--run", "--project", "unit", "--passWithNoTests", ...related]);
}
console.log(`[pre-push] All checks passed (${changed.length} changed file${changed.length === 1 ? "" : "s"}).`);
