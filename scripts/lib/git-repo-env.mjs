/**
 * The git environment variables that say WHICH repository a git command acts on, or inject config into it (#1722).
 *
 * Git runs a hook with GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at the real repository. A test fixture that builds a
 * repo in a temp dir and spawns `git` inherits them and operates on the real one: it committed "fixture base" over the pushing
 * branch, replaced the index, created `wip/recovery`, and wrote `core.bare=true` and a fixture identity into the shared config.
 * `GIT_CONFIG_*` is in the set for the same reason: `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` and `GIT_CONFIG_PARAMETERS` (what
 * `git -c` hands a hook) override config for every child, and `GIT_CONFIG_GLOBAL` redirects where `--global` writes go.
 */
const NAMED = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
]);

/** True for a variable that must not reach a child that builds or inspects some OTHER repository. */
export const isRepoLocationVar = (name) => NAMED.has(name) || name === "GIT_CONFIG" || name.startsWith("GIT_CONFIG_");

/** A copy of `env` without the repo-location variables. */
export const withoutRepoLocation = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !isRepoLocationVar(k)));

/** Delete the repo-location variables from `env` in place (default: this process, so every child inherits the scrub). */
export function scrubRepoLocation(env = process.env) {
	for (const k of Object.keys(env)) if (isRepoLocationVar(k)) delete env[k];
	return env;
}
