// Canonical `agent.json` contract for the agent-OS model.
//
// Today the manifest shape is implicit and split between `capabilities` (read by
// workers/api/src/lib/agent-capabilities.ts) and `serverConfig`. This formalizes
// it as one type and adds the `ui` block: how an agent declares the UI surfaces
// it ships, so the console shell can render (P1) and eventually load (P3) them.
// See ../../PLAN-agent-os.md.

/**
 * A capability flag an agent opts into. The host maps these to console tabs and
 * runner runtimes. Mirrors `AgentSurface` in agent-capabilities.ts; open-ended
 * (`string & {}`) so new agents can declare new surfaces without a host edit.
 */
export type AgentCapabilitySurface = "apply" | "coding" | (string & {});

/** Which local runner runtime the agent's hands use (null = no local runner). */
export type AgentRuntimeKind = "browser" | "coding" | null;

export interface AgentCapabilities {
	/** Capability surfaces this agent opts into (drives which tabs/UI show). */
	surfaces: AgentCapabilitySurface[];
	/** Local runner runtime the brain drives. */
	runtime?: AgentRuntimeKind;
	/** Brain workflow binding name, when the agent has an autonomous loop. */
	workflow?: string | null;
}

/**
 * One UI surface an agent ships. In P1 the console renders first-party surfaces
 * from its static registry; `entry` is the published bundle the shell will load
 * dynamically in P3 (the App Store moment) so third-party agents bring their own UI.
 */
export interface AgentUiSurface {
	/** Console surface/tab id this UI fills (e.g. "coding"). */
	surface: string;
	label?: string;
	icon?: string;
	/** Published bundle entry for the surface component — reserved for P3 dynamic load. */
	entry?: string;
}

export interface AgentUi {
	surfaces?: AgentUiSurface[];
}

/** The `agent.json` manifest. */
export interface AgentManifest {
	id: string;
	name: string;
	description?: string;
	storeType?: "agent" | "tool" | "worker";
	category?: string;
	model?: string;
	template?: "worker" | "cron" | "api";
	/** Capability flags the host reads to wire tabs + runner. */
	capabilities?: AgentCapabilities;
	/** UI surfaces this agent ships (agent-OS model). */
	ui?: AgentUi;
	/** Backend/runtime config (routes, collections, runner kind, cron, …). */
	serverConfig?: Record<string, unknown>;
}
