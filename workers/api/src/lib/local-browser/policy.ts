/**
 * Local CLI browser research: what an agent declares, what an instance chooses, and what a run
 * may actually do (#945). Pure — the store and routes do the I/O.
 *
 * Two layers, the split the platform already draws for connector constraints (#404): the
 * CREATOR declares a ceiling on the agent (`agents.config.capabilities.localBrowser`), the
 * SUBSCRIBER narrows it per instance (`agent_instances.config.localBrowser`). An instance may
 * narrow and may never widen. A setting outside the ceiling is REFUSED with the reason rather
 * than clamped: a silently clamped limit reads as accepted and then behaves differently.
 *
 * The runner pin is NOT here. It is the existing `config.runnerNode`, set through
 * `PUT /:id/runner-node` with its attach semantics; a second copy would be a second answer.
 */
import {
	LOCAL_BROWSER_AUTH_MODES,
	LOCAL_BROWSER_ENGINES,
	LOCAL_BROWSER_MODES,
	type LocalBrowserAuthMode,
	type LocalBrowserEngine,
	type LocalBrowserLimits,
	type LocalBrowserMode,
	type LocalBrowserProfile,
	type LocalBrowserResultSchema,
	type LocalBrowserWorkspace,
} from "./contract.js";

/**
 * The first CLI whose runner lets a Codex subscription run call the browser bridge (#952, c00260e6):
 * `codex exec` runs with approval policy `never`, so before it the bridge's tools were refused and no
 * page could open. Claude Code has no such floor.
 */
export const LOCAL_BROWSER_CODEX_MIN_CLI = "0.4.74";

/** Platform hard ceilings — no agent may declare above these. */
export const PLATFORM_LIMITS: LocalBrowserLimits = { maxMinutes: 60, maxPages: 200, maxActions: 1000, maxConcurrent: 3 };
/** What an agent that declares no limits gets (the #946 mock: 15 min · 30 pages · 1 concurrent). */
export const DEFAULT_LIMITS: LocalBrowserLimits = { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 };
export const RETENTION_DAYS = { min: 1, max: 90, default: 30 } as const;
const LIMIT_KEYS = ["maxMinutes", "maxPages", "maxActions", "maxConcurrent"] as const;

export interface CollectionMapping {
	/** The instance collection a supervisor stores accepted findings in. */
	name: string;
	/** The finding field that identifies a duplicate. */
	keyField?: string;
}

/** The creator's declaration, resolved with defaults. */
export interface LocalBrowserCapability {
	engines: LocalBrowserEngine[];
	mode: LocalBrowserMode;
	/** Refuse `api-key` sign-in on instances. Default true: the point is the owner's own subscription. */
	subscriptionOnly: boolean;
	resultSchema: LocalBrowserResultSchema;
	/** Ceilings an instance may lower and never raise. */
	limits: LocalBrowserLimits;
	/** Empty = any public site (each new domain still pauses for consent). */
	allowDomains: string[];
	denyDomains: string[];
	collection?: CollectionMapping;
}

/** What a subscriber stores — every field optional; absent = the agent's default. */
export interface LocalBrowserSettings {
	engine?: LocalBrowserEngine;
	authMode?: LocalBrowserAuthMode;
	workspace?: LocalBrowserWorkspace;
	browserProfile?: LocalBrowserProfile;
	access?: { mode?: LocalBrowserMode; allowDomains?: string[]; denyDomains?: string[] };
	limits?: Partial<LocalBrowserLimits>;
	traceRetentionDays?: number;
	collection?: CollectionMapping;
}

/** What a run is started with: the capability narrowed by the settings, nothing optional. */
export interface EffectiveLocalBrowserPolicy {
	engine: LocalBrowserEngine;
	authMode: LocalBrowserAuthMode;
	workspace: LocalBrowserWorkspace;
	browserProfile: LocalBrowserProfile;
	mode: LocalBrowserMode;
	allowDomains: string[];
	denyDomains: string[];
	limits: LocalBrowserLimits;
	traceRetentionDays: number;
	resultSchema: LocalBrowserResultSchema;
	collection: CollectionMapping | null;
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A bare hostname, lowercased — or null. No scheme, port, path, wildcard or IP literal. */
export function normalizeDomain(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const d = raw.trim().toLowerCase().replace(/\.$/, "");
	return DOMAIN_RE.test(d) ? d : null;
}

/** Is `host` this domain or one of its subdomains? */
export function domainWithin(host: string, base: string): boolean {
	return host === base || host.endsWith(`.${base}`);
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

function domainList(raw: unknown, field: string): string[] | { error: string } {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return { error: `${field} must be a list of hostnames` };
	if (raw.length > 100) return { error: `${field} holds at most 100 hostnames` };
	const out: string[] = [];
	for (const d of raw) {
		const n = normalizeDomain(d);
		if (!n) return { error: `${field}: "${String(d)}" is not a hostname (no scheme, path, port or wildcard — "example.com" also covers its subdomains)` };
		if (!out.includes(n)) out.push(n);
	}
	return out;
}

function collectionMapping(raw: unknown, field: string): CollectionMapping | undefined | { error: string } {
	if (raw === undefined || raw === null) return undefined;
	const o = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
	const name = typeof o?.name === "string" ? o.name.trim() : "";
	if (!o || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) return { error: `${field}.name must be a collection name (letters, digits, _ or -, up to 64)` };
	const keyField = typeof o.keyField === "string" ? o.keyField.trim() : "";
	if (o.keyField !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(keyField)) return { error: `${field}.keyField must be a field name` };
	return keyField ? { name, keyField } : { name };
}

/**
 * The creator's block, from an untrusted body or a stored config — resolved with defaults.
 * Returns the reason when a declared value is invalid, so the create/update routes can refuse it.
 */
export function parseLocalBrowserCapability(raw: unknown): LocalBrowserCapability | { error: string } {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	let engines: LocalBrowserEngine[] = [...LOCAL_BROWSER_ENGINES];
	if (o.engines !== undefined) {
		if (!Array.isArray(o.engines) || !o.engines.length || !o.engines.every((e) => oneOf(LOCAL_BROWSER_ENGINES, e))) {
			return { error: `localBrowser.engines must list one or more of ${LOCAL_BROWSER_ENGINES.join(", ")}` };
		}
		engines = [...new Set(o.engines as LocalBrowserEngine[])];
	}
	if (o.mode !== undefined && !oneOf(LOCAL_BROWSER_MODES, o.mode)) return { error: `localBrowser.mode must be ${LOCAL_BROWSER_MODES.join(" or ")} — only research ships today` };
	if (o.subscriptionOnly !== undefined && typeof o.subscriptionOnly !== "boolean") return { error: "localBrowser.subscriptionOnly must be true or false" };
	const schema = (o.resultSchema && typeof o.resultSchema === "object" ? o.resultSchema : {}) as Record<string, unknown>;
	const schemaId = typeof schema.id === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(schema.id) ? schema.id : o.resultSchema === undefined ? "findings" : null;
	const schemaVersion = schema.version === undefined ? 1 : isInt(schema.version, 1, 1000) ? schema.version : null;
	if (!schemaId || !schemaVersion) return { error: "localBrowser.resultSchema needs an id (letters, digits, _ . -) and an integer version" };
	const limits = { ...DEFAULT_LIMITS };
	const rawLimits = (o.limits && typeof o.limits === "object" ? o.limits : {}) as Record<string, unknown>;
	for (const k of LIMIT_KEYS) {
		if (rawLimits[k] === undefined) continue;
		if (!isInt(rawLimits[k], 1, PLATFORM_LIMITS[k])) return { error: `localBrowser.limits.${k} must be a whole number from 1 to ${PLATFORM_LIMITS[k]}` };
		limits[k] = rawLimits[k] as number;
	}
	const allow = domainList(o.allowDomains, "localBrowser.allowDomains");
	if ("error" in allow) return allow;
	const deny = domainList(o.denyDomains, "localBrowser.denyDomains");
	if ("error" in deny) return deny;
	const collection = collectionMapping(o.collection, "localBrowser.collection");
	if (collection && "error" in collection) return collection;
	return {
		engines,
		mode: "research_only",
		subscriptionOnly: o.subscriptionOnly !== false,
		resultSchema: { id: schemaId, version: schemaVersion },
		limits,
		allowDomains: allow,
		denyDomains: deny,
		...(collection ? { collection } : {}),
	};
}

/**
 * Validate a subscriber's settings against the agent's capability. Returns the normalized settings
 * (what to store) or the first reason they cannot be accepted.
 */
export function validateLocalBrowserSettings(raw: unknown, cap: LocalBrowserCapability): { settings: LocalBrowserSettings } | { error: string } {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const out: LocalBrowserSettings = {};
	if (o.engine !== undefined) {
		if (!oneOf(cap.engines, o.engine)) return { error: `engine must be one this agent offers: ${cap.engines.join(", ")}` };
		out.engine = o.engine;
	}
	if (o.authMode !== undefined) {
		if (!oneOf(LOCAL_BROWSER_AUTH_MODES, o.authMode)) return { error: `authMode must be one of ${LOCAL_BROWSER_AUTH_MODES.join(", ")}` };
		if (o.authMode === "api-key" && cap.subscriptionOnly) {
			return { error: "This agent runs on your own Codex or Claude subscription only, so authMode api-key (per-token billing) is refused. Use subscription or machine." };
		}
		out.authMode = o.authMode;
	}
	if (o.workspace !== undefined) {
		const w = (o.workspace && typeof o.workspace === "object" ? o.workspace : {}) as Record<string, unknown>;
		if (w.kind === "scratch") out.workspace = { kind: "scratch" };
		else if (w.kind === "path") {
			const path = typeof w.path === "string" ? w.path.trim() : "";
			// The API cannot see the runner's disk, so the rule is one it CAN check: under the
			// runner user's home, written `~/…`, with no step out of it. The runner re-checks on disk.
			if (!/^~\/[^\0]+$/.test(path) || path.split("/").some((seg) => seg === ".." || seg === ".") || path.length > 500) {
				return { error: 'workspace.path must be a folder under the runner\'s home, written "~/…" (for example "~/jobs"), with no ".." — anywhere else is outside the runner\'s allowed scope' };
			}
			out.workspace = { kind: "path", path };
		} else return { error: 'workspace.kind must be "scratch" or "path"' };
	}
	if (o.browserProfile !== undefined) {
		if (o.browserProfile !== "isolated" && o.browserProfile !== "default") return { error: 'browserProfile must be "isolated" (a throwaway profile) or "default" (your signed-in profile, after consent)' };
		out.browserProfile = o.browserProfile;
	}
	if (o.access !== undefined) {
		const a = (o.access && typeof o.access === "object" ? o.access : {}) as Record<string, unknown>;
		if (a.mode !== undefined && !oneOf(LOCAL_BROWSER_MODES, a.mode)) return { error: `access.mode must be ${LOCAL_BROWSER_MODES.join(" or ")} — asking before an action is not available yet` };
		const allow = domainList(a.allowDomains, "access.allowDomains");
		if ("error" in allow) return allow;
		const deny = domainList(a.denyDomains, "access.denyDomains");
		if ("error" in deny) return deny;
		if (cap.allowDomains.length) {
			const outside = allow.find((d) => !cap.allowDomains.some((b) => domainWithin(d, b)));
			if (outside) return { error: `access.allowDomains: ${outside} is outside the sites this agent may visit (${cap.allowDomains.join(", ")}). An instance can narrow that list, not widen it.` };
		}
		out.access = { ...(a.mode ? { mode: a.mode as LocalBrowserMode } : {}), ...(a.allowDomains !== undefined ? { allowDomains: allow } : {}), ...(a.denyDomains !== undefined ? { denyDomains: deny } : {}) };
	}
	if (o.limits !== undefined) {
		const l = (o.limits && typeof o.limits === "object" ? o.limits : {}) as Record<string, unknown>;
		const limits: Partial<LocalBrowserLimits> = {};
		for (const k of LIMIT_KEYS) {
			if (l[k] === undefined) continue;
			if (!isInt(l[k], 1, cap.limits[k])) return { error: `limits.${k} must be a whole number from 1 to ${cap.limits[k]} (this agent's ceiling)` };
			limits[k] = l[k] as number;
		}
		out.limits = limits;
	}
	if (o.traceRetentionDays !== undefined) {
		if (!isInt(o.traceRetentionDays, RETENTION_DAYS.min, RETENTION_DAYS.max)) return { error: `traceRetentionDays must be a whole number from ${RETENTION_DAYS.min} to ${RETENTION_DAYS.max}` };
		out.traceRetentionDays = o.traceRetentionDays;
	}
	if (o.collection !== undefined) {
		const c = collectionMapping(o.collection, "collection");
		if (c && "error" in c) return c;
		if (c) out.collection = c;
	}
	return { settings: out };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One level of PATCH: present replaces, `null` clears, absent keeps. */
function patchObject(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const out = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete out[k];
		else out[k] = v;
	}
	return out;
}

/**
 * Apply a PATCH: a field present replaces, `null` clears it back to the agent default, absent keeps.
 * `access` and `limits` patch per key too, so setting one domain list or one limit leaves the
 * others as they were. The merge is validated whole, so a stored value the creator has since
 * narrowed below fails here.
 */
export function mergeLocalBrowserSettings(stored: unknown, patch: Record<string, unknown>, cap: LocalBrowserCapability): { settings: LocalBrowserSettings } | { error: string } {
	const base = isObj(stored) ? stored : {};
	const merged = patchObject(base, patch);
	for (const k of ["access", "limits"] as const) {
		if (isObj(patch[k])) merged[k] = patchObject(isObj(base[k]) ? (base[k] as Record<string, unknown>) : {}, patch[k] as Record<string, unknown>);
	}
	return validateLocalBrowserSettings(merged, cap);
}

/** The policy a run starts with. Stored settings that no longer fit the capability are refused. */
export function effectiveLocalBrowserPolicy(cap: LocalBrowserCapability, stored: unknown): EffectiveLocalBrowserPolicy | { error: string } {
	const v = validateLocalBrowserSettings(stored, cap);
	if ("error" in v) return { error: `Saved local browser settings no longer fit this agent: ${v.error}` };
	const s = v.settings;
	const allow = s.access?.allowDomains?.length ? s.access.allowDomains : cap.allowDomains;
	const deny = [...new Set([...cap.denyDomains, ...(s.access?.denyDomains ?? [])])];
	return {
		engine: s.engine ?? cap.engines[0],
		authMode: s.authMode ?? "subscription",
		workspace: s.workspace ?? { kind: "scratch" },
		browserProfile: s.browserProfile ?? "isolated",
		mode: "research_only",
		allowDomains: allow.filter((d) => !deny.some((x) => domainWithin(d, x))),
		denyDomains: deny,
		limits: { ...cap.limits, ...s.limits },
		traceRetentionDays: s.traceRetentionDays ?? RETENTION_DAYS.default,
		resultSchema: cap.resultSchema,
		collection: s.collection ?? cap.collection ?? null,
	};
}

/** A run's lifecycle. Terminal states never move again. */
export type LocalBrowserRunStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export const ACTIVE_RUN_STATUSES: readonly LocalBrowserRunStatus[] = ["queued", "running", "paused"];
const TRANSITIONS: Record<LocalBrowserRunStatus, readonly LocalBrowserRunStatus[]> = {
	queued: ["running", "failed", "cancelled"],
	running: ["paused", "completed", "failed", "cancelled"],
	paused: ["running", "failed", "cancelled"],
	completed: [],
	failed: [],
	cancelled: [],
};

export function canTransition(from: LocalBrowserRunStatus, to: LocalBrowserRunStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: LocalBrowserRunStatus): boolean {
	return TRANSITIONS[status].length === 0;
}
