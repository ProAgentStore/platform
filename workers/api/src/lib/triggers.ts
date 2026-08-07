import { HttpError } from "./auth.js";
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { runnerSkipMessage } from "./trigger-capability.js";
import { requireConnectorGrant, type ConnectorProvider } from "./connector-grants.js";
import { cronFields, isValidTimeZone, nextCronInstant } from "./cron-time.js";
import { applyMapping } from "./trigger-config.js";
import {
	describeSync,
	resolveTraversalLimits,
	syncDecision,
	versionedTitle,
	walkFolderTree,
	SYNC_MAX_DEPTH,
	type PriorSyncState,
} from "./connector-sync.js";
import { readConnectorRefreshToken } from "./connector-oauth.js";
import {
	driveFileDescendsFrom,
	exportDriveFile,
	isDriveFolder,
	listDriveFolderFiles,
	mintDriveAccessToken,
	type DriveFile,
} from "./drive.js";
import { instanceBoardLink } from "./console-links.js";
import { logEvent } from "./events.js";
import { enqueueDelivery } from "./connection-deliveries.js";
import { startPipelineRun } from "./pipeline-run-start.js";
import {
	exportWorkDriveFile,
	listWorkDriveFolder,
	mintWorkDriveAccessToken,
	workDriveFolderContainsFile,
	type WorkDriveFile,
} from "./workdrive.js";
import { startBrowserTask } from "../routes/instances-browse.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

/** The trigger vocabulary moved to `./trigger-types.js` — a leaf, so a module that only
 *  NAMES an action doesn't inherit this file's executor graph (#293). Re-exported here
 *  because this is still where triggers are validated, stored and run. */
import { TRIGGER_ACTIONS } from "./trigger-types.js";
import type { TriggerAction, TriggerConfig, TriggerEventType, TriggerRow, TriggerType } from "./trigger-types.js";
export type { TriggerAction, TriggerConfig, TriggerEventType, TriggerRow, TriggerType };

/** Derived from the one vocabulary (#358) — this used to be a third copy of the same seven names. */
const ACTIONS = new Set<TriggerAction>(TRIGGER_ACTIONS);
const TYPES = new Set<TriggerType>(["webhook", "cron"]);
const MAX_PAYLOAD_CHARS = 16_000;

export function assertTriggerType(value: unknown): TriggerType {
	if (typeof value !== "string" || !TYPES.has(value as TriggerType)) {
		throw new HttpError(400, "trigger type must be webhook or cron");
	}
	return value as TriggerType;
}

export function assertTriggerAction(value: unknown): TriggerAction {
	if (typeof value !== "string" || !ACTIONS.has(value as TriggerAction)) {
		throw new HttpError(400, `trigger action must be one of: ${TRIGGER_ACTIONS.join(", ")}`);
	}
	return value as TriggerAction;
}

export function sanitizeTriggerName(value: unknown): string {
	const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
	if (!name) throw new HttpError(400, "name required");
	return name.slice(0, 100);
}

export function normalizeSchedule(value: unknown): string {
	const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
	if (!raw) throw new HttpError(400, "schedule required for cron triggers");
	if (raw === "@hourly" || raw === "@daily" || raw === "@weekly") return raw;
	const every = raw.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days)$/);
	if (every) {
		const n = Number(every[1]);
		const unit = every[2][0];
		const minutes = unit === "m" ? n : unit === "h" ? n * 60 : n * 1440;
		if (minutes < 5) throw new HttpError(400, "minimum cron interval is 5 minutes");
		if (minutes > 31 * 24 * 60) throw new HttpError(400, "maximum cron interval is 31 days");
		return `every ${minutes} minutes`;
	}
	const parts = raw.split(" ");
	if (parts.length === 5 && parts.every((p) => p === "*" || /^\d+$/.test(p))) {
		const [minute, hour, day, month, weekday] = parts;
		const valid =
			validRange(minute, 0, 59) &&
			validRange(hour, 0, 23) &&
			validRange(day, 1, 31) &&
			validRange(month, 1, 12) &&
			validRange(weekday, 0, 7);
		if (!valid) throw new HttpError(400, "cron expression has an out-of-range field");
		// Enforce the same 5-minute floor as the `every N` form. The grammar only allows `*`
		// or a literal digit per field (no `*/N`), so a `*` minute means EVERY minute — which
		// would fire per worker-cron tick, bypassing the interval floor and multiplying
		// connector-scan / AI cost. Require a specific minute (≥ hourly) instead.
		if (minute === "*") throw new HttpError(400, "minimum cron interval is 5 minutes — pin a specific minute, or use 'every N minutes'");
		return parts.join(" ");
	}
	throw new HttpError(400, "unsupported schedule; use @hourly, @daily, every N minutes, or a simple 5-field cron");
}

function validRange(part: string, min: number, max: number): boolean {
	if (part === "*") return true;
	const n = Number(part);
	return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * When this schedule next fires, as an ISO instant.
 *
 * `timeZone` (#18) decides which clock the WALL-CLOCK schedules are read against — `@daily`,
 * `@weekly` and 5-field cron. Absent or unknown → UTC, i.e. exactly the behaviour of every
 * trigger that existed before timezones did. Interval schedules (`@hourly`, `every N minutes`)
 * are durations, not clock times, so a zone cannot change them and is not applied.
 */
export function nextRunAt(schedule: string, from = new Date(), timeZone?: string): string {
	const normalized = normalizeSchedule(schedule);
	const base = new Date(from.getTime());
	base.setUTCSeconds(0, 0);
	if (normalized === "@hourly") return addMinutes(base, 60).toISOString();
	const every = normalized.match(/^every\s+(\d+)\s+minutes$/);
	if (every) return addMinutes(base, Number(every[1])).toISOString();

	// The aliases ARE cron expressions; expanding them here means there is one wall-clock
	// evaluator rather than a cron path and an alias path that can disagree about a timezone.
	const expression = normalized === "@daily" ? "0 0 * * *" : normalized === "@weekly" ? "0 0 * * 0" : normalized;
	const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
	const instant = nextCronInstant(cronFields(expression), base, zone);
	if (instant === null) throw new HttpError(400, "schedule has no run in the next year");
	return new Date(instant).toISOString();
}

/**
 * The next `count` fire times, for an honest console preview (#18). Computed by the SAME
 * function the scheduler uses, on the server, so a preview cannot drift from behaviour — the
 * one thing worse than no next-run preview is a next-run preview that lies.
 */
export function previewRuns(schedule: string, timeZone?: string, count = 3, from = new Date()): string[] {
	const runs: string[] = [];
	let cursor = from;
	for (let i = 0; i < Math.max(1, Math.min(count, 10)); i++) {
		const next = nextRunAt(schedule, cursor, timeZone);
		runs.push(next);
		cursor = new Date(Date.parse(next));
	}
	return runs;
}

function addMinutes(date: Date, minutes: number): Date {
	return new Date(date.getTime() + minutes * 60_000);
}

/** Offset a scheduled time by a random ± jitter (minutes) so recurring runs don't fire
 *  exactly on the dot — a cheap anti-pattern defense for automation. Clamped to ≥ 1 min
 *  in the future so jitter can never schedule a run in the past. */
export function applyJitter(iso: string, jitterMinutes?: number): string {
	const j = typeof jitterMinutes === "number" && jitterMinutes > 0 ? Math.min(jitterMinutes, 720) : 0;
	if (!j) return iso;
	const offsetMs = (Math.random() * 2 - 1) * j * 60_000;
	const floor = Date.now() + 60_000;
	return new Date(Math.max(Date.parse(iso) + offsetMs, floor)).toISOString();
}

export function publicWebhookUrl(origin: string, token: string): string {
	return `${origin.replace(/\/+$/, "")}/v1/triggers/webhook/${encodeURIComponent(token)}`;
}

export function makeTriggerSecret(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeJson(value: unknown): string {
	return JSON.stringify(value ?? {}).slice(0, MAX_PAYLOAD_CHARS);
}

export function parseConfig(value: string | null | undefined): TriggerConfig {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		return {
			title: typeof parsed.title === "string" ? parsed.title.slice(0, 200) : undefined,
			description: typeof parsed.description === "string" ? parsed.description.slice(0, 2000) : undefined,
			source: typeof parsed.source === "string" ? parsed.source.slice(0, 120) : undefined,
			sourceUrl: typeof parsed.sourceUrl === "string" ? parsed.sourceUrl.slice(0, 2000) : undefined,
			provider: parsed.provider === "google_drive" || parsed.provider === "zoho_workdrive" ? parsed.provider : undefined,
			grantId: typeof parsed.grantId === "string" ? parsed.grantId.slice(0, 200) : undefined,
			folderId: typeof parsed.folderId === "string" ? parsed.folderId.slice(0, 500) : undefined,
			limit: typeof parsed.limit === "number" ? Math.max(1, Math.min(Math.trunc(parsed.limit), 20)) : undefined,
			query: typeof parsed.query === "string" ? parsed.query.slice(0, 200) : undefined,
			// #20: absent must keep meaning "shallow", so only an explicit true turns recursion on.
			recursive: parsed.recursive === true ? true : undefined,
			maxDepth: typeof parsed.maxDepth === "number" ? Math.max(0, Math.min(Math.trunc(parsed.maxDepth), SYNC_MAX_DEPTH)) : undefined,
			versioned: parsed.versioned === true ? true : undefined,
			pipeline: typeof parsed.pipeline === "string" ? parsed.pipeline.slice(0, 200) : undefined,
			collection: typeof parsed.collection === "string" ? parsed.collection.slice(0, 200) : undefined,
			url: typeof parsed.url === "string" ? parsed.url.slice(0, 2000) : undefined,
			dryRun: parsed.dryRun === true ? true : undefined,
			jitterMinutes: typeof parsed.jitterMinutes === "number" ? Math.max(0, Math.min(Math.trunc(parsed.jitterMinutes), 720)) : undefined,
			// #18: an unknown zone must NOT quietly become UTC on a schedule the user believes is
			// local — the write path rejects it, and anything that got in before is dropped here
			// so the row reads the same way the scheduler treats it.
			timezone: isValidTimeZone(parsed.timezone) ? parsed.timezone : undefined,
			// #16: { targetField: "payload.path" }. Values are sanitised at dispatch by applyMapping.
			mapping: parsed.mapping && typeof parsed.mapping === "object" && !Array.isArray(parsed.mapping) ? (parsed.mapping as Record<string, string>) : undefined,
			// parseConfig is a whitelist, so a field absent here is silently dropped. Both of
			// these must survive it or run_pipeline behaves differently depending on whether the
			// event arrived via a stored trigger (parsed here) or the connection pump (which
			// passes its config object straight through) — the sort of split that is very hard
			// to debug from the outside.
			params: parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params) ? (parsed.params as Record<string, unknown>) : undefined,
			traceId: typeof parsed.traceId === "string" ? parsed.traceId.slice(0, 200) : undefined,
		};
	} catch {
		return {};
	}
}

export async function recordTriggerEvent(
	env: Env,
	trigger: Pick<TriggerRow, "id" | "user_id" | "instance_id">,
	type: TriggerEventType,
	status: "received" | "running" | "succeeded" | "failed",
	opts: { message?: string; payload?: unknown; error?: string } = {},
): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO agent_trigger_events (id, trigger_id, user_id, instance_id, type, status, message, payload, error, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))`,
	)
		.bind(
			id,
			trigger.id,
			trigger.user_id,
			trigger.instance_id,
			type,
			status,
			opts.message ? opts.message.slice(0, 1000) : null,
			opts.payload === undefined ? null : safeJson(opts.payload),
			opts.error ? opts.error.slice(0, 1000) : null,
		)
		.run();
	return id;
}

/**
 * Execute ONE trigger action against a target instance and return its result payload.
 * Extracted from dispatchTrigger so the SAME action handlers (create_task / insert_record /
 * run_pipeline / add_knowledge / sync_connector) power the agent-to-agent "connection" pump
 * (lib/connections.ts): a connection is just a (source event → target action) edge, delivered
 * by calling this with a synthetic target. `target` only needs {action, name, instance_id,
 * user_id}; a real TriggerRow satisfies it. Throws on any dispatch failure (caller records it).
 */
export async function executeTriggerAction(
	env: Env,
	target: Pick<TriggerRow, "action" | "name" | "instance_id" | "user_id"> & Partial<TriggerRow>,
	config: TriggerConfig,
	sourceType: TriggerEventType,
	payload: unknown,
): Promise<unknown> {
	const stub = env.AGENT.get(env.AGENT.idFromName(target.instance_id));
	let resultPayload: unknown = payload;
	// #16: an explicit payload mapping wins over the fixed conventions below, because it is the
	// only thing the user actually stated. A mapped path that this payload doesn't have resolves
	// to nothing and falls through to the conventions, so adding a mapping can never make a
	// previously-working trigger produce less than it did.
	const mapped = applyMapping(payload, config.mapping, target.action);
	if (target.action === "create_task") {
		const body = payloadRecord(payload);
		const title = mapped.title || stringValue(body.title) || config.title || `${target.name} trigger`;
		const description = mapped.description || stringValue(body.description) || stringValue(body.content) || config.description || stringifyPayload(payload);
		const res = await stub.fetch(new Request("https://agent/tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title, description }),
		}));
		if (!res.ok) throw new Error(`task dispatch failed (${res.status})`);
	} else if (target.action === "add_knowledge") {
		const body = payloadRecord(payload);
		const content = mapped.content || stringValue(body.content) || stringValue(body.text) || stringifyPayload(payload);
		if (!content.trim()) throw new Error("knowledge trigger payload has no content");
		const title = mapped.title || stringValue(body.title) || config.title || `${target.name} ${new Date().toISOString()}`;
		const res = await stub.fetch(new Request("https://agent/knowledge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title,
				content: content.slice(0, 100_000),
				source: config.source || sourceType,
				sourceUrl: mapped.sourceUrl || stringValue(body.sourceUrl) || config.sourceUrl,
			}),
		}));
		if (!res.ok) throw new Error(`knowledge dispatch failed (${res.status})`);
	} else if (target.action === "log_event") {
		// log_event has no side effect beyond the event row itself — its whole value is the
		// recorded line. A mapping lets that line say something about the payload ("order 4471
		// shipped") instead of the generic "log_event dispatched" (#16).
		if (mapped.message) resultPayload = { ...payloadRecord(payload), message: mapped.message };
	} else if (target.action === "sync_connector") {
		resultPayload = await syncConnectorTrigger(env, target as TriggerRow, config);
	} else if (target.action === "run_pipeline") {
		// #92: a cron/webhook trigger kicks a durable, resumable per-instance pipeline
		// (escapes the 30s DO limit; reads/writes the instance's collections). The pipeline
		// is DATA — loaded by name from instance config via startPipelineRun — so adding a
		// new pipeline type never touches the closed `workflow` capability union.
		const name = stringValue(payloadRecord(payload).pipeline) || config.pipeline || "";
		if (!name) throw new Error("run_pipeline requires config.pipeline (the pipeline name)");
		// Run params = the trigger's STATIC params (config.params) overlaid with the event
		// payload. A pipeline usually needs both: settings that belong to the wiring (which
		// endpoint, which template) and data that belongs to the event (which lead). Without
		// the static half, anything not present on the inbound record was unreachable — a
		// connection can't inject config into someone else's payload.
		const staticParams = isRecord(config.params) ? config.params : {};
		const params = { ...staticParams, ...payloadRecord(payload) };
		// A connection stamps the emitting run onto config.traceId — carry it into the child run.
		const parentTraceId = typeof config.traceId === "string" ? config.traceId : null;
		const res = await startPipelineRun(env, target.instance_id, target.user_id, name, params, "trigger", parentTraceId);
		if (!res.ok) throw new Error(res.error);
		resultPayload = { pipeline: name, runId: res.runId, workflowId: res.workflowId };
	} else if (target.action === "insert_record") {
		// #92 (webhook → collection): the simple ingest case. The record is an explicit
		// `record`/`data` object in the payload, else the whole payload minus the routing key.
		const body = payloadRecord(payload);
		const collection = stringValue(body.collection) || config.collection || "";
		if (!collection) throw new Error("insert_record requires config.collection");
		const data = isRecord(body.record) ? body.record : isRecord(body.data) ? body.data : omitKey(body, "collection");
		const res = await stub.fetch(new Request(`https://agent/collections/${encodeURIComponent(collection)}/records`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data }),
		}));
		if (!res.ok) throw new Error(`record insert failed (${res.status})`);
		resultPayload = { collection };
	} else if (target.action === "run_browse") {
		// #172: schedule a generic browser task — fire the BROWSER_TASK workflow at the
		// configured start URL. Runner-offline (503) or a run already active (409) aren't
		// trigger failures — the user's machine just isn't ready this tick; record a skip +
		// notify and try again next schedule (so failure_count stays 0).
		const url = stringValue(payloadRecord(payload).url) || config.url || "";
		if (!url) throw new Error("run_browse requires config.url (the start URL)");
		try {
			const res = await startBrowserTask(env, target.instance_id, target.user_id, { url, dryRun: config.dryRun === true });
			resultPayload = { workflowId: res.workflowId, taskId: res.taskId, url };
		} catch (e) {
			const status = (e as { status?: number })?.status;
			if (status !== 503 && status !== 409) throw e;
			const offline = status === 503;
			resultPayload = { skipped: true, reason: offline ? "runner offline" : "a run is already in progress", url };
			// #358: the offline text used to name `pags up` unconditionally. For an agent whose
			// capabilities declare no runtime that is a false remedy — `pags up` skips it — so the
			// message is derived from what the agent actually declares.
			const caps = offline ? await capabilitiesForInstance(env, target.instance_id, target.user_id).catch(() => null) : null;
			await notifyUser(
				env,
				target.user_id,
				"trigger",
				"⏭️ Scheduled run skipped",
				offline
					? runnerSkipMessage(target.name, caps)
					: `${target.name}: a run is already in progress; skipping this one.`,
				instanceBoardLink(target.instance_id),
			).catch(() => undefined);
		}
	}
	return resultPayload;
}

export async function dispatchTrigger(
	env: Env,
	trigger: TriggerRow,
	sourceType: TriggerEventType,
	payload: unknown,
): Promise<{ ok: true; eventId: string }> {
	await recordTriggerEvent(env, trigger, sourceType, "running", { payload });
	const traceId = `trigger:${trigger.id}:${Date.now()}`;
	try {
		const config = parseConfig(trigger.config);
		const resultPayload = await executeTriggerAction(env, trigger, config, sourceType, payload);

		await env.DB.prepare(
			"UPDATE agent_triggers SET last_run_at = datetime('now'), failure_count = 0, last_error = NULL, updated_at = datetime('now') WHERE id = ?1",
		).bind(trigger.id).run();
		const eventId = await recordTriggerEvent(env, trigger, sourceType, "succeeded", {
			message: successMessage(trigger.action, resultPayload),
			payload: resultPayload,
		});
		await logEvent(env, {
			source: "trigger",
			event: "trigger.dispatched",
			message: `${trigger.name} dispatched ${trigger.action}`,
			userId: trigger.user_id,
			instanceId: trigger.instance_id,
			traceId,
			context: { triggerId: trigger.id, type: sourceType, action: trigger.action },
		});
		return { ok: true, eventId };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await env.DB.prepare(
			`UPDATE agent_triggers
       SET last_run_at = datetime('now'), failure_count = failure_count + 1, last_error = ?2, updated_at = datetime('now')
       WHERE id = ?1`,
		).bind(trigger.id, message.slice(0, 1000)).run();
		await recordTriggerEvent(env, trigger, sourceType, "failed", { payload, error: message });

		// #17: hand the failure to the SAME outbox connections use, rather than losing it.
		// Before this a failed cron or webhook was simply gone, so whether your automation
		// survived a transient outage depended on which kind of edge fired — and nothing said
		// which. Enqueueing here (not before the attempt) keeps the happy path free of a write:
		// the vast majority of dispatches succeed, and only a failure needs to become durable.
		//
		// The idempotency key is (source id, trace, payload) and the trace carries a timestamp,
		// so each dispatch enqueues at most one retry chain and a later dispatch is not
		// suppressed as a duplicate of an earlier failure.
		await enqueueDelivery(env, {
			connectionId: trigger.id,
			source: "trigger",
			userId: trigger.user_id,
			sourceInstanceId: trigger.instance_id,
			targetInstanceId: trigger.instance_id,
			eventType: `trigger.${sourceType}`,
			action: trigger.action,
			payload,
			config: parseConfig(trigger.config) as unknown as Record<string, unknown>,
			traceId,
		}).catch(() => null);

		await logEvent(env, {
			source: "trigger",
			event: "trigger.failed",
			level: "error",
			message,
			userId: trigger.user_id,
			instanceId: trigger.instance_id,
			traceId,
			context: { triggerId: trigger.id, type: sourceType, action: trigger.action },
		});
		throw err;
	}
}

export async function runDueTriggers(env: Env, now = new Date(), limit = 25): Promise<{ checked: number; dispatched: number; failed: number }> {
	const dueIso = now.toISOString();
	const { results } = await env.DB.prepare(
		`SELECT * FROM agent_triggers
     WHERE type = 'cron' AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1
     ORDER BY next_run_at ASC
     LIMIT ?2`,
	).bind(dueIso, limit).all<TriggerRow>();
	let dispatched = 0;
	let failed = 0;
	for (const trigger of results ?? []) {
		// Computing the next run must not be able to abort the SWEEP. `normalizeSchedule` throws
		// on anything the CURRENT grammar rejects, and rows exist that an older grammar accepted
		// — `* * * * *` was creatable until the minute-floor check (cf79306). Such a row is due
		// every tick, sorts first (ORDER BY next_run_at ASC), and threw before the claim UPDATE,
		// so its next_run_at never advanced and it was first again next minute: ONE bad row and
		// no cron trigger on the whole platform ever fires again, for any user, with nothing but
		// a repeating admin-log entry to say so.
		let next: string | null;
		try {
			const cfg = parseConfig(trigger.config);
			next = trigger.schedule ? applyJitter(nextRunAt(trigger.schedule, now, cfg.timezone), cfg.jitterMinutes) : null;
		} catch (e) {
			// Disable the row and record why. It cannot be repaired here (the schedule is invalid
			// under the current grammar), and leaving it enabled means re-hitting it every minute.
			await env.DB.prepare(
				"UPDATE agent_triggers SET enabled = 0, next_run_at = NULL, last_error = ?2, updated_at = datetime('now') WHERE id = ?1",
			)
				.bind(trigger.id, `Disabled: schedule "${trigger.schedule}" is no longer valid — ${e instanceof Error ? e.message : String(e)}`.slice(0, 300))
				.run()
				.catch(() => undefined);
			failed++;
			continue;
		}
		// Atomic claim (compare-and-swap on next_run_at): the "* * * * *" cron can have
		// overlapping scheduled() invocations, and a plain WHERE id=? UPDATE let BOTH read the
		// same due row and dispatch it → duplicate tasks/knowledge. Advance only if next_run_at
		// is STILL the due value we read; if another invocation already claimed it, skip dispatch.
		const claim = await env.DB.prepare(
			"UPDATE agent_triggers SET next_run_at = ?2, updated_at = datetime('now') WHERE id = ?1 AND next_run_at IS ?3",
		).bind(trigger.id, next, trigger.next_run_at).run();
		if (!claim.meta.changes) continue;
		try {
			await dispatchTrigger(env, trigger, "cron", { schedule: trigger.schedule, dueAt: dueIso });
			dispatched++;
		} catch {
			failed++;
		}
	}
	return { checked: results?.length ?? 0, dispatched, failed };
}

function payloadRecord(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function omitKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
	const { [key]: _omit, ...rest } = obj;
	return rest;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function stringifyPayload(payload: unknown): string {
	if (typeof payload === "string") return payload;
	return safeJson(payload);
}

function successMessage(action: TriggerAction, payload: unknown): string {
	const result = payloadRecord(payload);
	if (action === "sync_connector") {
		return describeSync(
			{
				scanned: Number(result.scanned || 0),
				imported: Number(result.imported || 0),
				updated: Number(result.updated || 0),
				skipped: Number(result.skipped || 0),
				foldersScanned: Number(result.foldersScanned || 0),
				truncated: result.truncated === true,
			},
			Array.isArray(result.errors) ? result.errors.length : 0,
		);
	}
	if (action === "run_pipeline") return `started pipeline "${stringValue(result.pipeline) || "?"}" (run ${stringValue(result.runId).slice(0, 8)})`;
	if (action === "insert_record") return `inserted a record into "${stringValue(result.collection) || "?"}"`;
	if (action === "run_browse") return result.skipped ? `browser run skipped — ${stringValue(result.reason) || "runner offline / busy"}` : `started browser run (task ${stringValue(result.taskId).slice(0, 8)})`;
	if (action === "log_event" && stringValue(result.message)) return stringValue(result.message).slice(0, 300);
	return `${action} dispatched`;
}

interface SyncItem {
	provider: ConnectorProvider;
	id: string;
	name: string;
	fingerprint: string;
	sourceUrl?: string;
	exportFile: () => Promise<{ title: string; content: string; sourceUrl?: string }>;
}

async function syncConnectorTrigger(
	env: Env,
	trigger: TriggerRow,
	config: TriggerConfig,
): Promise<{
	provider: ConnectorProvider;
	grantId: string;
	scanned: number;
	imported: number;
	updated: number;
	skipped: number;
	foldersScanned: number;
	truncated: boolean;
	errors: string[];
}> {
	const provider = config.provider;
	const grantId = config.grantId;
	if (!provider) throw new Error("sync_connector requires config.provider");
	if (!grantId) throw new Error("sync_connector requires config.grantId");
	const grant = await requireConnectorGrant(env, trigger.instance_id, trigger.user_id, provider, grantId);
	const limit = config.limit ?? 10;
	const errors: string[] = [];
	const listing = provider === "google_drive"
		? await listDriveSyncItems(env, trigger, grant.resourceId, config)
		: await listWorkDriveSyncItems(env, trigger, grant.resourceId, config);
	// A subtree we could not list is reported but does not fail the sync — one folder with a
	// permission hole must not stop every other document from syncing.
	for (const e of listing.errors) errors.push(`folder ${e.folderId}: ${e.message}`.slice(0, 300));
	let scanned = 0;
	let imported = 0;
	let updated = 0;
	let skipped = 0;
	const stub = env.AGENT.get(env.AGENT.idFromName(trigger.instance_id));
	for (const item of listing.items) {
		scanned++;
		// `limit` bounds WRITES per run (imports + updates), so a big changed batch still costs
		// a bounded number of DO round trips; the rest are picked up on the next run.
		if (imported + updated >= limit) {
			skipped++;
			continue;
		}
		const prior = await readSyncState(env, trigger, item.provider, item.id);
		const decision = syncDecision(prior, item.fingerprint, config.versioned === true);
		if (decision === "skip") {
			skipped++;
			continue;
		}
		try {
			const exported = await item.exportFile();
			if (!exported.content.trim()) {
				skipped++;
				continue;
			}
			const title = decision === "import" && config.versioned === true && prior
				? versionedTitle(exported.title, new Date())
				: exported.title;
			const body = JSON.stringify({
				title: title.slice(0, 500),
				content: exported.content.slice(0, 100_000),
				source: item.provider === "google_drive" ? "drive" : "workdrive",
				sourceUrl: exported.sourceUrl || item.sourceUrl,
			});

			let docId: string | undefined;
			let didUpdate = false;
			if (decision === "update" && prior?.importedDocId) {
				// PUT re-vectorizes in place (agent-do-knowledge `updateKnowledge`), so the agent
				// retrieves ONE current copy instead of one per edit.
				const res = await stub.fetch(new Request(`https://agent/knowledge/${encodeURIComponent(prior.importedDocId)}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body,
				}));
				if (res.ok) {
					docId = prior.importedDocId;
					didUpdate = true;
				} else if (res.status !== 404) {
					throw new Error(`knowledge update failed (${res.status})`);
				}
				// 404 = the doc was deleted in the console since we imported it. Fall through and
				// re-import rather than erroring: the source file still exists and is still granted.
			}
			if (!didUpdate) {
				const res = await stub.fetch(new Request("https://agent/knowledge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
				}));
				if (!res.ok) throw new Error(`knowledge import failed (${res.status})`);
				const doc = await res.json().catch(() => ({})) as { id?: string };
				docId = doc.id;
			}
			await upsertSyncState(env, trigger, item, docId);
			if (didUpdate) updated++;
			else imported++;
		} catch (err) {
			errors.push(`${item.name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
		}
	}
	return {
		provider,
		grantId,
		scanned,
		imported,
		updated,
		skipped,
		foldersScanned: listing.foldersScanned,
		truncated: listing.truncated,
		errors,
	};
}

/** What one provider listing produced, plus how far the walk actually got (#20). */
interface SyncListing {
	items: SyncItem[];
	foldersScanned: number;
	truncated: boolean;
	errors: { folderId: string; message: string }[];
}

async function listDriveSyncItems(
	env: Env,
	trigger: TriggerRow,
	grantedRootId: string,
	config: TriggerConfig,
): Promise<SyncListing> {
	const refresh = await readConnectorRefreshToken(env, trigger.user_id, "google_drive", "Google Drive");
	const accessToken = await mintDriveAccessToken(env, refresh);
	const folder = config.folderId || grantedRootId;
	// The ONE grant check. Everything below is reached by descending from this folder, so every
	// descendant is inside the grant by construction — there is no path by which the walk can
	// leave it.
	if (!await driveFileDescendsFrom(accessToken, folder, grantedRootId)) {
		throw new Error("Drive sync folder is outside the granted folder");
	}
	const walk = await walkFolderTree(
		folder,
		async (folderId) => {
			const files = await listDriveFolderFiles(accessToken, folderId, { query: config.query, pageSize: 50 });
			return files
				.filter((file) => isDriveFolder(file) || isDriveSyncable(file))
				.map((file) => ({ id: file.id, isFolder: isDriveFolder(file), file }));
		},
		resolveTraversalLimits(config),
	);
	return {
		items: walk.files.map((n) => driveSyncItem(accessToken, n.file)),
		foldersScanned: walk.foldersScanned,
		truncated: walk.truncated,
		errors: walk.errors,
	};
}

function driveSyncItem(accessToken: string, file: DriveFile): SyncItem {
	const fingerprint = [file.modifiedTime || "", file.size || "", file.mimeType].join(":") || file.id;
	return {
		provider: "google_drive",
		id: file.id,
		name: file.name,
		fingerprint,
		sourceUrl: file.webViewLink,
		exportFile: async () => {
			const exported = await exportDriveFile(accessToken, file.id);
			return {
				title: exported.name || file.name,
				content: exported.text,
				sourceUrl: exported.webViewLink || file.webViewLink,
			};
		},
	};
}

async function listWorkDriveSyncItems(
	env: Env,
	trigger: TriggerRow,
	grantedRootId: string,
	config: TriggerConfig,
): Promise<SyncListing> {
	const refresh = await readConnectorRefreshToken(env, trigger.user_id, "zoho_workdrive", "Zoho WorkDrive");
	const accessToken = await mintWorkDriveAccessToken(env, refresh);
	const folder = config.folderId || grantedRootId;
	// As with Drive: one grant check at the root, and the walk can only go downwards from it.
	if (!await workDriveFolderContainsFile(env, accessToken, grantedRootId, folder)) {
		throw new Error("WorkDrive sync folder is outside the granted folder");
	}
	const walk = await walkFolderTree(
		folder,
		async (folderId) => {
			const page = await listWorkDriveFolder(env, accessToken, folderId, { limit: 50 });
			return page.files
				.filter((file) => file.isFolder || isWorkDriveSyncable(file))
				.map((file) => ({ id: file.id, isFolder: file.isFolder, file }));
		},
		resolveTraversalLimits(config),
	);
	return {
		items: walk.files.map((n) => workDriveSyncItem(env, accessToken, n.file)),
		foldersScanned: walk.foldersScanned,
		truncated: walk.truncated,
		errors: walk.errors,
	};
}

function workDriveSyncItem(env: Env, accessToken: string, file: WorkDriveFile): SyncItem {
	const fingerprint = [file.modifiedTime || "", file.mimeType || "", file.extension || ""].join(":") || file.id;
	return {
		provider: "zoho_workdrive",
		id: file.id,
		name: file.name,
		fingerprint,
		sourceUrl: file.permalink,
		exportFile: async () => {
			const exported = await exportWorkDriveFile(env, accessToken, file.id);
			return {
				title: exported.name || file.name,
				content: exported.text,
				sourceUrl: exported.permalink || file.permalink,
			};
		},
	};
}

function isDriveSyncable(file: DriveFile): boolean {
	if (
		file.mimeType === "application/vnd.google-apps.document" ||
		file.mimeType === "application/vnd.google-apps.spreadsheet" ||
		file.mimeType === "application/vnd.google-apps.presentation"
	) return true;
	return (
		file.mimeType.startsWith("text/") ||
		file.mimeType === "application/json" ||
		file.mimeType === "application/xml" ||
		file.mimeType === "application/x-ndjson" ||
		file.mimeType === "application/yaml"
	);
}

function isWorkDriveSyncable(file: WorkDriveFile): boolean {
	const mime = (file.mimeType || "").toLowerCase();
	const ext = (file.extension || file.name.split(".").pop() || "").toLowerCase();
	return (
		mime.startsWith("text/") ||
		mime.includes("json") ||
		mime.includes("xml") ||
		["txt", "md", "csv", "json", "xml", "html", "htm", "yaml", "yml", "tsv"].includes(ext)
	);
}

/**
 * The recorded state for one source file, or null when this trigger has never imported it.
 *
 * This used to return only "does the fingerprint match", which is why the duplicate bug existed:
 * `imported_doc_id` was WRITTEN on every import and never read, so a changed file had nothing to
 * update and could only be re-created (#20).
 */
async function readSyncState(
	env: Env,
	trigger: TriggerRow,
	provider: ConnectorProvider,
	resourceId: string,
): Promise<PriorSyncState | null> {
	const row = await env.DB.prepare(
		`SELECT fingerprint, imported_doc_id FROM agent_trigger_sync_state
     WHERE trigger_id = ?1 AND provider = ?2 AND resource_id = ?3`,
	).bind(trigger.id, provider, resourceId).first<{ fingerprint: string; imported_doc_id: string | null }>();
	return row ? { fingerprint: row.fingerprint, importedDocId: row.imported_doc_id } : null;
}

async function upsertSyncState(
	env: Env,
	trigger: TriggerRow,
	item: SyncItem,
	importedDocId?: string,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO agent_trigger_sync_state
       (trigger_id, user_id, instance_id, provider, resource_id, fingerprint, imported_doc_id, source_url, imported_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), datetime('now'))
     ON CONFLICT(trigger_id, provider, resource_id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       imported_doc_id = excluded.imported_doc_id,
       source_url = excluded.source_url,
       updated_at = datetime('now')`,
	)
		.bind(
			trigger.id,
			trigger.user_id,
			trigger.instance_id,
			item.provider,
			item.id,
			item.fingerprint,
			importedDocId ?? null,
			item.sourceUrl ?? null,
		)
		.run();
}
