/**
 * The per-instance coder brain switch (#1025 §1, minimal slice built for #1027).
 *
 * Two flags, both default OFF: `enabled` (the brain itself) and `poEnabled` (the scheduled
 * product-owner triage of #1027, which needs the brain on). Stored on the instance config as
 * `coderBrain`. One writer, {@link setCoderBrain}, and one reader, {@link readCoderBrain} — so the
 * #664 failure (a flag exists and nothing honours it) cannot recur: the wake asks the reader, and
 * the writer keeps the wake's triggers in step.
 *
 * The product-owner wake is an ordinary `run_po_triage` cron trigger (#1027 comment), so turning
 * it on creates a default one when the instance has none, and turning the brain or the PO layer
 * off disables every one of them. The owner may add more windows or change the schedule like any
 * other trigger; this never deletes a trigger.
 */
import type { Env } from "../types.js";
import { advanceCron } from "./cron-schedule.js";
import { patchInstanceConfig } from "./instance-config.js";
import { isValidTimeZone } from "./cron-time.js";

export interface CoderBrainSettings {
	enabled: boolean;
	poEnabled: boolean;
}

export const CODER_BRAIN_OFF: CoderBrainSettings = { enabled: false, poEnabled: false };
export const PO_TRIAGE_ACTION = "run_po_triage" as const;
export const PO_TRIAGE_DEFAULT_TIMEZONE = "Australia/Melbourne";

/** From a stored instance config blob. Anything not literally `true` is off. */
export function coderBrainFrom(config: unknown): CoderBrainSettings {
	let parsed: unknown = config;
	if (typeof config === "string") {
		try {
			parsed = JSON.parse(config);
		} catch {
			return CODER_BRAIN_OFF;
		}
	}
	const cb = parsed && typeof parsed === "object" ? (parsed as { coderBrain?: unknown }).coderBrain : undefined;
	if (!cb || typeof cb !== "object") return CODER_BRAIN_OFF;
	const enabled = (cb as { enabled?: unknown }).enabled === true;
	// The PO layer uses the brain: with the brain off it is off, whatever was stored.
	return { enabled, poEnabled: enabled && (cb as { poEnabled?: unknown }).poEnabled === true };
}

/** The ONE reader. Null when the instance is not the caller's. */
export async function readCoderBrain(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<CoderBrainSettings | null> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string | null }>();
	return row ? coderBrainFrom(row.config) : null;
}

/**
 * The default wake minute for an instance: 1-59, never :00, spread by a hash of the id so every
 * instance does not wake in the same minute.
 */
export function poTriageDefaultMinute(instanceId: string): number {
	let h = 2166136261;
	for (let i = 0; i < instanceId.length; i++) h = Math.imul(h ^ instanceId.charCodeAt(i), 16777619);
	return 1 + ((h >>> 0) % 59);
}

/**
 * The ONE writer. Applies the patch, then brings the instance's `run_po_triage` triggers in line:
 * on → enabled (a default hourly one, dry run, created if there is none); off → all disabled.
 */
export async function setCoderBrain(env: Env, instanceId: string, userId: string, patch: Partial<CoderBrainSettings>): Promise<{ settings: CoderBrainSettings; triggers: { created: string | null; enabled: number; disabled: number } }> {
	const current = await readCoderBrain(env, instanceId, userId);
	if (!current) throw new Error("instance not found");
	const enabled = typeof patch.enabled === "boolean" ? patch.enabled : current.enabled;
	const poEnabled = enabled && (typeof patch.poEnabled === "boolean" ? patch.poEnabled : current.poEnabled);
	const settings = { enabled, poEnabled };
	if (!(await patchInstanceConfig(env, instanceId, userId, "coderBrain", settings))) throw new Error("instance not found");
	const triggers = await syncPoTriageTriggers(env, instanceId, userId, poEnabled);
	return { settings, triggers };
}

async function syncPoTriageTriggers(env: Env, instanceId: string, userId: string, on: boolean): Promise<{ created: string | null; enabled: number; disabled: number }> {
	if (!on) {
		const res = await env.DB.prepare("UPDATE agent_triggers SET enabled = 0, updated_at = datetime('now') WHERE instance_id = ?1 AND user_id = ?2 AND action = ?3 AND enabled = 1")
			.bind(instanceId, userId, PO_TRIAGE_ACTION)
			.run();
		return { created: null, enabled: 0, disabled: res.meta?.changes ?? 0 };
	}
	const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_triggers WHERE instance_id = ?1 AND user_id = ?2 AND action = ?3").bind(instanceId, userId, PO_TRIAGE_ACTION).first<{ n: number }>();
	let created: string | null = null;
	if (!existing?.n) {
		const inst = await env.DB.prepare("SELECT agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ agent_id: string }>();
		if (!inst) throw new Error("instance not found");
		const schedule = `${poTriageDefaultMinute(instanceId)} * * * *`;
		const config = { timezone: PO_TRIAGE_DEFAULT_TIMEZONE, dryRun: true };
		const advance = advanceCron(schedule, { now: new Date(), timeZone: config.timezone });
		created = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO agent_triggers (id, user_id, agent_id, instance_id, name, type, action, enabled, secret_token, schedule, config, next_run_at, next_slot_at, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, 'Product-owner triage', 'cron', ?5, 1, NULL, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))`,
		)
			.bind(created, userId, inst.agent_id, instanceId, PO_TRIAGE_ACTION, schedule, JSON.stringify(config), advance?.fire ?? null, advance?.slot ?? null)
			.run();
	}
	// Re-enable from NOW: a stale next_run_at would fire at once (or, when null, never).
	const { results } = await env.DB.prepare("SELECT id, schedule, config FROM agent_triggers WHERE instance_id = ?1 AND user_id = ?2 AND action = ?3 AND enabled = 0")
		.bind(instanceId, userId, PO_TRIAGE_ACTION)
		.all<{ id: string; schedule: string | null; config: string | null }>();
	let enabledCount = 0;
	for (const t of results ?? []) {
		const cfg = scheduleConfig(t.config);
		let advance: ReturnType<typeof advanceCron> | null = null;
		try {
			advance = t.schedule ? advanceCron(t.schedule, { now: new Date(), timeZone: cfg.timezone, jitterMinutes: cfg.jitterMinutes }) : null;
		} catch {
			continue; // a schedule the current grammar rejects stays off, as the sweep would leave it
		}
		await env.DB.prepare("UPDATE agent_triggers SET enabled = 1, next_run_at = ?2, next_slot_at = ?3, updated_at = datetime('now') WHERE id = ?1 AND enabled = 0")
			.bind(t.id, advance?.fire ?? null, advance?.slot ?? null)
			.run();
		enabledCount++;
	}
	return { created, enabled: enabledCount, disabled: 0 };
}

/** The two schedule fields of a stored trigger config — read here, not via triggers.ts, which imports this module. */
function scheduleConfig(raw: string | null): { timezone?: string; jitterMinutes?: number } {
	try {
		const c = raw ? (JSON.parse(raw) as { timezone?: unknown; jitterMinutes?: unknown }) : {};
		return {
			timezone: isValidTimeZone(c.timezone) ? c.timezone : undefined,
			jitterMinutes: typeof c.jitterMinutes === "number" ? Math.max(0, Math.min(Math.trunc(c.jitterMinutes), 720)) : undefined,
		};
	} catch {
		return {};
	}
}
