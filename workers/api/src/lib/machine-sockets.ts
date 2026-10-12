import { mapWithConcurrency } from "./map-concurrency.js";
import { relayConnected } from "./runner-client.js";
import type { Env } from "../types.js";

/**
 * Which of a machine's instances hold a live socket under ANY of the machine's names — the ONE rule for "is this
 * machine up" (#1055). `list_runner_nodes` and `instance_runner_node` both read it, so they cannot disagree again:
 * the second capped its probes at the 25 oldest registrations and read live machines as down by list position, the
 * defect #898 N1 had already fixed in the first. Every instance is probed; the bound is on concurrency, not coverage.
 */
export async function instanceSocketsUnder(env: Env, instanceIds: readonly string[], names: readonly string[], concurrency = 10): Promise<boolean[]> {
	return mapWithConcurrency([...instanceIds], concurrency, async (instanceId) => {
		for (const name of names) if (await relayConnected(env, instanceId, name).catch(() => false)) return true;
		return false;
	});
}
