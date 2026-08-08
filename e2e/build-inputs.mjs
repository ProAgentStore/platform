/**
 * What must exist, and be current, before the e2e server can serve a truthful bundle (#413).
 *
 * This module holds the ONE build precondition that is still a decision. The app bundles are
 * not: `console-server.mjs` rebuilds them unconditionally, because their input set is a
 * dependency closure nobody can enumerate reliably — see the long note there for the
 * measurement that settled it.
 *
 * `packages/sdk` is the exception, and it is the exception for a checkable reason: it has NO
 * workspace dependencies (`packages/sdk/package.json` lists only `typescript` and `@types/*`
 * as dev deps and React as a peer), and its `tsconfig.json` is `{ include: ["src"], outDir:
 * "dist" }` with no `composite` and no `incremental`. So its input set is exactly one
 * directory, it is complete by construction, and a predicate over it cannot develop the blind
 * spot that motivated this ticket.
 *
 * Why it needs a predicate rather than an unconditional build: the SDK's `dist` is a SHARED
 * artifact. `pnpm typecheck` builds it, `pnpm test` reads it, and on this repo several agents
 * run full suites at once (see the starvation note in `vitest.config.ts`). Rewriting it from
 * inside a Playwright webServer would truncate-and-rewrite files another process is importing.
 * So this half reports, and the human runs the command.
 *
 * Kept out of `console-server.mjs` so the decision is a pure function with unit tests instead
 * of something only observable by running Playwright — which is how the app-bundle predicate
 * stayed wrong for two commits without anybody being able to see it.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Build output, package installs and dotfiles are never INPUTS. Same skips the old predicate used. */
const SKIP = new Set(["dist", "node_modules"]);

/**
 * Newest mtime (ms) of any file under `dir`, or 0 if the directory does not exist.
 *
 * 0-for-missing is deliberate and is what makes `sdkDistVerdict` total: a missing `dist`
 * compares as older than any real source file, so "missing" and "stale" cannot disagree.
 */
export function newestMtimeUnder(dir) {
	let newest = 0;
	const walk = (d) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return; // absent directory — the caller's verdict handles it
		}
		for (const e of entries) {
			if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else newest = Math.max(newest, statSync(p).mtimeMs);
		}
	};
	walk(dir);
	return newest;
}

/**
 * Is the SDK's built `dist` usable as-is? Pure: three numbers/booleans in, a verdict out.
 *
 *   "missing" — nothing to import. The console build dies in rolldown with a 15-line stack
 *               trace that names an unresolved bare specifier and not the command to fix it.
 *   "stale"   — the WORSE one, and the reason this is not just an `existsSync`. The build
 *               SUCCEEDS against yesterday's SDK, so the suite is green about code that is
 *               not the code under test — the same failure #413 reports for the app bundle,
 *               one layer down.
 *   "ok"      — every source file is at least as old as the newest emitted file.
 *
 * Compares NEWEST-dist against NEWEST-src rather than pinning `dist/index.js`, so it stays
 * correct if the SDK ever turns on incremental emit: an incremental `tsc` rewrites only the
 * outputs that changed, which can leave `index.js` untouched and older than a source file it
 * does not depend on. Newest-vs-newest is true under both emit strategies.
 */
export function sdkDistVerdict({ entryExists, newestDistMtime, newestSrcMtime }) {
	if (!entryExists) return "missing";
	// `<` not `<=`: tsc can emit inside the same millisecond as the edit that triggered it,
	// and treating an equal timestamp as stale would fail a build that is in fact current.
	return newestDistMtime < newestSrcMtime ? "stale" : "ok";
}
