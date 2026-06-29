/**
 * Agent capability registry.
 *
 * The platform hosts many agent types, but historically behaviour was hardcoded
 * to specific agents via scattered `slug === 'job-application-assistant'` /
 * `category === 'code'` conditionals. This is the one place that maps an agent to
 * what it actually needs — which console surfaces it shows, which runner runtime
 * its hands use, which brain workflow drives it. Consumers (console, routes) read
 * THIS instead of branching on agent identity, so a new agent type is data (a
 * declared capability), not edits scattered across the codebase.
 *
 * Source of truth is `agents.config.capabilities` (declared per agent). For
 * agents that predate the registry we derive a sensible default from slug/
 * category, so nothing needs a migration to keep working.
 */

/** A console surface an agent opts into (drives tabs + which UI blocks render). */
export type AgentSurface = "apply" | "coding" | "insurance" | "repo";

/** Which local runner runtime the agent's hands use (null = no local runner). */
export type AgentRuntimeKind = "browser" | "coding" | null;

export interface AgentCapabilities {
	/** Console surfaces this agent shows (e.g. the Coding tab, the apply UI). */
	surfaces: AgentSurface[];
	/** Local runner runtime the brain drives. */
	runtime: AgentRuntimeKind;
	/** Brain workflow binding name, when the agent has an autonomous loop. */
	workflow: "JOB_APPLY" | "CODING_SESSION" | "INSURANCE_QUOTES" | null;
}

const EMPTY: AgentCapabilities = { surfaces: [], runtime: null, workflow: null };
const KNOWN_SURFACES = new Set<AgentSurface>(["apply", "coding", "insurance", "repo"]);

/** Minimal shape we need off an `agents` row to resolve capabilities. */
export interface AgentLike {
	slug?: string | null;
	category?: string | null;
	config?: string | null;
}

function parseConfig(config: string | null | undefined): Record<string, unknown> {
	if (!config) return {};
	try {
		return JSON.parse(config) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Resolve an agent's capabilities. Explicit `config.capabilities` wins; otherwise
 * derive from the well-known first-party agents so legacy rows keep working.
 */
export function agentCapabilities(agent: AgentLike): AgentCapabilities {
	const cfg = parseConfig(agent.config);
	const declared = cfg.capabilities as Partial<AgentCapabilities> | undefined;
	if (declared && Array.isArray(declared.surfaces)) {
		return {
			surfaces: declared.surfaces.filter((s): s is AgentSurface => KNOWN_SURFACES.has(s as AgentSurface)),
			runtime: declared.runtime ?? null,
			workflow: declared.workflow ?? null,
		};
	}

	// Fallback derivation (pre-registry agents).
	if (agent.slug === "job-application-assistant") {
		return { surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" };
	}
	if (agent.slug === "coder" || agent.category === "code") {
		return { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" };
	}
	if (agent.slug === "like4like-insurance-quotes" || agent.category === "insurance") {
		return { surfaces: ["insurance"], runtime: "browser", workflow: "INSURANCE_QUOTES" };
	}
	return EMPTY;
}

/** True if the agent opts into a given console surface. */
export function hasSurface(agent: AgentLike, surface: AgentSurface): boolean {
	return agentCapabilities(agent).surfaces.includes(surface);
}
