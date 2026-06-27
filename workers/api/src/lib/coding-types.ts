/**
 * Types for the coding-workspace control plane (the AgentCoder port).
 *
 * Adapted from AgentCoder `shared/src/types/{agent,server,repo}.ts`, retargeted
 * from Firestore docs onto PAGS's D1 rows (durable registry) + AgentDO storage
 * (live session state). A workspace == an `agent_instances` row; repos and
 * sessions key off `instance_id`.
 */

export type CodingClientType = "claude" | "gemini" | "codex" | "grok";

export type CloneStatus = "unknown" | "cloning" | "ready" | "missing_url" | "error";

export type CodingSessionStatus = "active" | "ended" | "error" | "suspended";

/** Live status of the CLI as inferred from the pane (mirrors runner handler state). */
export type CliRunState = "idle" | "thinking" | "responding";

/** A git repo imported into a workspace (D1 `coding_repos`). */
export interface CodingRepo {
	id: string;
	instanceId: string;
	userId: string;
	name: string;
	githubRepo?: string; // "owner/repo"
	cloneUrl?: string;
	branch: string;
	workdir?: string;
	cloneStatus: CloneStatus;
	cloneError?: string;
	defaultClient: CodingClientType;
	/** Launch links — open-in-new-tab icons on the list + session view. */
	urls?: { dev?: string; staging?: string; prod?: string };
	createdAt: string;
	updatedAt: string;
}

/** One AI-coding-CLI session against a repo (D1 `coding_sessions`). */
export interface CodingSessionRecord {
	id: string;
	instanceId: string;
	repoId: string;
	userId: string;
	clientType: CodingClientType;
	status: CodingSessionStatus;
	tmuxSession?: string;
	/** The exact command this session's engine was launched with (e.g. `claude --dangerously-skip-permissions`, `codex`). */
	launchCommand?: string;
	issueNumber?: number;
	issueTitle?: string;
	startedAt: string;
	endedAt?: string;
	updatedAt: string;
}

/** A chat message in a coding session (DO storage, broadcast over WS). */
export interface CodingMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	/** "user" | "brain" | "session-capture" — who produced it. */
	source?: string;
}

/**
 * Live session view held in the AgentDO and pushed to the console over WebSocket.
 * The durable record is in D1; this is the hot, frequently-updated slice.
 */
export interface CodingLiveState {
	sessionId: string;
	repoId: string;
	clientType: CodingClientType;
	runState: CliRunState;
	/** Latest pane snapshot (ANSI-stripped). Capped before storage/broadcast. */
	pane: string;
	updatedAt: number;
}

/**
 * AgentDO storage-key prefixes for coding state. Kept distinct from the existing
 * chat/memory/task/kb namespaces (`msg:`/`mem:`/`task:`/`kb:`) so the coding
 * runtime and the marketplace-agent runtime can share one DO without collisions.
 */
export const CODING_KEYS = {
	/** Live state for a session: `csess:<sessionId>`. */
	session: (sessionId: string) => `csess:${sessionId}`,
	sessionPrefix: "csess:",
	/** A message in a session: `cmsg:<sessionId>:<ts>:<id>` (sorts by time). */
	message: (sessionId: string, ts: number, id: string) =>
		`cmsg:${sessionId}:${String(ts).padStart(16, "0")}:${id}`,
	messagePrefix: (sessionId: string) => `cmsg:${sessionId}:`,
} as const;

/** WebSocket message types the coding console understands. */
export type CodingWsEvent =
	| { type: "coding.pane"; sessionId: string; pane: string; runState: CliRunState }
	| { type: "coding.message"; sessionId: string; message: CodingMessage }
	| { type: "coding.session"; session: CodingLiveState }
	| { type: "coding.ended"; sessionId: string };

/** Hard cap on a pane snapshot we persist/broadcast (DO value + WS frame budget). */
export const MAX_PANE_CHARS = 64 * 1024;
