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

export type SettingsFieldType = "select" | "text" | "number" | "toggle";

export interface SettingsFieldOption {
	value: string;
	label: string;
}

/**
 * One typed setting a subscriber configures per-instance (console Settings tab).
 * Declared by the creator at `agents.config.settingsSchema`; values live at
 * `agent_instances.config.settings` and are injected into the chat prompt as an
 * authoritative `## Settings` block (see lib/instance-settings.ts).
 */
export interface SettingsField {
	id: string;
	label: string;
	description?: string;
	type: SettingsFieldType;
	/** Required for (and only valid on) type "select". */
	options?: SettingsFieldOption[];
	default?: string | number | boolean;
	/** Select whose option values are BCP-47 tags — saving it also sets the
	 *  instance's voice-settings language so STT/TTS follow. */
	voiceLanguage?: boolean;
}

/**
 * One kanban column on the agent's single work board. The platform provides the
 * board; each agent declares its columns/statuses (flexible statuses). A card
 * (one per work item) lands in the first column whose `statuses` include its
 * status, or the `catchAll` column. See BoardTab.tsx / instance_board.
 */
export interface BoardColumn {
	id: string;
	title: string;
	color: string;
	/** Runtime-task statuses that belong in this column. */
	statuses?: string[];
	/** Bucket for any status not claimed by another column. */
	catchAll?: boolean;
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
	/** The agent's single work board columns — declared, else a per-surface default. */
	boardColumns: BoardColumn[];
	/** Typed per-instance settings the agent declares (subscriber sets values). */
	settingsSchema?: SettingsField[];
}

/**
 * Apply agents run one browser task per job: a "completed" run means submitted.
 * The columns after Submitted (Interview/Offer/Rejected) are human-driven — the
 * automation never sets them; the user moves a card there (persisted as a board
 * item override). See lib/board.ts.
 */
const APPLY_BOARD_COLUMNS: BoardColumn[] = [
	{ id: "waiting", title: "Waiting", color: "#eab308", statuses: ["queued", "needs_approval"] },
	{ id: "applying", title: "Applying", color: "#3b82f6", statuses: ["running"] },
	{ id: "needs_human", title: "Needs you", color: "#f59e0b", statuses: ["needs_human"] },
	{ id: "failed", title: "Failed", color: "#ef4444", statuses: ["failed"] },
	{ id: "blocked", title: "Blocked", color: "#f97316", statuses: ["blocked"] },
	{ id: "submitted", title: "Submitted", color: "#22c55e", statuses: ["completed", "submitted"] },
	{ id: "interview", title: "Interview", color: "#8b5cf6", statuses: ["interview"] },
	{ id: "offer", title: "Offer", color: "#14b8a6", statuses: ["offer", "accepted"] },
	{ id: "rejected", title: "Rejected", color: "#6b7280", statuses: ["rejected"] },
	{ id: "cancelled", title: "Cancelled", color: "#a3a3a3", statuses: ["cancelled"] },
];

/** Generic runtime board for any other agent with a task runner. */
const DEFAULT_BOARD_COLUMNS: BoardColumn[] = [
	{ id: "waiting", title: "Waiting", color: "#eab308", statuses: ["queued", "needs_approval"] },
	{ id: "running", title: "Running", color: "#3b82f6", statuses: ["running"] },
	{ id: "needs_human", title: "Needs you", color: "#f59e0b", statuses: ["needs_human"] },
	{ id: "failed", title: "Failed", color: "#ef4444", statuses: ["failed"] },
	{ id: "blocked", title: "Blocked", color: "#f97316", statuses: ["blocked"] },
	{ id: "done", title: "Done", color: "#22c55e", statuses: ["completed"] },
	{ id: "cancelled", title: "Cancelled", color: "#a3a3a3", statuses: ["cancelled"] },
];

/** The default board columns for an agent that hasn't declared its own. */
export function defaultBoardColumns(surfaces: AgentSurface[]): BoardColumn[] {
	return surfaces.includes("apply") ? APPLY_BOARD_COLUMNS : DEFAULT_BOARD_COLUMNS;
}

/** Validate a declared board-columns array (each needs id + title). */
function sanitizeBoardColumns(value: unknown): BoardColumn[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: BoardColumn[] = [];
	for (const v of value) {
		if (!v || typeof v !== "object") continue;
		const o = v as Record<string, unknown>;
		const id = typeof o.id === "string" ? o.id : "";
		const title = typeof o.title === "string" ? o.title : "";
		if (!id || !title) continue;
		out.push({
			id,
			title,
			color: typeof o.color === "string" ? o.color : "#a3a3a3",
			statuses: Array.isArray(o.statuses) ? o.statuses.filter((s): s is string => typeof s === "string") : undefined,
			catchAll: o.catchAll === true,
		});
	}
	return out.length ? out : undefined;
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

const MAX_SETTINGS_FIELDS = 12;
const MAX_SELECT_OPTIONS = 30;
const SETTINGS_ID_RE = /^[a-z0-9_-]{1,40}$/;

/** Validate a declared settings schema — drop malformed fields, cap counts,
 *  dedupe ids. A select without valid options is unusable and dropped. Exported:
 *  the PUT /v1/agents/:id/settings-schema route sanitizes with the same rules. */
export function sanitizeSettingsSchema(value: unknown): SettingsField[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: SettingsField[] = [];
	const seen = new Set<string>();
	for (const v of value) {
		if (out.length >= MAX_SETTINGS_FIELDS) break;
		if (!v || typeof v !== "object") continue;
		const o = v as Record<string, unknown>;
		const id = typeof o.id === "string" ? o.id.trim() : "";
		const label = typeof o.label === "string" ? o.label.trim().slice(0, 80) : "";
		const type = o.type;
		if (!SETTINGS_ID_RE.test(id) || !label || seen.has(id)) continue;
		if (type !== "select" && type !== "text" && type !== "number" && type !== "toggle") continue;
		seen.add(id);
		const field: SettingsField = { id, label, type };
		if (typeof o.description === "string" && o.description.trim()) {
			field.description = o.description.trim().slice(0, 200);
		}
		if (type === "select") {
			const options = (Array.isArray(o.options) ? o.options : [])
				.flatMap((opt): SettingsFieldOption[] => {
					if (!opt || typeof opt !== "object") return [];
					const po = opt as Record<string, unknown>;
					const optValue = typeof po.value === "string" ? po.value.trim().slice(0, 60) : "";
					if (!optValue) return [];
					const lbl = typeof po.label === "string" && po.label.trim() ? po.label.trim().slice(0, 80) : optValue;
					return [{ value: optValue, label: lbl }];
				})
				.slice(0, MAX_SELECT_OPTIONS);
			if (options.length === 0) continue;
			field.options = options;
			if (o.voiceLanguage === true) field.voiceLanguage = true;
			if (typeof o.default === "string" && options.some((x) => x.value === o.default)) field.default = o.default;
		} else if (type === "text") {
			if (typeof o.default === "string") field.default = o.default.slice(0, 500);
		} else if (type === "number") {
			if (typeof o.default === "number" && Number.isFinite(o.default)) field.default = o.default;
		} else if (type === "toggle") {
			if (typeof o.default === "boolean") field.default = o.default;
		}
		out.push(field);
	}
	return out.length ? out : undefined;
}

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
	// Declared columns win; otherwise the per-surface default is filled in below so the
	// console/MCP always get a concrete board without any client-side default.
	const declaredColumns = sanitizeBoardColumns((declared as Record<string, unknown> | undefined)?.boardColumns);
	// Settings schema lives at TOP-LEVEL config.settingsSchema (sibling of capabilities)
	// so the seed migrations' json_set('$.settingsSchema', …) is unconditionally
	// idempotent. Honored in every path, like customSurfaces.
	const settingsSchema = sanitizeSettingsSchema(cfg.settingsSchema);

	if (declared && Array.isArray(declared.surfaces)) {
		const surfaces = declared.surfaces.filter((s): s is AgentSurface => KNOWN_SURFACES.has(s as AgentSurface));
		return {
			surfaces,
			runtime: declared.runtime ?? null,
			workflow: declared.workflow ?? null,
			customSurfaces,
			boardColumns: declaredColumns ?? defaultBoardColumns(surfaces),
			settingsSchema,
		};
	}

	// Fallback derivation (pre-registry agents) — still attach any declared customSurfaces.
	let base: Omit<AgentCapabilities, "customSurfaces" | "boardColumns">;
	if (agent.slug === "job-application-assistant") {
		base = { surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" };
	} else if (agent.slug === "coder" || agent.category === "code") {
		base = { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" };
	} else if (agent.slug === "like4like-insurance-quotes" || agent.category === "insurance") {
		base = { surfaces: ["insurance"], runtime: "browser", workflow: "INSURANCE_QUOTES" };
	} else {
		base = { surfaces: [], runtime: null, workflow: null };
	}
	return { ...base, customSurfaces, boardColumns: declaredColumns ?? defaultBoardColumns(base.surfaces), settingsSchema };
}

/** True if the agent opts into a given console surface. */
export function hasSurface(agent: AgentLike, surface: AgentSurface): boolean {
	return agentCapabilities(agent).surfaces.includes(surface);
}
