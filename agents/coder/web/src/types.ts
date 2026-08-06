// Coder-specific types. Live with the coder UI (not the shared console types),
// since only this agent uses them. See ../../../../PLAN-agent-os.md.

export interface CodingRepo {
	id: string;
	name: string;
	workdir?: string;
	cloneStatus?: string;
	githubRepo?: string;
	urls?: { dev?: string; staging?: string; prod?: string };
	instructions?: string;
}

export interface CodingSession {
	id: string;
	repoId: string;
	status: "active" | "suspended" | "ended";
	clientType?: string;
	launchCommand?: string;
	createdAt?: string;
}

/**
 * A one-tap objective in the loop form (#234), served by `/v1/instances/:id/loop-presets`.
 *
 * Not a coder-only idea — the Assistant tab renders the same list — but the shapes agree because
 * both read the one endpoint, which is the point: they used to be five literals in CodingTab.
 */
export interface LoopPreset {
	id: string;
	label: string;
	objective: string;
}

export type EngineAuth = "auto" | "machine" | "subscription" | "api-key";

export interface CodingEngine {
	id: string;
	label: string;
	command: string;
	auth?: EngineAuth;
}
