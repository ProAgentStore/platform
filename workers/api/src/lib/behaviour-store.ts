import type { Env } from "../types.js";
import { applyBehaviourPatch, resolveBehaviour, sanitizeBehaviour, type Behaviour } from "./agent-behaviour.js";

/**
 * D1 access for agent behaviour (#223/#224).
 *
 * Separate from the pure `agent-behaviour.ts` so the field table, the prompt rendering and the
 * patch rules stay testable without a database, and so the route and the agent's own tool share
 * one read/write path rather than each doing their own JSON surgery on `config`.
 */

/** Creator template default merged under the subscriber's override. */
export async function readBehaviour(env: Env, instanceId: string, userId: string): Promise<Behaviour> {
	const row = await env.DB.prepare(
		"SELECT i.config AS config, a.config AS agent_config FROM agent_instances i" +
			" LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<{ config: string | null; agent_config: string | null }>();
	if (!row) return {};
	const instanceCfg = parse(row.config);
	const agentCfg = parse(row.agent_config);
	return resolveBehaviour(agentCfg.behaviour, instanceCfg.behaviour);
}

/**
 * Apply a patch to the INSTANCE override and persist it.
 *
 * Note this reads and writes only the instance's own override, never the creator's template
 * default — a subscriber (or their agent) changing their mind must not edit the agent every other
 * subscriber gets. The merge with the template happens at read time in {@link readBehaviour}.
 */
export async function patchBehaviour(
	env: Env,
	instanceId: string,
	userId: string,
	patch: unknown,
	allowedIds?: readonly string[],
): Promise<{ behaviour: Behaviour; rejected: string[] }> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string | null }>();
	const cfg = parse(row?.config ?? null);
	const { behaviour, rejected } = applyBehaviourPatch(cfg.behaviour, patch, allowedIds);
	cfg.behaviour = behaviour;
	await env.DB.prepare(
		"UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3",
	)
		.bind(JSON.stringify(cfg), instanceId, userId)
		.run();
	return { behaviour, rejected };
}

/** The subscriber's override alone, unmerged — for a UI that must show what IT set. */
export async function readBehaviourOverride(env: Env, instanceId: string, userId: string): Promise<Behaviour> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string | null }>();
	return sanitizeBehaviour(parse(row?.config ?? null).behaviour).behaviour;
}

function parse(raw: string | null): Record<string, unknown> {
	try {
		return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
