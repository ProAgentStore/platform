/**
 * What environment the Engine's process actually gets.
 *
 * Extracted from `headless.ts` when #679 added the second decision made at this seam. There are
 * now two, they are asked at the same three call sites (both spawns and `authResolved`), and
 * `headless.ts` sat one line under its size pin — so the concern gets a file rather than the pin
 * getting a raise. `engine-auth.ts` READS this env; this builds it.
 *
 *  1. {@link mergeEnv} — the platform's overlay over the machine's, where empty means REMOVE.
 *  2. {@link engineSpawnEnv} — that, plus the `gh` guard ahead of the real binary on `PATH`.
 */

import { ghGuardEnv } from "./gh-guard.js";

/**
 * Merge the platform's resolved engine env over the machine's, where an EMPTY value means
 * REMOVE rather than "set to empty".
 *
 * Needed because the machine env is inherited wholesale: a developer with ANTHROPIC_API_KEY in
 * their shell handed it to every engine, and Claude Code prefers an API key over the
 * subscription token — so choosing "subscription" injected CLAUDE_CODE_OAUTH_TOKEN and then
 * silently lost, billing per token anyway. Without a way to express removal the setting could
 * not mean what it said.
 */
export function mergeEnv(base: NodeJS.ProcessEnv, overlay: Record<string, string> | undefined): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...base };
	for (const [k, v] of Object.entries(overlay ?? {})) {
		if (v === "") delete out[k];
		else out[k] = v;
	}
	return out;
}

/**
 * The env a turn is spawned with: the merged env, with the `gh` write guard on `PATH` when the
 * platform named a scope for this session (#679).
 *
 * ONE expression, called everywhere the question is asked — including `authResolved`, whose whole
 * contract is that it reports the env the next turn is spawned with rather than the configured
 * intent. Two expressions here is how that guarantee quietly stops being true.
 *
 * `ghGuardEnv` returns its input untouched whenever the guard cannot be installed, so this is safe
 * in front of every spawn: the failure mode is the machine's own `gh`, never a missing one.
 */
export function engineSpawnEnv(overlay: Record<string, string> | undefined, ghScope: readonly string[] | undefined, ghGuardRoot?: string): NodeJS.ProcessEnv {
	return ghGuardEnv(mergeEnv(process.env, overlay), ghScope, ghGuardRoot);
}
