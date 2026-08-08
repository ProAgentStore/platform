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

import {
	type ConstraintSpec,
	constraintsFor,
	narrowConstraintSpec,
	parseSurfaceOptions,
	serializeSurfaceOptions,
} from "./surface-options.js";
import { type AgentWorkflow, isAgentWorkflow } from "./agent-workflows.js";
import { isAllowedBundleUrl } from "./origins.js";

/** A console surface an agent opts into (drives tabs + which UI blocks render). */
export type AgentSurface = "apply" | "coding" | "insurance" | "repo" | "tmux";

/** Which local runner runtime the agent's hands use (null = no local runner). */
export type AgentRuntimeKind = "browser" | "coding" | null;

/** A custom (agent-published) console surface — its UI loads from a bundle URL. */
export interface CustomSurface {
	id: string;
	label: string;
	icon?: string;
	bundleUrl: string;
	/**
	 * May this surface replace the page header while it is active?
	 *
	 * The same capability the built-in surface registry declares (`store/console/src/lib/surfaces.tsx`
	 * `ownsHeader`). A full-screen surface — a live terminal — needs the header for its own context
	 * and controls. It used to be `if (tab !== "coding")` in the console, so exactly one first-party
	 * component could have it; declaring it here means a published surface is not a second-class
	 * citizen, and the shell derives the behaviour instead of naming a tab.
	 */
	ownsHeader?: boolean;
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
	/** Brain workflow binding name, when the agent has an autonomous loop. Derived from the
	 *  workflow catalog (lib/agent-workflows.ts), so a value that no `[[workflows]]` binding
	 *  backs cannot enter this type — the state #375 was about. */
	workflow: AgentWorkflow | null;
	/** Declared tool allowlist — names from the platform tool catalog (see
	 *  agent-do-tools `TOOL_CATALOG`). When present it is AUTHORITATIVE: the agent gets
	 *  exactly these catalog tools plus the universal BASE facilities, replacing the
	 *  per-surface default. Absent → the surface-derived default applies. This is the
	 *  open, data-driven vocabulary a third-party creator scopes without a code change. */
	tools?: string[];
	/** Phase 3: agent-published UIs the console loads dynamically from bundles. */
	customSurfaces?: CustomSurface[];
	/** Per-surface options keyed by surface id (see lib/surface-options.ts). */
	surfaceOptions?: Record<string, unknown>;
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

/** Validate a declared board-columns array (each needs id + title). Exported so the
 *  per-instance board-config override (lib/board.ts + the console/MCP/agent editors)
 *  validates columns through the exact same rules as an agent's declared columns. */
/**
 * Which declared column claims a raw status — the platform's canonical bucketing rule.
 *
 * `boardColumns` is an agent's OWN status vocabulary: it declares that its word `"needs_human"`
 * means the column titled "Needs you". That makes it the one mechanism by which something generic
 * (a supervisor, the board reader, MCP) can interpret a free-text `instance_runtime_tasks.status`
 * written by a domain it knows nothing about — including a third-party agent whose columns are
 * "Triage / Cooking / Shipped".
 *
 * The rule already existed twice, both OUTSIDE this worker and both matching `id === status` as
 * well as `statuses.includes(status)`: `store/console/src/tabs/BoardTab.tsx` and
 * `workers/mcp/src/instance-tools/shared.ts`. `board.ts` says of its own resolver, "This single
 * resolver is shared by the board reader, the config route, MCP, and the agent tool so they can't
 * drift" — that intent applies here too, so this is the copy to point the others at.
 *
 * Returns the column, or null when nothing claims the status and no catchAll exists. A null is
 * meaningful: it says the agent's declared vocabulary does not cover a status it is writing.
 */
export function columnForStatus(columns: readonly BoardColumn[], status: string): BoardColumn | null {
	for (const c of columns) if (c.statuses?.includes(status) || c.id === status) return c;
	return columns.find((c) => c.catchAll) ?? null;
}

export function sanitizeBoardColumns(value: unknown): BoardColumn[] | undefined {
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
/**
 * Built-in tab ids a custom surface may NOT claim — one entry per `SURFACES` id in
 * `store/console/src/lib/surfaces.tsx`.
 *
 * This list is a hand-kept mirror of a registry in another package, so it DRIFTS: `behaviour` was
 * added to the console registry after this list was written and was therefore claimable, which is
 * the exact tab-shadowing hole the list exists to close. `surfaces.test.ts` now reads this set and
 * fails when the console gains a tab that is not listed here.
 */
export const RESERVED_SURFACE_IDS = new Set([
	"chat", "apply", "board", "repo", "coding", "tmux", "activity", "stats", "behaviour", "knowledge", "indexing", "data", "settings",
]);
const MAX_CUSTOM_SURFACES = 8;
const CUSTOM_SURFACE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The env fields the custom-surface gate reads. Structural, so a pure test passes a literal. */
export interface CustomSurfaceEnv {
	CUSTOM_SURFACES_ENABLED?: string;
}

/**
 * Is the custom-surface feature switched on for this platform? FAIL-CLOSED — an absent or
 * unrecognised flag means OFF, exactly like `browserToolsEnabled` (#103) gates browser tools.
 *
 * WHY IT IS OFF BY DEFAULT (#186). A surface bundle is third-party CODE executed in the console
 * origin with the viewer's session token (`ctx.sdk.getToken`), so the only thing making it
 * survivable is that the bundle must be served by the platform itself. But the platform serves
 * NO surface bundles: `workers/host` answers every `/console/*` path with the console HTML shell
 * and its `build.js` never embeds `store/console/public/surfaces/*`, so a production bundle URL
 * returns `text/html` and the dynamic import dies on MIME. That leaves the feature in the worst
 * of both states — a code-execution path that no one can legitimately use. (Nothing declares one:
 * no migration, seed, or template sets `customSurfaces`.)
 *
 * Rather than half-build the hosting for a model that is admittedly unfinished — bundles need a
 * sandboxed iframe before a creator-authored one is safe at all — the whole feature is gated off
 * and stays authorable only where a platform operator deliberately turns it on. A clearly
 * disabled feature is safer than a half-validated one.
 *
 * The gate lives INSIDE `sanitizeCustomSurfaces`, which both the write route and the read/serve
 * path already share, so there is no second validator to forget.
 */
export function customSurfacesEnabled(env?: CustomSurfaceEnv | null): boolean {
	return env?.CUSTOM_SURFACES_ENABLED === "1" || env?.CUSTOM_SURFACES_ENABLED === "true";
}

/**
 * Validate declared custom surfaces.
 *
 * Gated: with the feature off (the default — see `customSurfacesEnabled`) this returns nothing,
 * whatever is stored. `env` is optional and its absence means OFF, so a caller that has no env to
 * hand cannot accidentally enable code loading.
 *
 * The reserved-id check is a SECURITY control, not tidiness: the console resolves a custom
 * surface BEFORE the built-in registry, so an agent declaring `{id:"settings"}` would render its
 * own bundle where the real Settings tab belongs — a credential-phishing surface wearing a
 * legitimate label. Duplicate ids are dropped for the same reason (and they produced duplicate
 * React keys).
 *
 * Caps mirror the sibling validators (settingsSchema: 12 fields; tools: 40) which this one was
 * missing entirely, so an owner could persist thousands of surfaces with megabyte labels into
 * `agents.config` — a payload then serialized into every instance response.
 */
export function sanitizeCustomSurfaces(value: unknown, env?: CustomSurfaceEnv | null): CustomSurface[] | undefined {
	if (!customSurfacesEnabled(env)) return undefined;
	if (!Array.isArray(value)) return undefined;
	const out: CustomSurface[] = [];
	const seen = new Set<string>();
	for (const v of value) {
		if (out.length >= MAX_CUSTOM_SURFACES) break;
		if (!v || typeof v !== "object") continue;
		const o = v as Record<string, unknown>;
		const id = (typeof o.id === "string" ? o.id : "").trim().toLowerCase();
		const label = (typeof o.label === "string" ? o.label : "").trim().slice(0, 80);
		const bundleUrl = (typeof o.bundleUrl === "string" ? o.bundleUrl : "").trim().slice(0, 500);
		if (!CUSTOM_SURFACE_ID_RE.test(id) || RESERVED_SURFACE_IDS.has(id) || seen.has(id)) continue;
		// Same-origin enforced SERVER-side (see isAllowedBundleUrl) — a bundle runs as code in
		// the console origin, so the UI check must not be the only one.
		if (!label || !isAllowedBundleUrl(bundleUrl)) continue;
		seen.add(id);
		const icon = typeof o.icon === "string" ? o.icon.trim().slice(0, 8) : undefined;
		// A surface that takes the full viewport may replace the page header — the same capability
		// the built-in registry declares with `ownsHeader`. Sanitized here or a creator could
		// declare it and watch it silently vanish: a whitelist that drops an unknown field is the
		// failure mode `parseConfig` is already documented for.
		const ownsHeader = o.ownsHeader === true ? true : undefined;
		out.push({ id, label, bundleUrl, icon: icon || undefined, ownsHeader });
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

const MAX_DECLARED_TOOLS = 40;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;

/** Validate a declared tool allowlist: an array of tool-name strings, deduped and
 *  capped. Names are intersected with the real catalog at runtime (agent-do-tools
 *  `toolNamesFor`), so an unknown/ungrantable name here is simply ignored — this only
 *  trims obvious junk before it reaches config. Exported so create/update-agent routes
 *  can sanitize with the same rules. */
export function sanitizeToolList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const v of value) {
		if (out.length >= MAX_DECLARED_TOOLS) break;
		if (typeof v !== "string") continue;
		const name = v.trim();
		if (!TOOL_NAME_RE.test(name) || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out.length ? out : undefined;
}

const KNOWN_SURFACES = new Set<AgentSurface>(["apply", "coding", "insurance", "repo", "tmux"]);
/** Closed enums for the WRITABLE power fields. A creator can only declare capabilities
 *  the platform already implements — no arbitrary code, so the blast radius is bounded
 *  (unlike customSurfaces, which loads a code bundle and stays on its own guarded path). */
const KNOWN_RUNTIMES = new Set<Exclude<AgentRuntimeKind, null>>(["browser", "coding"]);
// Workflows are NOT listed here: `isAgentWorkflow` asks the catalog that the picker is served
// from, so the vocabulary a creator is offered and the vocabulary this validator accepts are one
// list. They were two, and each had drifted the other way (#375).

/** The subset of capabilities a creator declares through the create/update routes:
 *  the closed-enum power fields + the tool allowlist. customSurfaces/settingsSchema/
 *  boardColumns are owned by their own routes/validators and are NOT part of this. */
export interface DeclaredCapabilities {
	surfaces?: AgentSurface[];
	/** Per-surface options, keyed by surface id. Inert for a surface not in `surfaces`. */
	surfaceOptions?: Record<string, unknown>;
	runtime?: AgentRuntimeKind;
	workflow?: AgentCapabilities["workflow"];
	tools?: string[];
}

/**
 * Validate the writable capability fields from an untrusted request body. Only keys
 * actually present in the input appear in the result (so a partial PATCH merges
 * cleanly); unknown enum values are dropped to their safe default (same philosophy as
 * the read-side filter in `agentCapabilities`). This is the one validator the create +
 * update-agent routes share — the minimum that makes capabilities authorable as data.
 */
export function sanitizeDeclaredCapabilities(input: unknown): DeclaredCapabilities {
	const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const out: DeclaredCapabilities = {};
	if (Array.isArray(o.surfaces)) {
		out.surfaces = [...new Set(o.surfaces.filter((s): s is AgentSurface => KNOWN_SURFACES.has(s as AgentSurface)))];
	}
	// Per-surface options — the shape a bare surface id cannot express. Sanitized through the
	// same parser the consumers use, and stored compactly so declaring nothing non-default
	// writes nothing. An option for an UNDECLARED surface is inert, never a way to switch one
	// on; `optionsFor` gates on `surfaces` for exactly that reason.
	//
	// The same pass validates per-connector CONSTRAINTS (#404) against their closed vocabulary,
	// because `parseSurfaceOptions` owns both — which is the whole argument for extending this map
	// rather than adding a sibling one: there is exactly one validator to route a write through,
	// and it was already routed. A value outside `CONNECTOR_CONSTRAINTS` cannot reach config.
	if ("surfaceOptions" in o) {
		const opts = serializeSurfaceOptions(parseSurfaceOptions(o.surfaceOptions));
		if (Object.keys(opts).length) out.surfaceOptions = opts;
	}
	if ("runtime" in o) {
		out.runtime = KNOWN_RUNTIMES.has(o.runtime as Exclude<AgentRuntimeKind, null>) ? (o.runtime as AgentRuntimeKind) : null;
	}
	if ("workflow" in o) {
		out.workflow = isAgentWorkflow(o.workflow) ? o.workflow : null;
	}
	// Presence of a tools array (even empty → clear) is honored; junk → [].
	if (Array.isArray(o.tools)) out.tools = sanitizeToolList(o.tools) ?? [];
	return out;
}

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
 *
 * `env` is only consulted for the fail-closed custom-surface gate (#186). Omitting it resolves
 * everything else identically and simply yields no `customSurfaces` — which is what the callers
 * that never render a surface (board columns, runtime lookups, tool policy) want anyway.
 */
export function agentCapabilities(agent: AgentLike, env?: CustomSurfaceEnv | null): AgentCapabilities {
	const cfg = parseConfig(agent.config);
	const declared = cfg.capabilities as Partial<AgentCapabilities> | undefined;
	// Honor declared custom surfaces in EVERY path — even an agent that doesn't declare
	// a `surfaces` array (e.g. a generic agent that only ships its own UI).
	const customSurfaces = sanitizeCustomSurfaces((declared as Record<string, unknown> | undefined)?.customSurfaces, env);
	// Declared columns win; otherwise the per-surface default is filled in below so the
	// console/MCP always get a concrete board without any client-side default.
	const declaredColumns = sanitizeBoardColumns((declared as Record<string, unknown> | undefined)?.boardColumns);
	// Settings schema lives at TOP-LEVEL config.settingsSchema (sibling of capabilities)
	// so the seed migrations' json_set('$.settingsSchema', …) is unconditionally
	// idempotent. Honored in every path, like customSurfaces.
	const settingsSchema = sanitizeSettingsSchema(cfg.settingsSchema);
	// Declared tool allowlist (sibling of surfaces under config.capabilities). Honored in
	// every path; runtime intersects it with the real catalog (agent-do-tools).
	const tools = sanitizeToolList((declared as Record<string, unknown> | undefined)?.tools);
	// Per-surface options. `sanitizeDeclaredCapabilities` validated and PERSISTED these, but
	// neither return path below copied them onto the resolved capabilities — so every consumer
	// read `undefined` and `optionsFor()` fell back to SURFACE_DEFAULTS. A supervised Repo Coder
	// declaring `{drive:false, repos:"single"}` therefore still got send_to_cli/read_terminal
	// (the third drive-path #154 removes) and still rendered add-repo plus a multi-repo list it
	// cannot use. The unit tests pass because they build the capabilities literal by hand and
	// never go through this function.
	const surfaceOptionsRaw = (declared as Record<string, unknown> | undefined)?.surfaceOptions;
	const surfaceOptions = serializeSurfaceOptions(parseSurfaceOptions(surfaceOptionsRaw));
	const withOptions = Object.keys(surfaceOptions).length ? { surfaceOptions } : {};

	if (declared && Array.isArray(declared.surfaces)) {
		const surfaces = declared.surfaces.filter((s): s is AgentSurface => KNOWN_SURFACES.has(s as AgentSurface));
		return {
			surfaces,
			runtime: declared.runtime ?? null,
			// Filtered on READ as well as on write, exactly like `surfaces` above: a row persisted
			// while the enum was wider (`INSURANCE_QUOTES`, #375) would otherwise keep resolving to a
			// workflow nothing runs, which `lintAgentClaims` reads as "runtime-backed" and a picker
			// would keep showing as a real choice.
			workflow: isAgentWorkflow(declared.workflow) ? declared.workflow : null,
			tools,
			customSurfaces,
			...withOptions,
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
		// There is no `insurance` branch (#375). It derived `workflow: "INSURANCE_QUOTES"`, which no
		// `[[workflows]]` binding ever backed, alongside a surface the console registry renders no tab
		// for — so what it resolved was a runtime claim with nothing behind it, which is worse than
		// resolving nothing. No migration seeds that slug or category; an agent that wants a browser
		// brain declares `runtime:"browser"` + `workflow:"BROWSER_TASK"` like every other one.
	} else {
		base = { surfaces: [], runtime: null, workflow: null };
	}
	return { ...base, tools, customSurfaces, ...withOptions, boardColumns: declaredColumns ?? defaultBoardColumns(base.surfaces), settingsSchema };
}

/** True if the agent opts into a given console surface. */
export function hasSurface(agent: AgentLike, surface: AgentSurface): boolean {
	return agentCapabilities(agent).surfaces.includes(surface);
}

/**
 * Resolve an INSTANCE's capabilities — the join every caller was writing by hand.
 *
 * Three copies of this exact SELECT existed (`overseerDisabled`, `copilotDisabled`, and the
 * delegation dispatch), which is how a rule ends up enforced in two places out of three. One
 * helper, so "what does this agent declare" has a single answer.
 *
 * `userId` scopes to the owner when supplied. Returns null when the instance isn't there.
 */
export async function capabilitiesForInstance(
	env: { DB: D1Database } & CustomSurfaceEnv,
	instanceId: string,
	userId?: string,
): Promise<AgentCapabilities | null> {
	const sql = userId
		? `SELECT a.slug AS slug, a.category AS category, a.config AS config
		     FROM agent_instances i JOIN agents a ON a.id = i.agent_id
		    WHERE i.id = ?1 AND i.user_id = ?2`
		: `SELECT a.slug AS slug, a.category AS category, a.config AS config
		     FROM agent_instances i JOIN agents a ON a.id = i.agent_id
		    WHERE i.id = ?1`;
	const stmt = env.DB.prepare(sql);
	const row = await (userId ? stmt.bind(instanceId, userId) : stmt.bind(instanceId))
		.first<{ slug: string | null; category: string | null; config: string | null }>()
		.catch(() => null);
	return row ? agentCapabilities(row as never, env) : null;
}

/**
 * The EFFECTIVE argument constraints for one connector on one instance (#404) — the creator's
 * ceiling from `agents.config.capabilities.surfaceOptions`, narrowed by the subscriber's own
 * `agent_instances.config.surfaceOptions`.
 *
 * Two configs, one merge, in the split the platform already draws: what the agent IS is the
 * creator's (immutable by the subscriber); how this instance is used is the subscriber's, within
 * it. `narrowConstraintSpec` is where "may narrow, may never widen" is decided and tested.
 *
 * Returns undefined when nothing is declared — which is every agent today, and must stay
 * indistinguishable from the pre-#404 behaviour at the call site.
 *
 * It THROWS on a database failure rather than resolving to "unconstrained": the caller
 * (`runRegistryTool`) refuses on a throw, because a ceiling that cannot be read cannot be
 * honoured, and a security boundary that opens when its store hiccups is not one.
 *
 * A MISSING ROW is a third thing, and this signature cannot say which one it means — see
 * `lookupConnectorConstraints`, which the gate uses for exactly that reason. Callers that only
 * want the spec (the terminal-target route, which has already checked ownership) keep this one.
 */
export async function connectorConstraintsForInstance(
	env: { DB: D1Database },
	instanceId: string,
	userId: string | undefined,
	connector: string,
): Promise<ConstraintSpec | undefined> {
	const found = await lookupConnectorConstraints(env, instanceId, userId, connector);
	return found.instance === "found" ? found.spec : undefined;
}

/**
 * The same lookup, telling the two ways `undefined` arises apart (#441).
 *
 * `spec: undefined` on a row that EXISTS means "this agent declares no ceiling" — which is every
 * agent on the platform bar three, and must stay open, byte-for-byte. `instance: "missing"` means
 * the join matched nothing: a deleted instance, an id belonging to somebody else, or an AGENT id
 * handed to an instance-shaped parameter (the agent-template chat surfaces do exactly that). A
 * ceiling that cannot be LOCATED is not a ceiling that is absent, and collapsing the two is how a
 * declared constraint silently stopped applying on one surface while consent still refused on it.
 *
 * The distinction lives here rather than at the call site because it is a property of the query:
 * only this function knows whether the row was there.
 */
export type ConnectorConstraintLookup =
	| { instance: "found"; spec: ConstraintSpec | undefined }
	| { instance: "missing" };

export async function lookupConnectorConstraints(
	env: { DB: D1Database },
	instanceId: string,
	userId: string | undefined,
	connector: string,
): Promise<ConnectorConstraintLookup> {
	const sql = userId
		? `SELECT a.config AS agent_config, i.config AS instance_config
		     FROM agent_instances i JOIN agents a ON a.id = i.agent_id
		    WHERE i.id = ?1 AND i.user_id = ?2`
		: `SELECT a.config AS agent_config, i.config AS instance_config
		     FROM agent_instances i JOIN agents a ON a.id = i.agent_id
		    WHERE i.id = ?1`;
	const stmt = env.DB.prepare(sql);
	const row = await (userId ? stmt.bind(instanceId, userId) : stmt.bind(instanceId)).first<{
		agent_config: string | null;
		instance_config: string | null;
	}>();
	if (!row) return { instance: "missing" };
	const declared = parseConfig(row.agent_config).capabilities as { surfaceOptions?: unknown } | undefined;
	const ceiling = constraintsFor({ surfaceOptions: declared?.surfaceOptions }, connector);
	const requested = constraintsFor({ surfaceOptions: parseConfig(row.instance_config).surfaceOptions }, connector);
	return { instance: "found", spec: narrowConstraintSpec(connector, ceiling, requested) };
}
