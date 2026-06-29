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

/** A custom (agent-published) console surface — its UI loads from a bundle URL. */
export interface CustomSurface {
	id: string;
	label: string;
	icon?: string;
	bundleUrl: string;
}

export interface AgentCapabilities {
	/** Console surfaces this agent shows (e.g. the Coding tab, the apply UI). */
	surfaces: AgentSurface[];
	/** Local runner runtime the brain drives. */
	runtime: AgentRuntimeKind;
	/** Brain workflow binding name, when the agent has an autonomous loop. */
	workflow: "JOB_APPLY" | "CODING_SESSION" | "INSURANCE_QUOTES" | null;
	/** Phase 3: agent-published UIs the console loads dynamically from bundles. */
	customSurfaces?: CustomSurface[];
}

/** Validate declared custom surfaces — these load as CODE into the console origin,
 *  so require an https bundle URL and reject anything malformed. */
function sanitizeCustomSurfaces(value: unknown): CustomSurface[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: CustomSurface[] = [];
	for (const v of value) {
		if (!v || typeof v !== "object") continue;
		const o = v as Record<string, unknown>;
		const id = typeof o.id === "string" ? o.id : "";
		const label = typeof o.label === "string" ? o.label : "";
		const bundleUrl = typeof o.bundleUrl === "string" ? o.bundleUrl : "";
		if (!id || !label || !/^https:\/\//.test(bundleUrl)) continue;
		out.push({ id, label, bundleUrl, icon: typeof o.icon === "string" ? o.icon : undefined });
	}
	return out.length ? out : undefined;
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
	// Honor declared custom surfaces in EVERY path — even an agent that doesn't declare
	// a `surfaces` array (e.g. a generic agent that only ships its own UI).
	const customSurfaces = sanitizeCustomSurfaces((declared as Record<string, unknown> | undefined)?.customSurfaces);

	if (declared && Array.isArray(declared.surfaces)) {
		return {
			surfaces: declared.surfaces.filter((s): s is AgentSurface => KNOWN_SURFACES.has(s as AgentSurface)),
			runtime: declared.runtime ?? null,
			workflow: declared.workflow ?? null,
			customSurfaces,
		};
	}

	// Fallback derivation (pre-registry agents) — still attach any declared customSurfaces.
	let base: AgentCapabilities;
	if (agent.slug === "job-application-assistant") {
		base = { surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" };
	} else if (agent.slug === "coder" || agent.category === "code") {
		base = { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" };
	} else if (agent.slug === "like4like-insurance-quotes" || agent.category === "insurance") {
		base = { surfaces: ["insurance"], runtime: "browser", workflow: "INSURANCE_QUOTES" };
	} else {
		base = { ...EMPTY };
	}
	return { ...base, customSurfaces };
}

/** True if the agent opts into a given console surface. */
export function hasSurface(agent: AgentLike, surface: AgentSurface): boolean {
	return agentCapabilities(agent).surfaces.includes(surface);
}
