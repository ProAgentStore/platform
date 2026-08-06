/**
 * D1 access for stats cards (#310/#312).
 *
 * Separate from the pure `stats-schema.ts` so the card table, the validator and the merge rules
 * stay testable without a database — and so the route, the MCP tools and the agent's own
 * `set_stats_card` share ONE read/write path rather than each doing their own JSON surgery on
 * `config`. That is the whole safety story of #312: there is no privileged path that skips
 * validation, so "the agent configured it" and "the user configured it" cannot diverge in what they
 * are allowed to express.
 */
import { patchInstanceConfig } from "./instance-config.js";
import {
	applyStatsCardOps,
	resolveStatsCards,
	sanitizeStatsOverride,
	sanitizeStatsSchema,
	validateStatsCards,
	type StatsCard,
	type StatsCardRejection,
	type StatsOverride,
} from "./stats-schema.js";
import type { Env } from "../types.js";

function parse(raw: string | null | undefined): Record<string, unknown> {
	try {
		return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export interface ResolvedInstanceStats {
	/** Creator default merged per card under the subscriber's override — what the tab renders. */
	cards: StatsCard[];
	/** What the creator shipped, so a surface can say "back to the agent's default" honestly
	 *  instead of implying an unset card means the platform has one. */
	templateDefault: StatsCard[];
	/** The subscriber's own layer, so a caller can tell an inherited card from an added one. */
	override: StatsOverride;
}

const SELECT_CONFIGS =
	"SELECT i.config AS config, a.config AS agent_config FROM agent_instances i" +
	" LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2";

/** Owner-scoped: a row that is not this user's simply does not come back, so every caller below is
 *  tenant-isolated by the same rule the rest of the instance surface uses. */
export async function readInstanceStats(env: Env, instanceId: string, userId: string): Promise<ResolvedInstanceStats> {
	const row = await env.DB.prepare(SELECT_CONFIGS).bind(instanceId, userId).first<{ config: string | null; agent_config: string | null }>();
	const instanceCfg = parse(row?.config);
	const agentCfg = parse(row?.agent_config);
	return {
		cards: resolveStatsCards(agentCfg.statsSchema, instanceCfg.stats),
		templateDefault: sanitizeStatsSchema(agentCfg.statsSchema) ?? [],
		override: sanitizeStatsOverride(instanceCfg.stats),
	};
}

/**
 * Replace the subscriber's whole override (the console's Save).
 *
 * Writes only `$.stats` (#231): `set_stats_card` is a tool the AGENT calls, so it fires while the
 * owner may be saving something else in the console — two writers of different keys, and with a
 * whole-blob write the loser vanished silently.
 */
export async function putInstanceStatsOverride(
	env: Env,
	instanceId: string,
	userId: string,
	value: unknown,
): Promise<{ stats: ResolvedInstanceStats; rejected: StatsCardRejection[] }> {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const { rejected } = validateStatsCards(raw.cards);
	const override = sanitizeStatsOverride(raw);
	await patchInstanceConfig(env, instanceId, userId, "stats", override);
	return { stats: await readInstanceStats(env, instanceId, userId), rejected };
}

/**
 * Apply card ops to the subscriber's override — the path `set_stats_card` and the MCP subscriber
 * tool both take.
 *
 * Note it reads and writes only the INSTANCE's own override, never the creator's template. A
 * subscriber's agent editing the agent template would change what every other subscriber gets;
 * this is the same boundary `patchBehaviour` already holds.
 */
export async function patchInstanceStats(
	env: Env,
	instanceId: string,
	userId: string,
	ops: unknown,
): Promise<{ stats: ResolvedInstanceStats; rejected: StatsCardRejection[] }> {
	const row = await env.DB.prepare(SELECT_CONFIGS).bind(instanceId, userId).first<{ config: string | null; agent_config: string | null }>();
	const instanceCfg = parse(row?.config);
	const creatorIds = (sanitizeStatsSchema(parse(row?.agent_config).statsSchema) ?? []).map((c) => c.id);
	const { override, rejected } = applyStatsCardOps(instanceCfg.stats, ops, creatorIds);
	await patchInstanceConfig(env, instanceId, userId, "stats", override);
	return { stats: await readInstanceStats(env, instanceId, userId), rejected };
}

/** The creator side. Owner-checked by the caller (the route), which also lets an admin through —
 *  the same rule every other agent-template write uses. */
export async function readAgentStatsSchema(env: Env, agentId: string): Promise<StatsCard[]> {
	const row = await env.DB.prepare("SELECT config FROM agents WHERE id = ?1").bind(agentId).first<{ config: string | null }>();
	return sanitizeStatsSchema(parse(row?.config).statsSchema) ?? [];
}

export async function writeAgentStatsSchema(
	env: Env,
	agentId: string,
	value: unknown,
): Promise<{ cards: StatsCard[]; rejected: StatsCardRejection[] }> {
	const { cards, rejected } = validateStatsCards(value);
	await env.DB.prepare(
		`UPDATE agents
		    SET config = json_set(
		          CASE WHEN config IS NULL OR config = '' OR NOT json_valid(config) THEN '{}' ELSE config END,
		          '$.statsSchema', json(?1)),
		        updated_at = datetime('now')
		  WHERE id = ?2`,
	)
		.bind(JSON.stringify(cards), agentId)
		.run();
	return { cards, rejected };
}
