/**
 * No test acts on the repository a git hook points at (#1722).
 *
 * Under a hook (pre-push's `vitest related`, a developer running vitest from lint-staged or a hook of their own) git exports
 * GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE for the REAL repository, and every test that builds a fixture repo and spawns `git`
 * inherits them. Dozens of files do (browser-runner, cli, api, mcp, scripts), so the scrub is applied once here, before any test
 * file loads, rather than at each call site where a new helper would silently miss it. A test that wants one of these passes it
 * in its own child env or with `vi.stubEnv`, both of which are applied after this and unaffected.
 */
import { scrubRepoLocation } from "./scripts/lib/git-repo-env.mjs";

scrubRepoLocation();
