/**
 * hook-plan.mjs — what the OPT-IN git hooks check for a given set of changed files (#902).
 *
 * The hooks are a fast local trip-wire, never a gate: CI (`.github/workflows/ci.yml`) enforces
 * every check here independently, on every push, whether or not anyone installed them. So this
 * module only decides WHICH of CI's own checks a change is worth running before it leaves the
 * machine, and states each one exactly as CI runs it.
 *
 * Pure: file lists in, command plans out. `scripts/pre-commit.mjs` and `scripts/pre-push.mjs`
 * run the plans; `hook-plan.test.mjs` pins the mapping and that the guard list matches CI's.
 */

/** CI's Biome step, verbatim: `pnpm exec biome check --error-on-warnings packages workers store agents/coder`. */
export const BIOME_SCOPE = ["packages/", "workers/", "store/", "agents/coder/"];

/** The guard scripts CI runs, with CI's own arguments — the pre-push hook runs exactly these. */
export const CI_GUARDS = [
	["scripts/check-workflow-runner.mjs"],
	["scripts/check-agents-allowlist.mjs"],
	["scripts/check-qa-config.mjs"],
	["scripts/check-file-size.mjs"],
	["scripts/check-migrations.mjs", "--require-history"],
	["scripts/check-surface-lock.mjs", "--require-history"],
	["scripts/check-server-json.mjs"],
	["scripts/check-mcp-parity.mjs"],
	["scripts/check-console-types.mjs"],
	["scripts/check-design-tokens.mjs"],
	["scripts/check-bare-catch.mjs"],
	["scripts/check-silent-slice.mjs"],
	["scripts/check-typecheck-coverage.mjs"],
	["scripts/check-test-isolation.mjs"],
	["scripts/check-doc-citations.mjs"],
];

const BIOME_EXT = /\.(?:[cm]?[jt]sx?|jsonc?)$/;
const TESTABLE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/** Staged/changed files Biome would lint in CI — CI's scope, and only file types it handles. */
export function biomeTargets(files) {
	return files.filter((f) => BIOME_SCOPE.some((d) => f.startsWith(d)) && BIOME_EXT.test(f));
}

/** The workspace member a file belongs to: the longest member path it sits under, or null. */
export function memberOf(file, members) {
	let best = null;
	for (const m of members) if (file.startsWith(`${m}/`) && (!best || m.length > best.length)) best = m;
	return best;
}

/** A root file every project's typecheck reads — changing one re-checks all of them. */
const SHARED_CONFIG = /^(?:tsconfig[^/]*\.json|package\.json|pnpm-lock\.yaml)$/;

/**
 * The typecheck commands a change needs, as CI runs them: each touched project's own `typecheck`
 * script (`pnpm -r typecheck`), plus `tsc -p tsconfig.test.json` where the project has one — CI's
 * separate step for test files, which the production config excludes.
 *
 * @param {string[]} files changed paths, repo-relative
 * @param {string[]} members workspace member dirs (`workspaceMembers`)
 * @param {(dir: string) => { typecheck: boolean; testConfig: boolean }} info what a member has
 * @returns {string[][]} argv lists, in member order
 */
export function typecheckCommands(files, members, info) {
	const touched = files.some((f) => SHARED_CONFIG.test(f)) ? new Set(members) : new Set(files.map((f) => memberOf(f, members)).filter(Boolean));
	const cmds = [];
	for (const dir of members) {
		if (!touched.has(dir)) continue;
		const { typecheck, testConfig } = info(dir);
		if (typecheck) cmds.push(["pnpm", "--dir", dir, "run", "typecheck"]);
		if (testConfig) cmds.push(["pnpm", "--dir", dir, "exec", "tsc", "-p", "tsconfig.test.json"]);
	}
	return cmds;
}

/**
 * The host Worker's generated pages (#1564). `workers/host/src/pages.ts` is build output — `build.js` inlines `store/` into it —
 * and gitignored, so a clean checkout does not have it. Vitest never notices (`vitest.config.ts` routes `./pages.js` to a stub), but
 * `tsc` has no such resolver: the API's cross-package tests import `workers/host/src/index.ts`, which imports `./pages.js`, and
 * `tsc -p tsconfig.test.json` fails with TS2307 on a bare frozen-lockfile install.
 */
export const HOST_PAGES = "workers/host/src/pages.ts";

/** Everything `workers/host/build.js` READS before it can write {@link HOST_PAGES} — it cannot run standalone. */
export const HOST_BUILD_INPUTS = [
	"store/console/dist/assets/bundle.js",
	"store/console/dist/assets/index.css",
	"store/admin/dist/assets/bundle.js",
	"store/admin/dist/assets/index.css",
	"store/docs/sitemap.xml",
];

/** CI's own prerequisite steps for that build, verbatim and in order (`.github/workflows/ci.yml`); `hook-plan.test.mjs` pins them. */
export const HOST_PREREQUISITES = [
	"python3 -m pip install zensical==0.0.44",
	"cd packages/sdk && npx tsc",
	"pnpm docs:build",
	"cd store/console && npx vite build",
	"cd store/admin && npx vite build",
	"cd workers/host && node build.js",
];

/** The projects whose TEST typecheck reaches the host Worker's index (cross-package tests). Add a member here if its tests start to. */
const HOST_TEST_DEPENDENTS = ["workers/api"];

/** The typecheck commands (argv lists, as {@link typecheckCommands} returns them) that need {@link HOST_PAGES} to exist. */
export function commandsNeedingHostPages(cmds) {
	return cmds.filter((argv) => {
		const dir = argv[argv.indexOf("--dir") + 1];
		if (dir === "workers/host") return true; // the host's own program imports ./pages.js
		return HOST_TEST_DEPENDENTS.includes(dir) && argv.includes("tsconfig.test.json");
	});
}

/**
 * What to do about the generated host pages before these typecheck commands run (#1564):
 *   `none`   — nothing needs them, or they exist;
 *   `build`  — they are missing but everything `build.js` reads is on disk: run it, exactly as CI does;
 *   `report` — they are missing AND so is something `build.js` needs: stop, and say precisely what and how, instead of letting
 *              `tsc` fail with a bare TS2307 that names neither the file nor the way back.
 * Nothing is faked: no stub declaration is ever written for `tsc`.
 *
 * @param {string[][]} cmds the typecheck commands about to run
 * @param {(repoRelativePath: string) => boolean} exists
 */
export function hostPagesPlan(cmds, exists) {
	const needing = commandsNeedingHostPages(cmds);
	if (!needing.length || exists(HOST_PAGES)) return { action: "none" };
	const missing = HOST_BUILD_INPUTS.filter((p) => !exists(p));
	if (!missing.length) return { action: "build", command: ["node", "workers/host/build.js"] };
	return { action: "report", missing, needing, message: hostPagesMessage(missing, needing) };
}

/** The refusal, written for someone standing in a clean checkout with a push that just stopped. */
export function hostPagesMessage(missing, needing) {
	return [
		`[pre-push] ${HOST_PAGES} is missing, and it is build output (gitignored), so a clean checkout never has it.`,
		`  \`tsc\` cannot resolve ./pages.js without it, so this step would fail with TS2307: ${needing.map((a) => a.join(" ")).join("; ")}`,
		"  Building it needs files that are missing too:",
		...missing.map((p) => `    - ${p}`),
		"  Build them the way CI does, in this order, then push again:",
		...HOST_PREREQUISITES.map((c) => `    ${c}`),
		"  (Nothing was pushed. The hook never writes a stand-in for pages.ts: that would hide a real failure.)",
	].join("\n");
}

/** Files `vitest related` can trace — it runs the tests that import them, and changed tests themselves. */
export function relatedTestTargets(files) {
	return files.filter((f) => TESTABLE_EXT.test(f) && !f.endsWith(".d.ts"));
}
