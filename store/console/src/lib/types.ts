export interface Agent {
	id: string;
	slug: string;
	name: string;
	description: string;
	category: string;
	model: string;
	visibility: "draft" | "published" | "unlisted";
	status: "active" | "inactive" | "error";
	icon_bg?: string;
	created_at: string;
	updated_at: string;
	creator_login?: string;
	config?: {
		capabilities?: { surfaces?: string[]; runtime?: string; workflow?: string };
	};
}

export interface CustomSurface {
	id: string;
	label: string;
	icon?: string;
	/** ESM bundle exporting mount(ctx). Loaded by DynamicSurface. */
	bundleUrl: string;
}

export interface Instance {
	id: string;
	agent_id: string;
	slug: string;
	name: string;
	description?: string;
	icon?: string;
	icon_bg?: string;
	category?: string;
	status: string;
	created_at: string;
	capabilities?: {
		surfaces: string[];
		runtime?: string;
		workflow?: string;
		/** Phase 3: agent-published UIs, loaded dynamically from a bundle URL. */
		customSurfaces?: CustomSurface[];
		/** The agent's single work-board columns (server always resolves a default). */
		boardColumns?: BoardColumn[];
	};
}

/** One kanban column on an agent's single work board (mirrors the server type). */
export interface BoardColumn {
	id: string;
	title: string;
	color: string;
	statuses?: string[];
	catchAll?: boolean;
}

export interface Message {
	id?: string;
	role: "user" | "assistant" | "system";
	content: string;
	createdAt?: string;
	/** Per-turn id of this message's saved voice audio (R2); double-tap replays it. */
	audioKey?: string;
}

export interface RuntimeTask {
	id: string;
	type: string;
	status: string;
	title?: string;
	description?: string;
	result?: string;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
	needs_human?: boolean;
	handoff_reason?: string;
	handoff_field?: string;
}

export interface RuntimeEvent {
	id: string;
	type: string;
	message?: string;
	timestamp: string;
	/** The API serves events with createdAt; timestamp is often absent. */
	createdAt?: string;
	/** Runtime events carry taskId at the top level (not under data). */
	taskId?: string;
	data?: Record<string, unknown>;
}

// Coding types (CodingRepo/CodingSession/CodingEngine) live in @proagentstore/coder-web.

export interface KnowledgeDoc {
	id: string;
	title: string;
	content?: string;
	source?: string;
	type?: string;
	createdAt?: string;
}

export interface MemoryEntry {
	key: string;
	type: string;
	content: string;
	updatedAt?: string;
	source?: string;
}

export interface Credential {
	id: string;
	domain: string;
	loginUrl?: string;
	username?: string;
	comments?: string;
	history?: string;
	createdAt?: string;
}

export interface Notification {
	id: string;
	type: string;
	title: string;
	body?: string;
	read: boolean;
	instanceId?: string;
	createdAt: string;
	data?: Record<string, unknown>;
}
