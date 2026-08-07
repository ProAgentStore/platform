import type { Env } from "../types.js";
import { applyBehaviourPatch, resolveBehaviour, type Behaviour } from "./agent-behaviour.js";
import { patchInstanceConfig, readInstanceConfigPair } from "./instance-config.js";

/**
 * D1 access for agent behaviour (#223/#224).
 *
 * Separate from the pure `agent-behaviour.ts` so the field table, the prompt rendering and the
 * patch rules stay testable without a database, and so the route and the agent's own tool share
 * one read/write path rather than each doing their own JSON surgery on `config`.
 */

/** Creator template default merged under the subscriber's override. */
export async function readBehaviour(env: Env, instanceId: string, userId: string): Promise<Behaviour> {
	const pair = await readInstanceConfigPair(env, instanceId, userId);
	if (!pair) return {};
	return resolveBehaviour(pair.agentConfig.behaviour, pair.config.behaviour);
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
	const pair = await readInstanceConfigPair(env, instanceId, userId);
	const { behaviour, rejected } = applyBehaviourPatch(pair?.config.behaviour, patch, allowedIds);
	// Patch only `$.behaviour` (#231). A whole-blob write here is the live version of that bug:
	// `set_behaviour` is a tool the AGENT calls, so it fires while the owner may be saving
	// Settings in the console — two writers, different keys, and the loser vanished silently.
	await patchInstanceConfig(env, instanceId, userId, "behaviour", behaviour);
	// RESOLVED, not the bare override. A read returns the creator default merged under the
	// subscriber's, so returning only the override after a write made the two disagree: on an agent
	// that ships defaults, changing one field appeared to erase all the others until reload, and
	// set_behaviour reported a manner the agent does not actually have.
	return { behaviour: resolveBehaviour(pair?.agentConfig.behaviour, behaviour), rejected };
}
