/**
 * Enhanced agent storage types.
 *
 * Architecture:
 * - DO storage: hot data (conversation, memory, tasks, collections, activity)
 * - R2: files (resumes, documents, media) with metadata in DO
 * - Vectorize: semantic search over knowledge + conversation history
 *
 * Collections = agent-defined structured storage (like tables in a DB).
 * Each agent can define schemas and store typed records without provisioning
 * a separate D1 database. Secondary indexes enable field-based lookups.
 *
 * Storage key layout in DO:
 *   state                          → AgentState
 *   msg:{timestamp}:{id}           → AgentMessage
 *   mem:{key}                      → MemoryEntry
 *   task:{id}                      → AgentTask
 *   kb:{id}                        → KnowledgeDoc
 *   file:{id}                      → FileMeta (actual bytes in R2)
 *   col:{name}:_schema             → CollectionSchema
 *   col:{name}:{id}                → CollectionRecord
 *   idx:{name}:{field}:{value}:{id}→ index pointer (value = record id)
 *   evt:{timestamp}:{id}           → ActivityEvent
 *   sum:{sessionId}                → ConversationSummary
 *   vec:{docId}                    → VectorMeta (actual vectors in Vectorize)
 */

// ── Vector Storage ──────────────────────────────────────────────────────────

export interface VectorMeta {
	id: string;
	agentId: string;
	sourceType: "knowledge" | "message" | "file" | "collection";
	sourceId: string;
	chunkIndex: number;
	text: string;
	createdAt: string;
}

export interface VectorSearchResult {
	id: string;
	score: number;
	text: string;
	sourceType: VectorMeta["sourceType"];
	sourceId: string;
}

// ── File Storage ────────────────────────────────────────────────────────────

export interface FileMeta {
	id: string;
	agentId: string;
	userId?: string;
	name: string;
	path: string;
	mimeType: string;
	size: number;
	tags: string[];
	r2Key: string;
	extractionStatus?: "none" | "extracted" | "unsupported" | "failed";
	extractedTextLength?: number;
	extractionError?: string;
	createdAt: string;
	updatedAt: string;
}

// ── Collections (Agent-defined structured storage) ──────────────────────────

export interface CollectionField {
	name: string;
	type: "string" | "number" | "boolean" | "date" | "json" | "reference";
	required?: boolean;
	indexed?: boolean;
	unique?: boolean;
	default?: unknown;
	/** For reference type: collection name being referenced */
	refCollection?: string;
}

export interface CollectionSchema {
	name: string;
	fields: CollectionField[];
	createdAt: string;
	updatedAt: string;
	recordCount: number;
}

export interface CollectionRecord {
	id: string;
	collection: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

// ── Activity Log ────────────────────────────────────────────────────────────

export interface ActivityEvent {
	id: string;
	type:
		| "chat.message"
		| "chat.response"
		| "tool.called"
		| "tool.result"
		| "knowledge.added"
		| "knowledge.removed"
		| "file.uploaded"
		| "file.deleted"
		| "collection.created"
		| "collection.record.created"
		| "collection.record.updated"
		| "collection.record.deleted"
		| "memory.written"
		| "memory.deleted"
		| "task.created"
		| "task.updated"
		| "cron.triggered"
		| "webhook.received"
		| "summary.generated"
		| "email.confirmation_link_found"
		| "error";
	agentId: string;
	userId?: string;
	channel?: string;
	data?: Record<string, unknown>;
	createdAt: string;
}

// ── Conversation Summarization ──────────────────────────────────────────────

export interface ConversationSummary {
	id: string;
	sessionId: string;
	messageRange: {
		from: string; // first message timestamp
		to: string; // last message timestamp
		count: number;
	};
	summary: string;
	/** Key facts extracted from this conversation segment */
	facts: ExtractedFact[];
	createdAt: string;
}

export interface ExtractedFact {
	subject: string;
	predicate: string;
	object: string;
	confidence: number;
}

// ── Per-user Context ────────────────────────────────────────────────────────

export interface UserContext {
	userId: string;
	agentId: string;
	/** User-scoped preferences and facts */
	preferences: Record<string, string>;
	/** Last interaction timestamp */
	lastSeen: string;
	/** Interaction count */
	messageCount: number;
}
