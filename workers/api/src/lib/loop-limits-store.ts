import type { Env } from "../types.js";
import { patchInstanceConfig, readInstanceConfigPair, removeInstanceConfigKey } from "./instance-config.js";
import { hasLoopLimits, mergeLoopLimits, sanitizeLoopLimitsConfig, type LoopLimitsConfig } from "./loop-limits.js";

/**
 * D1 access for the per-instance iteration bounds (#820) — the mirror of `loop-presets-store.ts`.
 *
 * Instance-only, with no creator-template layer underneath it, and that asymmetry with presets is
 * deliberate. A preset is a suggestion the creator is well placed to write; a floor of 30 is a
 * claim about how much of the SUBSCRIBER's budget one run may spend, and a template that could
 * set it would be a creator raising a stranger's bill. The account ceiling is the only thing above
 * this, and `clampIterations` keeps it authoritative.
 */

const KEY = "loopLimits";

/** The owner's bounds for this instance, or `{}` when none are configured. */
export async function readLoopLimits(env: Env, instanceId: string, userId: string): Promise<LoopLimitsConfig> {
	const pair = await readInstanceConfigPair(env, instanceId, userId);
	if (!pair) return {};
	return sanitizeLoopLimitsConfig(pair.config[KEY]);
}

/**
 * Save the owner's bounds, returning what was actually stored.
 *
 * Clearing BOTH removes the key rather than storing `{}`, so "no limits" is one state rather than
 * two that read identically and compare differently.
 *
 * Writes through `patchInstanceConfig`: `agent_instances.config` also holds settings, behaviour,
 * presets and coding engines, and a read-modify-write of the whole blob silently discards a
 * concurrent change to any of them (#231).
 */
export async function writeLoopLimits(
	env: Env,
	instanceId: string,
	userId: string,
	raw: unknown,
): Promise<LoopLimitsConfig | null> {
	const limits = mergeLoopLimits(await readLoopLimits(env, instanceId, userId), raw);
	// `hasLoopLimits` is iteration-only on purpose (it decides the Pilot's step default), so the
	// objective cap is asked about separately before "nothing configured" removes the key.
	const ok = hasLoopLimits(limits) || limits.maxObjectiveChars !== undefined
		? await patchInstanceConfig(env, instanceId, userId, KEY, limits)
		: await removeInstanceConfigKey(env, instanceId, userId, KEY);
	return ok ? limits : null;
}
