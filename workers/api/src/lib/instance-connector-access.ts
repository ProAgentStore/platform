// Resolving the connector policy for ONE owned instance (#352).
//
// `instance-connector-policy.ts` holds the rule and is pure; this holds the two D1 reads the rule
// needs, so that every door asking "may this agent use this connector" resolves the inputs the
// same way. The alternative was three copies of `capabilitiesForInstance` + `toolNamesFor` +
// `readDisabledTools` — which is how `GET /v1/instances/:id/connectors` and a grant route end up
// disagreeing about the same instance, one showing no panel while the other creates the grant.
//
// The off-switches matter and are not an optional refinement: an owner who disabled
// `search_knowledge` on their copy has made the same agent unable to read what a folder would
// import, and a connector must not be offered — or granted — on the strength of a tool this
// instance would refuse to run.
import { toolNamesFor } from "../agent-do-tools.js";
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { CONNECTORS, getConnector } from "./connectors/registry.js";
import { connectorPolicyOf, connectorRefusal, resolveConnectorPolicy, type ConnectorPolicyEntry } from "./instance-connector-policy.js";
import { readDisabledTools } from "./instance-tool-policy.js";
import type { Env } from "../types.js";

/**
 * The tool names this instance may actually run — the agent's declared allowlist (or the
 * per-surface default when it declares none) minus the owner's own off-switches.
 *
 * The SAME set the chat runtime builds, which is the point: a connector is judged on what this
 * instance can really do, not on what its category suggests.
 */
export async function instanceAllowedTools(
	env: Env,
	instanceId: string,
	userId: string,
	instanceConfig: string | null | undefined,
): Promise<Set<string>> {
	const capabilities = await capabilitiesForInstance(env, instanceId, userId);
	const allowed = toolNamesFor(capabilities ?? undefined);
	for (const name of readDisabledTools(instanceConfig)) allowed.delete(name);
	return allowed;
}

/** Every connector, with this instance's verdict on it. */
export async function instanceConnectorPolicy(
	env: Env,
	instanceId: string,
	userId: string,
	instanceConfig: string | null | undefined,
): Promise<ConnectorPolicyEntry[]> {
	return resolveConnectorPolicy(CONNECTORS, await instanceAllowedTools(env, instanceId, userId, instanceConfig));
}

/**
 * The refusal sentence for ONE connector on this instance, or null when it is allowed.
 *
 * An id with no registry entry returns null — deliberately, and it is not a hole worth closing
 * here. The entire rule is DERIVED from the declaration (`grantModel`, `tools`), so an undeclared
 * connector has no policy to apply and inventing a refusal for one would be the hardcoded
 * per-provider knowledge this issue exists to delete. What keeps that honest is that the callers
 * pass registry ids and a test asserts those ids still resolve — deleting the declaration fails
 * the test rather than silently opening the gate.
 */
export async function connectorRefusalFor(
	env: Env,
	connectorId: string,
	instanceId: string,
	userId: string,
	instanceConfig: string | null | undefined,
): Promise<string | null> {
	const connector = getConnector(connectorId);
	if (!connector) return null;
	return connectorRefusal(connectorPolicyOf(connector, await instanceAllowedTools(env, instanceId, userId, instanceConfig)));
}
