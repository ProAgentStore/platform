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
	["scripts/check-agents-allowlist.mjs"],
	["scripts/check-qa-config.mjs"],
	["scripts/check-file-size.mjs"],
	["scripts/check-migrations.mjs", "--require-history"],
	["scripts/check-surface-lock.mjs", "--require-history"],
	["scripts/check-mcp-parity.mjs"],
	["scripts/check-console-types.mjs"],
	["scripts/check-design-tokens.mjs"],
	["scripts/check-bare-catch.mjs"],
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

/** Files `vitest related` can trace — it runs the tests that import them, and changed tests themselves. */
export function relatedTestTargets(files) {
	return files.filter((f) => TESTABLE_EXT.test(f) && !f.endsWith(".d.ts"));
}
