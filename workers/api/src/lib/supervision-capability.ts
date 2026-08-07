// Can this agent delegate at all? (#354)
//
// Supervision is split across two scopes, correctly: the GRAPH is instance-level
// (`agent_supervision`, migration 0060 — you wire two of your own instances together) and the
// ABILITY is agent-level (`delegate_goal` and friends are `supervision` registry tools, and an
// agent only receives them if its `capabilities.tools` declares them). Nothing joined the halves,
// so `POST /v1/instances/:id/supervision` answered 201 for a supervisor whose agent has no
// delegation tool, the row appeared under "Agents this one supervises", and the failure surfaced
// only when the user asked for a delegation and the agent explained that it cannot — which reads
// as the agent being broken rather than the wiring being impossible.
//
// So this is checked at WIRING time, next to the cycle/tower/fan-out rules, and for the same
// stated reason: every one of those is invisible at run time until it has already cost money, and
// the human is present now. It is the same argument `create_connection` makes for validating its
// filter at create time — a filter that silently never matches stops the chain while the
// connection still looks healthy.
//
// Derived from the REGISTRY rather than a copied list of tool names, so a fifth supervision tool
// (or a rename) cannot leave this guard quietly asserting something else.
//
// Deliberately NOT symmetric: the SUBORDINATE needs nothing declared. Being delegated to is not a
// capability, it is just being an instance.
import { toolNamesFor } from "../agent-do-tools.js";
import { getConnector } from "./connectors/registry.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

/** The `supervision` connector's tools, from the one place they are declared. */
export function supervisionToolNames(): string[] {
	return (getConnector("supervision")?.tools ?? []).map((t) => t.name);
}

/** Does this agent's declared tool set contain any supervision tool? */
export function canDelegate(capabilities: AgentCapabilities | null | undefined): boolean {
	if (!capabilities) return true; // unknown, not "no" — see delegationDenial
	const declared = toolNamesFor(capabilities);
	return supervisionToolNames().some((name) => declared.has(name));
}

/**
 * The wiring-time refusal, or null when the edge is usable.
 *
 * A capabilities lookup that came back empty resolves to ALLOW. Ownership of the instance has
 * already been proven by the time this runs, so a null here is a failed read, not evidence — and
 * refusing on evidence we do not have would turn a transient D1 blip into "your agent cannot
 * delegate", which is exactly the confidently-wrong answer this ticket is about, pointed the
 * other way. The runtime gate is unaffected either way: `delegate_goal` still has to be in the
 * agent's allowlist for a delegation to run.
 */
export function delegationDenial(capabilities: AgentCapabilities | null | undefined): string | null {
	return canDelegate(capabilities)
		? null
		: "This agent cannot delegate — its capabilities declare no supervision tools, so the link would never be usable. Wire supervision on an agent that declares them (e.g. delegate_goal).";
}
