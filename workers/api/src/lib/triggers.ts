import { HttpError } from "./auth.js";
import { logEvent } from "./events.js";
import type { Env } from "../types.js";

export type TriggerType = "webhook" | "cron";
export type TriggerAction = "create_task" | "add_knowledge" | "log_event";
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
}

const ACTIONS = new Set<TriggerAction>(["create_task", "add_knowledge", "log_event"]);
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
		throw new HttpError(400, "trigger action must be create_task, add_knowledge, or log_event");
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
		const stub = env.AGENT.get(env.AGENT.idFromName(trigger.instance_id));
		const config = parseConfig(trigger.config);
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
		}

		await env.DB.prepare(
			"UPDATE agent_triggers SET last_run_at = datetime('now'), failure_count = 0, last_error = NULL, updated_at = datetime('now') WHERE id = ?1",
		).bind(trigger.id).run();
		const eventId = await recordTriggerEvent(env, trigger, sourceType, "succeeded", { message: `${trigger.action} dispatched`, payload });
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
