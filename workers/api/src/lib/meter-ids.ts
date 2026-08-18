// Which id is the agent and which is the instance, decided by LOOKUP at the moment a ledger row
// is written (#662).
//
// `AGENT.idFromName(x)` addresses a template DO when `x` is an agent id and an instance DO when
// `x` is an instance id, and the DO stores that string as `AgentState.agentId` either way. It
// holds nothing else: `agent-types.ts` gives `AgentState` no second id, so an instance DO does
// NOT know its template's id and cannot be asked for it.
//
// That is why `agent-do.ts` built the storage meter as `{ userId, agentId }` and left
// `EngineMeter.instanceId` — declared in `agent-storage/base.ts`, read by `vectors.ts` and
// `summaries.ts` — permanently undefined: every platform-paid embedding and summary row landed
// with an INSTANCE id in `agent_id` and NULL in `instance_id`. `lib/usage-ids.ts` documents the
// same confusion from the reading end, where it rendered 26 rows as their own raw UUID.
//
// Guessing is not available. `instanceId = agentId` would be right for an instance DO and wrong
// for a template DO — and wrong in exactly the direction `agent-think.ts` is already wrong, which
// is what put AGENT ids in `instance_id`. One primary-key read settles it, and it is read once
// per engine (i.e. once per unit of work: a repo-ingest tick that embeds 60 chunks reads it once),
// which is the same cost the platform-AI switch above it already pays.

import type { Env } from "../types.js";

/** The pair `recordPlatformUsage` writes into `ai_usage.agent_id` / `ai_usage.instance_id`. */
export interface MeterIds {
	agentId: string | null;
	instanceId: string | null;
}

/**
 * Resolve a Durable Object's own name into the (agent, instance) pair a ledger row should carry.
 *
 * A row in `agent_instances` with this id means the DO is an INSTANCE: the name is the instance
 * id and the template agent id is on that row. No row means it is a template DO, whose name IS
 * the agent id and which has no instance.
 *
 * A D1 failure falls back to the template reading — the pre-#662 behaviour — rather than to a
 * guess. Metering is observability; it must not take a chat turn down, and a NULL `instance_id`
 * is a state every reader already handles, where a fabricated one would be a wrong number in a
 * money ledger.
 */
export async function resolveMeterIds(env: Pick<Env, "DB">, doName: string): Promise<MeterIds> {
	const row = await env.DB.prepare("SELECT agent_id FROM agent_instances WHERE id = ?1")
		.bind(doName)
		.first<{ agent_id: string | null }>()
		.catch(() => null);
	return row?.agent_id ? { agentId: row.agent_id, instanceId: doName } : { agentId: doName, instanceId: null };
}
