import type { Env } from "../types.js";

/**
 * Patch ONE key of `agent_instances.config` without rewriting the whole blob (#231).
 *
 * The blob holds unrelated concerns — settings, behaviour, board, translation, disabledTools,
 * coding engines, apply state — and sixteen call sites read it whole, changed one key, and
 * wrote it whole. Two requests touching *different* keys therefore lost one of them: both read
 * the same pre-state and the second write clobbered the first. Silently: no error, no conflict,
 * the setting simply doesn't stick.
 *
 * That already shipped a user-visible bug. The Behaviour tab's "Reset group" fired one PUT per
 * field, all five read the same config, and the last write won — so it cleared exactly one
 * field, apparently at random. That caller was fixed by batching (5365774); the pattern was not.
 *
 * `json_set` makes the UPDATE touch only its own subtree, so concurrent writers of different
 * keys both land. It does NOT help two writers of the same key — that is the rarer case, and
 * last-write-wins on one key is a far smaller loss than silently discarding an unrelated one.
 *
 * Verified against real SQLite: `json('…')` bound directly (not through a scalar subquery, which
 * is where migration 0071 documents the JSON subtype being lost) preserves objects and arrays
 * rather than embedding them as escaped strings.
 */

/** Config keys are fixed identifiers in code, never user input — but this is a JSON PATH being
 *  built by string concatenation, so it is validated rather than trusted. */
const CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidConfigKey(key: string): boolean {
	return CONFIG_KEY_RE.test(key);
}

/** `''` (the column default) and malformed JSON both have to become `{}` before json_set can
 *  write into them, or the patch silently no-ops on a fresh instance. */
const CONFIG_OR_EMPTY = "CASE WHEN config IS NULL OR config = '' OR NOT json_valid(config) THEN '{}' ELSE config END";

/**
 * Set `config.<key>` to `value`, leaving every other key untouched.
 * Returns false when the instance doesn't exist or isn't owned by `userId`.
 */
export async function patchInstanceConfig(
	env: Env,
	instanceId: string,
	userId: string,
	key: string,
	value: unknown,
): Promise<boolean> {
	if (!isValidConfigKey(key)) throw new Error(`Invalid config key: ${key}`);
	const res = await env.DB.prepare(
		`UPDATE agent_instances
		    SET config = json_set(${CONFIG_OR_EMPTY}, '$.${key}', json(?1)),
		        updated_at = datetime('now')
		  WHERE id = ?2 AND user_id = ?3`,
	)
		.bind(JSON.stringify(value ?? null), instanceId, userId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** Remove `config.<key>` entirely, leaving every other key untouched. */
export async function removeInstanceConfigKey(
	env: Env,
	instanceId: string,
	userId: string,
	key: string,
): Promise<boolean> {
	if (!isValidConfigKey(key)) throw new Error(`Invalid config key: ${key}`);
	const res = await env.DB.prepare(
		`UPDATE agent_instances
		    SET config = json_remove(${CONFIG_OR_EMPTY}, '$.${key}'),
		        updated_at = datetime('now')
		  WHERE id = ?1 AND user_id = ?2`,
	)
		.bind(instanceId, userId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}
