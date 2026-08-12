export interface AgentMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	channel: string; // 'chat', 'api', 'cron', 'webhook'
	userId?: string;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
	/** R2 key (a per-turn id) for this message's saved voice audio, if any — the
	 *  console fetches + replays it from the message's speaker button. Set for voice turns. */
	audioKey?: string;
	/** What the LIVE recognizer heard at end-of-turn, when it differs from `content` (#319).
	 *  Small text, so it is stored inline rather than behind a key like `audioKey` — there is
	 *  no blob to point at, and a pointer would cost a fetch to read two sentences. Living ON
	 *  the message is also what gives it the transcript's retention for free: clearing the chat
	 *  deletes the record, and the dictation with it. Absent for typed turns. */
	dictation?: string;
	/** The turn this message belongs to, matching `agent_events.trace_id` for the same turn (#514).
	 *  Stamped on the user message and the assistant reply by the caller that minted the id — the
	 *  console chat route and the Loop both do. Before this the ONLY join between a transcript and
	 *  its trace was a timestamp, and the trace's timestamp was wrong (see routes/instances-chat.ts).
	 *  Optional and additive: a message written before this existed, or over a channel that mints no
	 *  turn id (the WS chat path), simply has none. */
	traceId?: string;
	/** Stamped by `/messages` on an assistant message that claims a tool result the platform never
	 *  wrote (#406). NEVER persisted — it is computed from the message's own text on every read, so
	 *  it reaches rows written before the guard that catches this at generation time (#395) existed,
	 *  in a DO that has been asleep since. The console renders a stamped message as what it is; the
	 *  model does not read its content at all. See lib/fabricated-history.ts. */
	fabricated?: true;
	createdAt: string;
}

export interface ToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolResult {
	toolCallId: string;
	name: string;
	content: string;
	success: boolean;
}

export interface MemoryEntry {
	key: string;
	type: "identity" | "knowledge" | "preference" | "skill" | "context";
	content: string;
	updatedAt: string;
	/** Who wrote this entry. Absent on legacy entries (treated as agent-written). */
	source?: "agent" | "user" | "summary";
}

export interface AgentTask {
	id: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "blocked" | "complete";
	assignedBy: "user" | "self" | "system";
	createdAt: string;
	updatedAt: string;
}

export interface Guardrails {
	topicRestrictions: string; // "Only answer about cooking, nutrition, and recipes"
	blockedTerms: string[]; // Words/phrases the agent should never use
	responseStyle: string; // "professional", "casual", "concise", etc.
	maxResponseLength: number; // 0 = unlimited
	requireCitations: boolean; // Must cite knowledge sources
}

export interface KnowledgeDoc {
	id: string;
	title: string;
	content: string;
	source: "upload" | "url" | "paste" | "google-docs" | "webhook";
	sourceUrl?: string;
	addedAt: string;
	updatedAt?: string;
}

export interface AgentState {
	agentId: string;
	name: string;
	personality: string;
	goal: string;
	model: string;
	status: "idle" | "thinking" | "error";
	systemPrompt: string;
	guardrails: Guardrails;
	welcomeMessage: string; // First message shown to users
	isPublished: boolean;
	/** Capabilities the user has explicitly granted this agent. Off by default. */
	permissions?: AgentPermissions;
}

export interface AgentPermissions {
	/** Allow the agent to read the owner's connected Gmail (read-only, scoped). */
	email?: boolean;
}
