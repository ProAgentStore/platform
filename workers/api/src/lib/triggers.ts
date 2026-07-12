import { HttpError } from "./auth.js";
import { requireConnectorGrant, type ConnectorProvider } from "./connector-grants.js";
import { readConnectorRefreshToken } from "./connector-oauth.js";
import {
	driveFileDescendsFrom,
	exportDriveFile,
	isDriveFolder,
	listDriveFolderFiles,
	mintDriveAccessToken,
	type DriveFile,
} from "./drive.js";
import { logEvent } from "./events.js";
import {
	exportWorkDriveFile,
	listWorkDriveFolder,
	mintWorkDriveAccessToken,
	workDriveFolderContainsFile,
	type WorkDriveFile,
} from "./workdrive.js";
import type { Env } from "../types.js";

export type TriggerType = "webhook" | "cron";
export type TriggerAction = "create_task" | "add_knowledge" | "log_event" | "sync_connector";
export type TriggerEventType = TriggerType | "manual";

export interface TriggerRow {
	id: string;
	user_id: string;
	agent_id: string;
	instance_id: string;
	name: string;
	type: TriggerType;
	action: TriggerAction;
	enabled: number;
	secret_token: string | null;
	schedule: string | null;
	config: string;
	last_run_at: string | null;
	next_run_at: string | null;
	failure_count: number;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

export interface TriggerConfig {
	title?: string;
	description?: string;
	source?: string;
	sourceUrl?: string;
	provider?: ConnectorProvider;
	grantId?: string;
	folderId?: string;
	limit?: number;
	query?: string;
}

const ACTIONS = new Set<TriggerAction>(["create_task", "add_knowledge", "log_event", "sync_connector"]);
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
		throw new HttpError(400, "trigger action must be create_task, add_knowledge, log_event, or sync_connector");
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
		return parts.join(" ");
	}
	throw new HttpError(400, "unsupported schedule; use @hourly, @daily, every N minutes, or a simple 5-field cron");
}

function validRange(part: string, min: number, max: number): boolean {
	if (part === "*") return true;
	const n = Number(part);
	return Number.isInteger(n) && n >= min && n <= max;
}

export function nextRunAt(schedule: string, from = new Date()): string {
	const normalized = normalizeSchedule(schedule);
	const base = new Date(from.getTime());
	base.setUTCSeconds(0, 0);
	if (normalized === "@hourly") return addMinutes(base, 60).toISOString();
	if (normalized === "@daily") return nextDaily(base, 0).toISOString();
	if (normalized === "@weekly") return nextWeekly(base, 0, 0).toISOString();
	const every = normalized.match(/^every\s+(\d+)\s+minutes$/);
	if (every) return addMinutes(base, Number(every[1])).toISOString();

	const [minute, hour, day, month, weekday] = normalized.split(" ");
	let cursor = addMinutes(base, 1);
	for (let i = 0; i < 366 * 24 * 60; i++) {
		if (
			matchesCron(minute, cursor.getUTCMinutes()) &&
			matchesCron(hour, cursor.getUTCHours()) &&
			matchesCron(day, cursor.getUTCDate()) &&
			matchesCron(month, cursor.getUTCMonth() + 1) &&
			matchesCron(weekday, cursor.getUTCDay())
		) {
			return cursor.toISOString();
		}
		cursor = addMinutes(cursor, 1);
	}
	throw new HttpError(400, "schedule has no run in the next year");
}

function addMinutes(date: Date, minutes: number): Date {
	return new Date(date.getTime() + minutes * 60_000);
}

function nextDaily(base: Date, hour: number): Date {
	const next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, 0, 0, 0));
	if (next <= base) next.setUTCDate(next.getUTCDate() + 1);
	return next;
}

function nextWeekly(base: Date, weekday: number, hour: number): Date {
	const next = nextDaily(base, hour);
	while (next.getUTCDay() !== weekday) next.setUTCDate(next.getUTCDate() + 1);
	return next;
}

function matchesCron(part: string, value: number): boolean {
	return part === "*" || Number(part) === value || (part === "7" && value === 0);
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
		const stub = env.AGENT.get(env.AGENT.idFromName(trigger.instance_id));
		let resultPayload: unknown = payload;
		if (trigger.action === "create_task") {
			const body = payloadRecord(payload);
			const title = stringValue(body.title) || config.title || `${trigger.name} trigger`;
			const description = stringValue(body.description) || stringValue(body.content) || config.description || stringifyPayload(payload);
			const res = await stub.fetch(new Request("https://agent/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title, description }),
			}));
			if (!res.ok) throw new Error(`task dispatch failed (${res.status})`);
		} else if (trigger.action === "add_knowledge") {
			const body = payloadRecord(payload);
			const content = stringValue(body.content) || stringValue(body.text) || stringifyPayload(payload);
			if (!content.trim()) throw new Error("knowledge trigger payload has no content");
			const title = stringValue(body.title) || config.title || `${trigger.name} ${new Date().toISOString()}`;
			const res = await stub.fetch(new Request("https://agent/knowledge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title,
					content: content.slice(0, 100_000),
					source: config.source || sourceType,
					sourceUrl: stringValue(body.sourceUrl) || config.sourceUrl,
				}),
			}));
			if (!res.ok) throw new Error(`knowledge dispatch failed (${res.status})`);
		} else if (trigger.action === "sync_connector") {
			resultPayload = await syncConnectorTrigger(env, trigger, config);
		}

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
		const next = trigger.schedule ? nextRunAt(trigger.schedule, now) : null;
		await env.DB.prepare(
			"UPDATE agent_triggers SET next_run_at = ?2, updated_at = datetime('now') WHERE id = ?1",
		).bind(trigger.id, next).run();
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

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function stringifyPayload(payload: unknown): string {
	if (typeof payload === "string") return payload;
	return safeJson(payload);
}

function successMessage(action: TriggerAction, payload: unknown): string {
	if (action !== "sync_connector") return `${action} dispatched`;
	const result = payloadRecord(payload);
	return `connector sync imported ${Number(result.imported || 0)} file(s), skipped ${Number(result.skipped || 0)}`;
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
): Promise<{ provider: ConnectorProvider; grantId: string; scanned: number; imported: number; skipped: number; errors: string[] }> {
	const provider = config.provider;
	const grantId = config.grantId;
	if (!provider) throw new Error("sync_connector requires config.provider");
	if (!grantId) throw new Error("sync_connector requires config.grantId");
	const grant = await requireConnectorGrant(env, trigger.instance_id, trigger.user_id, provider, grantId);
	const limit = config.limit ?? 10;
	const items = provider === "google_drive"
		? await listDriveSyncItems(env, trigger, grant.resourceId, config)
		: await listWorkDriveSyncItems(env, trigger, grant.resourceId, config);
	let scanned = 0;
	let imported = 0;
	let skipped = 0;
	const errors: string[] = [];
	const stub = env.AGENT.get(env.AGENT.idFromName(trigger.instance_id));
	for (const item of items) {
		scanned++;
		if (imported >= limit) {
			skipped++;
			continue;
		}
		if (await syncStateMatches(env, trigger, item.provider, item.id, item.fingerprint)) {
			skipped++;
			continue;
		}
		try {
			const exported = await item.exportFile();
			if (!exported.content.trim()) {
				skipped++;
				continue;
			}
			const res = await stub.fetch(new Request("https://agent/knowledge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: exported.title.slice(0, 500),
					content: exported.content.slice(0, 100_000),
					source: item.provider === "google_drive" ? "drive" : "workdrive",
					sourceUrl: exported.sourceUrl || item.sourceUrl,
				}),
			}));
			if (!res.ok) throw new Error(`knowledge import failed (${res.status})`);
			const doc = await res.json().catch(() => ({})) as { id?: string };
			await upsertSyncState(env, trigger, item, doc.id);
			imported++;
		} catch (err) {
			errors.push(`${item.name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
		}
	}
	return { provider, grantId, scanned, imported, skipped, errors };
}

async function listDriveSyncItems(
	env: Env,
	trigger: TriggerRow,
	grantedRootId: string,
	config: TriggerConfig,
): Promise<SyncItem[]> {
	const refresh = await readConnectorRefreshToken(env, trigger.user_id, "google_drive", "Google Drive");
	const accessToken = await mintDriveAccessToken(env, refresh);
	const folder = config.folderId || grantedRootId;
	if (!await driveFileDescendsFrom(accessToken, folder, grantedRootId)) {
		throw new Error("Drive sync folder is outside the granted folder");
	}
	const files = await listDriveFolderFiles(accessToken, folder, { query: config.query, pageSize: 50 });
	return files.filter((file) => !isDriveFolder(file) && isDriveSyncable(file)).map((file) => driveSyncItem(accessToken, file));
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
): Promise<SyncItem[]> {
	const refresh = await readConnectorRefreshToken(env, trigger.user_id, "zoho_workdrive", "Zoho WorkDrive");
	const accessToken = await mintWorkDriveAccessToken(env, refresh);
	const folder = config.folderId || grantedRootId;
	if (!await workDriveFolderContainsFile(env, accessToken, grantedRootId, folder)) {
		throw new Error("WorkDrive sync folder is outside the granted folder");
	}
	const page = await listWorkDriveFolder(env, accessToken, folder, { limit: 50 });
	return page.files.filter((file) => !file.isFolder && isWorkDriveSyncable(file)).map((file) => workDriveSyncItem(env, accessToken, file));
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

async function syncStateMatches(
	env: Env,
	trigger: TriggerRow,
	provider: ConnectorProvider,
	resourceId: string,
	fingerprint: string,
): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT fingerprint FROM agent_trigger_sync_state
     WHERE trigger_id = ?1 AND provider = ?2 AND resource_id = ?3`,
	).bind(trigger.id, provider, resourceId).first<{ fingerprint: string }>();
	return row?.fingerprint === fingerprint;
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
