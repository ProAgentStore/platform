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
	/**
	 * May this surface replace the page header while it is active? Same capability the built-in
	 * registry declares with `ownsHeader` — a published surface is not a second-class citizen.
	 */
	ownsHeader?: boolean;
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
		/**
		 * The agent's DECLARED tool allowlist (absent when it declares none, meaning the server
		 * grants a per-surface default). Tabs that are only meaningful for certain tools gate on
		 * this — see SurfaceCaps in lib/surfaces.
		 */
		tools?: string[];
		/** Phase 3: agent-published UIs, loaded dynamically from a bundle URL. */
		customSurfaces?: CustomSurface[];
		/** The agent's single work-board columns (server always resolves a default). */
		boardColumns?: BoardColumn[];
		/** Typed per-instance settings the agent declares (rendered on Settings). */
		settingsSchema?: SettingsField[];
	/** Per-surface options; see workers/api/src/lib/surface-options.ts. */
	surfaceOptions?: Record<string, { repos?: string; drive?: boolean; copilot?: boolean }>;
	};
}

/**
 * What the shell knows about this agent's runner, so a surface can render an offline state
 * instead of discovering one by failing a relay round-trip (#378).
 *
 * Read from `GET /v1/instances/:id/runtime/status`, which the page already polls for the header
 * dot — so this is a fact being PASSED DOWN, not a second poll of the console's most expensive
 * endpoint, and the tab cannot end up contradicting the dot above it.
 */
export interface RunnerPresence {
	/** `relay.connected` — the live socket, pin-aware (#238). `null` until the first answer lands. */
	online: boolean | null;
	/** The machine that socket is (or would be) on. */
	node?: string;
	/**
	 * `diagnoseAttachment` (#237): why it isn't attached and the one command that fixes it. Absent
	 * when the status probe answered without one (a transient blip), which is why every consumer
	 * must carry its own fallback sentence rather than rendering an empty line.
	 */
	attachment?: { message?: string; remedy?: string | null } | null;
}

/** One option of a select settings field (mirrors the server type). */
export interface SettingsFieldOption {
	value: string;
	label: string;
}

/** One typed setting a subscriber configures per-instance (mirrors the server type). */
export interface SettingsField {
	id: string;
	label: string;
	description?: string;
	type: "select" | "text" | "number" | "toggle";
	options?: SettingsFieldOption[];
	default?: string | number | boolean;
	/** Saving this field also sets the voice language (option values are BCP-47 tags). */
	voiceLanguage?: boolean;
}

/** One kanban column on an agent's single work board (mirrors the server type). */
export interface BoardColumn {
	id: string;
	title: string;
	color: string;
	statuses?: string[];
	catchAll?: boolean;
}

/** A message's translation + transliteration (the Assistant's learning display). */
export interface MessageGloss {
	translation: string;
	transliteration?: string;
	/** Word-by-word [original, romanization] pairs for the interlinear grid. */
	pairs?: Array<[string, string]>;
}

export interface Message {
	id?: string;
	role: "user" | "assistant" | "system";
	content: string;
	createdAt?: string;
	/** Per-turn id of this message's saved voice audio (R2); the speaker button replays it. */
	audioKey?: string;
	/** What the live recognizer heard at end-of-turn, when it differs from `content` (#319).
	 *  Present only on voice turns where there is a second reading worth comparing. */
	dictation?: string;
	/** Cached gloss attached server-side (renders in the same paint as the message —
	 *  only uncached messages translate client-side). */
	gloss?: MessageGloss;
	/** The API stamped this assistant message as claiming a tool result no tool produced (#406).
	 *  Computed server-side on every read, so it appears on rows written before the guard that
	 *  catches this at generation time (#395) existed. The text is still shown — the user acted on
	 *  it and deleting it would rewrite the record — but it must not read as a real answer, and the
	 *  agent no longer reads it at all. */
	fabricated?: boolean;
}

export interface RuntimeTask {
	id: string;
	type: string;
	status: string;
	title?: string;
	description?: string;
	/** The *why* behind the ticket — pipeline/audit provenance, rendered on the detail page. */
	reasoning?: string;
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

/**
 * A task in the instance Durable Object's `task:` store — the agent's own list, injected into
 * its prompt every turn (#337). Distinct from `RuntimeTask`, which is the Board.
 */
export interface AgentTaskEntry {
	id: string;
	title: string;
	description?: string;
	status: string;
	/** Provenance: "user" is owner-written and marked (user-set) in the prompt. */
	assignedBy?: "user" | "self" | "system";
	createdAt?: string;
	updatedAt?: string;
	/** Server-computed: too old to still be injected, but not deleted. */
	stale?: boolean;
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
	/**
	 * `/v1/notifications` returns rows straight from D1, so the wire shape is snake_case — see
	 * `NotificationLike` in lib/nextAgent.ts, which had it right. The camelCase fields below are
	 * what the page WISHED for: `createdAt` was always undefined, so every row rendered
	 * "Invalid Date". Both are declared, and readers must tolerate either.
	 */
	created_at?: string;
	createdAt?: string;
	/**
	 * `alert` = a run has stopped and is waiting for you; `update` = news (#361). Absent on rows
	 * written before migration 0093.
	 */
	kind?: "alert" | "update";
	/**
	 * Where clicking it should land — the same same-origin console path the push notification
	 * carries (#338). Stored per row since migration 0026 and returned by `SELECT *`; the list
	 * simply never read it, so an in-app row for a deploy (which has no `instanceId`) did nothing.
	 */
	url?: string;
	data?: Record<string, unknown>;
}
