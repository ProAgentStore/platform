export interface AgentMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	channel: string; // 'chat', 'api', 'cron', 'webhook'
	userId?: string;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
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
