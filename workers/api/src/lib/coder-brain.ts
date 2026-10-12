/**
 * The per-instance coder brain settings (#1025 §1; the triage flag is #1027's).
 *
 * Both switches default OFF: `enabled` (the brain itself — it may answer a stuck coder's question
 * after the human timeout, #1025) and `poEnabled` (the scheduled product-owner triage of #1027,
 * which needs the brain on). Beside them, #1025's knobs: the `model` (a `BRAIN_MODELS` id), the two
 * timeouts, the per-run decision cap and the confidence threshold. Stored on the instance config as
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
import { brainModel } from "./brain-models.js";

export interface CoderBrainSettings {
	enabled: boolean;
	poEnabled: boolean;
	/** A `BRAIN_MODELS` id. Runs on the owner's own provider key (BYOK), billed like every brain call. */
	model: string;
	/** How long a question waits for a person before the brain may decide. */
	humanTimeoutMinutes: number;
	/** How long an escalated question waits again before the run is told to finish what it can. */
	escalationTimeoutMinutes: number;
	/** The most questions the brain may answer in one run; past it, it declines. */
	maxDecisionsPerRun: number;
	/** Below this confidence the brain declines rather than decides. */
	confidenceThreshold: number;
}

export const CODER_BRAIN_DEFAULTS = { model: "claude-sonnet-4-6", humanTimeoutMinutes: 30, escalationTimeoutMinutes: 60, maxDecisionsPerRun: 3, confidenceThreshold: 0.8 } as const;
export const CODER_BRAIN_OFF: CoderBrainSettings = { enabled: false, poEnabled: false, ...CODER_BRAIN_DEFAULTS };

/** Each numeric knob's bounds — the writer refuses outside them, the reader clamps a stored stray. */
const BOUNDS = {
	humanTimeoutMinutes: [1, 1440],
	escalationTimeoutMinutes: [1, 1440],
	maxDecisionsPerRun: [0, 20],
	confidenceThreshold: [0.5, 1],
} as const;
type NumericKnob = keyof typeof BOUNDS;
const inBounds = (k: NumericKnob, v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= BOUNDS[k][0] && v <= BOUNDS[k][1] && (k === "confidenceThreshold" || Number.isInteger(v));
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
	const c = cb as Record<string, unknown>;
	const enabled = c.enabled === true;
	const knob = (k: NumericKnob) => (inBounds(k, c[k]) ? c[k] : CODER_BRAIN_DEFAULTS[k]);
	return {
		enabled,
		// The PO layer uses the brain: with the brain off it is off, whatever was stored.
		poEnabled: enabled && c.poEnabled === true,
		model: typeof c.model === "string" && brainModel(c.model) ? c.model : CODER_BRAIN_DEFAULTS.model,
		humanTimeoutMinutes: knob("humanTimeoutMinutes"),
		escalationTimeoutMinutes: knob("escalationTimeoutMinutes"),
		maxDecisionsPerRun: knob("maxDecisionsPerRun"),
		confidenceThreshold: knob("confidenceThreshold"),
	};
}

/** Why a settings patch is refused, or null. The writer's validation, exported for the route's 400. */
export function coderBrainPatchProblem(patch: Partial<Record<keyof CoderBrainSettings, unknown>>): string | null {
	for (const k of ["enabled", "poEnabled"] as const) if (patch[k] !== undefined && typeof patch[k] !== "boolean") return `${k} must be true or false.`;
	if (patch.model !== undefined && !(typeof patch.model === "string" && brainModel(patch.model))) return "model must be one of the brain models (see BRAIN_MODELS).";
	for (const k of Object.keys(BOUNDS) as NumericKnob[]) {
		if (patch[k] !== undefined && !inBounds(k, patch[k])) return `${k} must be ${k === "confidenceThreshold" ? "a number" : "a whole number"} from ${BOUNDS[k][0]} to ${BOUNDS[k][1]}.`;
	}
	return null;
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
	const problem = coderBrainPatchProblem(patch);
	if (problem) throw new Error(problem);
	const current = await readCoderBrain(env, instanceId, userId);
	if (!current) throw new Error("instance not found");
	const enabled = typeof patch.enabled === "boolean" ? patch.enabled : current.enabled;
	const poEnabled = enabled && (typeof patch.poEnabled === "boolean" ? patch.poEnabled : current.poEnabled);
	const settings: CoderBrainSettings = { ...current, ...patch, enabled, poEnabled };
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
