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

export interface CodingEngine {
	id: string;
	label: string;
	command: string;
}
