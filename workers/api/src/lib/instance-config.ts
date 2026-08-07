import type { Env } from "../types.js";
import { isValidJsonPathKey, jsonPath } from "./sql.js";

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

/** Config keys are fixed identifiers in code, never user input. They are validated anyway, because
 *  a key that cannot be spelled `$.key` is a document nobody can address later (#327). */
export function isValidConfigKey(key: string): boolean {
	return isValidJsonPathKey(key);
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
	// The PATH is bound, not spliced (#327). `json_set` takes it as an ordinary argument, so a
	// hostile key can only ever become a strange key name inside the document — it cannot end the
	// string literal and continue as SQL, which is what `'$.${key}'` allowed and what left the
	// regex above as the sole boundary. Only `${CONFIG_OR_EMPTY}`, a constant, is spliced now.
	const res = await env.DB.prepare(
		`UPDATE agent_instances
		    SET config = json_set(${CONFIG_OR_EMPTY}, ?1, json(?2)),
		        updated_at = datetime('now')
		  WHERE id = ?3 AND user_id = ?4`,
	)
		.bind(jsonPath(key), JSON.stringify(value ?? null), instanceId, userId)
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
		    SET config = json_remove(${CONFIG_OR_EMPTY}, ?1),
		        updated_at = datetime('now')
		  WHERE id = ?2 AND user_id = ?3`,
	)
		.bind(jsonPath(key), instanceId, userId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

// ── Reading the pair: the instance's config and its template's ───────────────────────────────

/**
 * An instance's own config alongside the creator template's, both parsed.
 *
 * Read together because every consumer needs both — behaviour, stats cards and the chat prompt
 * each resolve "creator default merged under subscriber override" — and one join is cheaper than
 * a second round trip on a per-turn path.
 */
export interface InstanceConfigPair {
	/** `agent_instances.config`. `{}` when absent or malformed. */
	config: Record<string, unknown>;
	/** `agents.config` for the instance's template. `{}` when absent or malformed. */
	agentConfig: Record<string, unknown>;
}

/** A config blob is written by us but read defensively: a malformed one must not fail a turn. */
export function parseConfigBlob(raw: string | null | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

interface ConfigRow {
	config: string | null;
	agent_config: string | null;
}

const toPair = (row: ConfigRow | null): InstanceConfigPair | null =>
	row ? { config: parseConfigBlob(row.config), agentConfig: parseConfigBlob(row.agent_config) } : null;

/**
 * The owner-scoped read. Returns null when the instance does not exist OR is not `userId`'s.
 *
 * This is the one every route and tool must use: `user_id` is a REQUIRED argument, so a caller
 * cannot reach the unscoped read by forgetting an argument — they have to go and pick the other
 * function by name. The SQL is written out in full rather than composed from a shared prefix
 * plus a caller-supplied WHERE, because a helper that takes a clause is exactly the shape that
 * makes tenant scoping something the CALLER remembers instead of something the type demands.
 */
export async function readInstanceConfigPair(env: Env, instanceId: string, userId: string): Promise<InstanceConfigPair | null> {
	const row = await env.DB.prepare(
		`SELECT i.config AS config, a.config AS agent_config
		   FROM agent_instances i
		   LEFT JOIN agents a ON a.id = i.agent_id
		  WHERE i.id = ?1 AND i.user_id = ?2`,
	)
		.bind(instanceId, userId)
		.first<ConfigRow>();
	return toPair(row);
}

/**
 * The same read WITHOUT an owner predicate — for a Durable Object, which has no session.
 *
 * Legitimate exactly once: `AgentDO` is addressed BY the instance id, so by the time this runs
 * the routing layer has already proved the caller owns it and the DO holds only that instance's
 * state. There is no `userId` in scope to check against, and inventing one would be theatre.
 *
 * It is a separate, awkwardly-named function rather than an optional `userId` argument so that
 * every unscoped read is a deliberate act with a name attached, and `sql.test.ts` pins the list
 * of files allowed to call it. If that list ever needs to grow, the question to ask first is
 * whether the new caller genuinely has no user to scope to.
 */
export async function readInstanceConfigPairForDurableObject(env: Env, instanceId: string): Promise<InstanceConfigPair | null> {
	const row = await env.DB.prepare(
		`SELECT i.config AS config, a.config AS agent_config
		   FROM agent_instances i
		   LEFT JOIN agents a ON a.id = i.agent_id
		  WHERE i.id = ?1`,
	)
		.bind(instanceId)
		.first<ConfigRow>();
	return toPair(row);
}
