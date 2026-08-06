/**
 * Trigger config: what a field means, whether it will actually be honoured, and how an inbound
 * payload maps onto the action's fields (#16).
 *
 * The problem this solves is a SILENT one. `parseConfig` (lib/triggers.ts) is a whitelist, so a
 * field it does not list is dropped on the way to dispatch — no error, no log, no trace. The
 * store route did not validate config at all, and the read route echoed the RAW stored JSON
 * back, so a typo'd `pipelin` (or a perfectly-spelled field belonging to a different action)
 * was accepted, persisted, displayed in the console as though it were configuration, and then
 * ignored forever at run time. The trigger looked configured and did nothing.
 *
 * So the emphasis here is deliberately on the validator rather than on a big mapping form: the
 * most valuable thing this can tell a user is "that field will be ignored", said at the moment
 * they set it. Mapping itself is small — a target field to a dotted payload path — because the
 * fixed conventions (`title`, `content`, `text`) only fail for the narrow reason that real
 * webhook sources nest their data (`lead.name`, `body.message`), and a path expression is the
 * whole of that problem.
 */

import { isValidTimeZone } from "./cron-time.js";
import type { TriggerAction, TriggerType } from "./triggers.js";

/** Every key `parseConfig` will keep. A key absent here is dropped before dispatch sees it. */
export const TRIGGER_CONFIG_KEYS = [
	"title",
	"description",
	"source",
	"sourceUrl",
	"provider",
	"grantId",
	"folderId",
	"limit",
	"query",
	"pipeline",
	"collection",
	"url",
	"dryRun",
	"jitterMinutes",
	"timezone",
	"mapping",
	"params",
	"traceId",
] as const;

/**
 * Which config keys the given action actually READS. A key that is spelled correctly but
 * belongs to a different action is just as inert as a typo, and is the more common mistake —
 * `pipeline` set on a `create_task` trigger, `collection` on a browse one.
 */
const ACTION_KEYS: Record<TriggerAction, readonly string[]> = {
	create_task: ["title", "description", "mapping"],
	add_knowledge: ["title", "source", "sourceUrl", "mapping"],
	log_event: ["mapping"],
	sync_connector: ["provider", "grantId", "folderId", "limit", "query"],
	run_pipeline: ["pipeline", "params"],
	insert_record: ["collection"],
	run_browse: ["url", "dryRun"],
};

/** Config that belongs to the SCHEDULE rather than the action, so it is cron-only. */
const CRON_KEYS = ["jitterMinutes", "timezone"] as const;

/** Set by the connection pump, never by a user — accepted silently so a replayed config round-trips. */
const INTERNAL_KEYS = ["traceId"] as const;

/** Fields of each action that an inbound payload may be mapped onto. */
export const MAPPING_TARGETS: Record<TriggerAction, readonly string[]> = {
	create_task: ["title", "description"],
	add_knowledge: ["title", "content", "sourceUrl"],
	log_event: ["message"],
	sync_connector: [],
	run_pipeline: [],
	insert_record: [],
	run_browse: [],
};

export const MAX_MAPPING_ENTRIES = 12;

/** `lead.name`, `items.0.title`, `body.message`. Deliberately not an expression language. */
const PATH_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$-]*(\.[A-Za-z0-9_$-]+)*$/;

export function isValidPath(path: unknown): path is string {
	return typeof path === "string" && path.length > 0 && path.length <= 200 && PATH_RE.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a dotted path out of a payload. Array indices are ordinary segments (`items.0.name`).
 * Returns undefined for anything missing rather than throwing — a mapping that does not match
 * this particular payload falls back to the existing convention, it does not fail the run.
 */
export function extractPath(payload: unknown, path: string): unknown {
	if (!isValidPath(path)) return undefined;
	let cursor: unknown = payload;
	for (const segment of path.split(".")) {
		if (cursor === null || cursor === undefined) return undefined;
		if (Array.isArray(cursor)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0) return undefined;
			cursor = cursor[index];
			continue;
		}
		if (typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

/** Render a mapped value as the string the action wants. Objects become JSON so a mapping onto
 *  a sub-object still produces something usable rather than "[object Object]". */
export function stringifyMapped(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

/**
 * Resolve a trigger's mapping against one payload: `{ title: "lead.name" }` + `{ lead: { name:
 * "Acme" } }` → `{ title: "Acme" }`. Targets not valid for the action are ignored (the validator
 * rejects them at write time; dispatch stays defensive because old rows predate the validator),
 * and a path that resolves to nothing is omitted so the caller's default still applies.
 */
export function applyMapping(payload: unknown, mapping: unknown, action: TriggerAction): Record<string, string> {
	const out: Record<string, string> = {};
	if (!isRecord(mapping)) return out;
	const targets = MAPPING_TARGETS[action] ?? [];
	for (const [target, path] of Object.entries(mapping)) {
		if (!targets.includes(target)) continue;
		if (typeof path !== "string") continue;
		const value = stringifyMapped(extractPath(payload, path));
		if (value) out[target] = value;
	}
	return out;
}

/**
 * Everything wrong with this config, in plain sentences. Empty array = nothing will be
 * silently dropped and nothing required is missing.
 *
 * Required-field checks apply to CRON triggers only. A webhook or a manual run can legitimately
 * supply `pipeline` / `collection` / `url` in the payload itself (dispatch prefers the payload
 * over config), so demanding them up front would break a working pattern. A cron has no inbound
 * payload, so a cron missing them can only ever fail — and failing at 3am in the sweep is a much
 * worse place to learn it than failing at the save button.
 */
export function validateTriggerConfig(action: TriggerAction, type: TriggerType, raw: unknown): string[] {
	const problems: string[] = [];
	if (raw === undefined || raw === null) return problems;
	if (!isRecord(raw)) return ["config must be an object"];

	const known = new Set<string>(TRIGGER_CONFIG_KEYS);
	const forAction = new Set<string>([...(ACTION_KEYS[action] ?? []), ...INTERNAL_KEYS]);
	const unknown: string[] = [];
	const wrongAction: string[] = [];
	const cronOnly: string[] = [];
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) {
			unknown.push(key);
		} else if ((CRON_KEYS as readonly string[]).includes(key)) {
			if (type !== "cron") cronOnly.push(key);
		} else if (!forAction.has(key)) {
			wrongAction.push(key);
		}
	}
	if (unknown.length) {
		problems.push(
			`Unrecognised config field${unknown.length > 1 ? "s" : ""} ${quoteList(unknown)} — ${unknown.length > 1 ? "they would be" : "it would be"} ignored at run time. Supported: ${TRIGGER_CONFIG_KEYS.filter((k) => k !== "traceId").join(", ")}.`,
		);
	}
	if (wrongAction.length) {
		const supported = ACTION_KEYS[action] ?? [];
		problems.push(
			`${quoteList(wrongAction)} ${wrongAction.length > 1 ? "are" : "is"} not used by the ${action} action and would be ignored. ${action} reads: ${supported.length ? supported.join(", ") : "no action config"}.`,
		);
	}
	if (cronOnly.length) {
		problems.push(`${quoteList(cronOnly)} only applies to cron triggers — a ${type} trigger ignores it.`);
	}

	if (raw.timezone !== undefined && !isValidTimeZone(raw.timezone)) {
		problems.push(`"${String(raw.timezone)}" is not a known timezone. Use an IANA name such as Australia/Melbourne or UTC.`);
	}
	if (raw.jitterMinutes !== undefined) {
		const j = raw.jitterMinutes;
		if (typeof j !== "number" || !Number.isFinite(j) || j < 0 || j > 720) {
			problems.push("jitterMinutes must be a number between 0 and 720.");
		}
	}
	if (raw.limit !== undefined) {
		const l = raw.limit;
		if (typeof l !== "number" || !Number.isInteger(l) || l < 1 || l > 20) {
			problems.push("limit must be a whole number between 1 and 20.");
		}
	}
	if (raw.mapping !== undefined) problems.push(...validateMapping(raw.mapping, action));

	if (type === "cron") {
		if (action === "sync_connector") {
			if (!raw.provider) problems.push("A folder sync needs a connector provider (google_drive or zoho_workdrive).");
			if (!raw.grantId) problems.push("A folder sync needs the id of a granted folder.");
		}
		if (action === "run_pipeline" && !strValue(raw.pipeline)) problems.push("A scheduled pipeline run needs the pipeline name.");
		if (action === "insert_record" && !strValue(raw.collection)) problems.push("A scheduled record insert needs the target collection.");
		if (action === "run_browse" && !/^https?:\/\//i.test(strValue(raw.url))) problems.push("A scheduled browser run needs a start URL beginning with http:// or https://.");
	}
	return problems;
}

function validateMapping(mapping: unknown, action: TriggerAction): string[] {
	const problems: string[] = [];
	if (!isRecord(mapping)) return ["mapping must be an object of { field: \"payload.path\" }."];
	const targets = MAPPING_TARGETS[action] ?? [];
	const entries = Object.entries(mapping);
	if (!targets.length && entries.length) {
		return [`The ${action} action has no mappable fields, so mapping would be ignored.`];
	}
	if (entries.length > MAX_MAPPING_ENTRIES) problems.push(`mapping supports at most ${MAX_MAPPING_ENTRIES} fields.`);
	for (const [target, path] of entries) {
		if (!targets.includes(target)) {
			problems.push(`"${target}" is not a mappable field of ${action}. Mappable: ${targets.join(", ")}.`);
			continue;
		}
		if (!isValidPath(path)) {
			problems.push(`The mapping for "${target}" must be a payload path like "lead.name" or "items.0.title".`);
		}
	}
	return problems;
}

function strValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function quoteList(keys: string[]): string {
	return keys.map((k) => `"${k}"`).join(", ");
}
