import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	applyJitter,
	assertTriggerAction,
	assertTriggerType,
	dispatchTrigger,
	makeTriggerSecret,
	nextRunAt,
	normalizeSchedule,
	parseConfig,
	previewRuns,
	publicWebhookUrl,
	recordTriggerEvent,
	safeJson,
	sanitizeTriggerName,
	type TriggerAction,
	type TriggerRow,
	type TriggerType,
} from "../lib/triggers.js";
import { validateTriggerConfig } from "../lib/trigger-config.js";
import type { Env } from "../types.js";

export const triggerRoutes = new Hono<{ Bindings: Env }>();

interface OwnedInstance {
	id: string;
	agent_id: string;
	user_id: string;
	status: string;
}

async function requireOwnedInstance(env: Env, userId: string, instanceId: string): Promise<OwnedInstance> {
	const row = await env.DB.prepare(
		"SELECT id, agent_id, user_id, status FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	).bind(instanceId, userId).first<OwnedInstance>();
	if (!row) throw new HttpError(404, "Instance not found");
	if (row.status !== "active") throw new HttpError(409, "Instance is not active");
	return row;
}

async function requireOwnedTrigger(env: Env, userId: string, triggerId: string): Promise<TriggerRow> {
	const row = await env.DB.prepare("SELECT * FROM agent_triggers WHERE id = ?1 AND user_id = ?2")
		.bind(triggerId, userId)
		.first<TriggerRow>();
	if (!row) throw new HttpError(404, "Trigger not found");
	return row;
}

function publicOrigin(requestUrl: string): string {
	const url = new URL(requestUrl);
	if (url.hostname.includes("localhost") || url.hostname === "127.0.0.1") return url.origin;
	return "https://api.proagentstore.online";
}

function presentTrigger(trigger: TriggerRow, origin: string) {
	return {
		id: trigger.id,
		userId: trigger.user_id,
		agentId: trigger.agent_id,
		instanceId: trigger.instance_id,
		name: trigger.name,
		type: trigger.type,
		action: trigger.action,
		enabled: trigger.enabled === 1,
		schedule: trigger.schedule,
		// The WHITELIST parse, not a raw JSON.parse (#16). This route used to echo the stored
		// JSON verbatim, so the console could display a field that dispatch would drop — the
		// config you were shown and the config that ran were different objects. They are now
		// the same one, which also means anything the console renders is guaranteed honoured.
		config: parseConfig(trigger.config) as Record<string, unknown>,
		lastRunAt: trigger.last_run_at,
		nextRunAt: trigger.next_run_at,
		failureCount: trigger.failure_count,
		lastError: trigger.last_error,
		createdAt: trigger.created_at,
		updatedAt: trigger.updated_at,
		webhookUrl: trigger.type === "webhook" && trigger.secret_token ? publicWebhookUrl(origin, trigger.secret_token) : undefined,
	};
}

/**
 * Reject a config that would be partly ignored, naming exactly which field and why (#16).
 *
 * This is the whole point of the ticket: `parseConfig` is a whitelist and the store path did no
 * validation, so a misspelled — or correctly-spelled-but-wrong-action — field was accepted,
 * persisted, shown back to the user, and then dropped at dispatch. Failing the save is the only
 * place the user is still looking at the thing they got wrong.
 */
function assertValidConfig(action: TriggerAction, type: TriggerType, config: unknown): void {
	const problems = validateTriggerConfig(action, type, config);
	if (problems.length) throw new HttpError(400, problems.join(" "));
}

/**
 * POST /v1/triggers/preview — "if I saved this, what would happen?" (#16 + #18)
 *
 * Answers two questions the console cannot answer for itself without lying:
 *
 *  • `runs` — the next few fire times, computed by the SAME `nextRunAt` the sweep calls, in the
 *    same process. A preview reimplemented in the browser would be a second scheduler, and the
 *    day the two disagree the UI confidently shows a time nothing will happen at. This one
 *    cannot drift, because there is nothing to drift from.
 *  • `issues` — every part of the config that would be stored and then ignored, in the same
 *    words the save path would use.
 *
 * Deliberately non-throwing on a bad schedule/config: a live preview should show ALL the
 * problems as you type, not fail on the first one. The save path still returns 400.
 */
triggerRoutes.post("/preview", async (c) => {
	await requireUser(c);
	const body = await c.req.json<{ type?: string; action?: string; schedule?: string; config?: Record<string, unknown>; count?: number }>().catch(() => ({}) as Record<string, never>);
	const type: TriggerType = body.type === "cron" ? "cron" : "webhook";
	let action: TriggerAction = "create_task";
	try {
		action = assertTriggerAction(body.action || "create_task");
	} catch {
		// An unknown action is the caller's bug, not something to 500 over — validate what we can.
	}
	const issues = validateTriggerConfig(action, type, body.config);
	const timezone = typeof body.config?.timezone === "string" ? body.config.timezone : undefined;
	const jitterMinutes = typeof body.config?.jitterMinutes === "number" ? body.config.jitterMinutes : undefined;
	let schedule: string | null = null;
	let runs: string[] = [];
	let error: string | null = null;
	if (type === "cron") {
		try {
			schedule = normalizeSchedule(body.schedule);
			runs = previewRuns(schedule, timezone, Math.max(1, Math.min(Number(body.count) || 3, 5)));
		} catch (e) {
			error = e instanceof Error ? e.message : "invalid schedule";
		}
	}
	return c.json({ schedule, timezone: timezone ?? null, jitterMinutes: jitterMinutes ?? null, runs, issues, error });
});

triggerRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.query("instanceId")?.trim();
	const binds: unknown[] = [session.uid];
	let where = "user_id = ?1";
	if (instanceId) {
		await requireOwnedInstance(c.env, session.uid, instanceId);
		binds.push(instanceId);
		where += ` AND instance_id = ?${binds.length}`;
	}
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM agent_triggers WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
	).bind(...binds).all<TriggerRow>();
	const origin = publicOrigin(c.req.url);
	return c.json({ triggers: (results ?? []).map((t) => presentTrigger(t, origin)) });
});

triggerRoutes.post("/", async (c) => {
	const session = await requireUser(c);
	const body = await c.req.json<{
		instanceId?: string;
		name?: string;
		type?: string;
		action?: string;
		schedule?: string;
		enabled?: boolean;
		config?: Record<string, unknown>;
	}>();
	if (!body.instanceId) throw new HttpError(400, "instanceId required");
	const instance = await requireOwnedInstance(c.env, session.uid, body.instanceId);
	const type = assertTriggerType(body.type);
	const action = assertTriggerAction(body.action || "create_task");
	const name = sanitizeTriggerName(body.name);
	assertValidConfig(action, type, body.config);
	const schedule = type === "cron" ? normalizeSchedule(body.schedule) : null;
	const timezone = typeof body.config?.timezone === "string" ? body.config.timezone : undefined;
	const next = schedule ? applyJitter(nextRunAt(schedule, new Date(), timezone), typeof body.config?.jitterMinutes === "number" ? body.config.jitterMinutes : undefined) : null;
	const secret = type === "webhook" ? makeTriggerSecret() : null;
	const id = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO agent_triggers
       (id, user_id, agent_id, instance_id, name, type, action, enabled, secret_token, schedule, config, next_run_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now'), datetime('now'))`,
	)
		.bind(
			id,
			session.uid,
			instance.agent_id,
			instance.id,
			name,
			type,
			action,
			body.enabled === false ? 0 : 1,
			secret,
			schedule,
			safeJson(body.config || {}),
			next,
		)
		.run();
	const trigger = await requireOwnedTrigger(c.env, session.uid, id);
	return c.json({ trigger: presentTrigger(trigger, publicOrigin(c.req.url)) }, 201);
});

triggerRoutes.put("/:id", async (c) => {
	const session = await requireUser(c);
	const trigger = await requireOwnedTrigger(c.env, session.uid, c.req.param("id"));
	const body = await c.req.json<{
		name?: string;
		action?: string;
		schedule?: string;
		enabled?: boolean;
		config?: Record<string, unknown>;
		rotateSecret?: boolean;
	}>();
	const name = body.name === undefined ? trigger.name : sanitizeTriggerName(body.name);
	const action: TriggerAction = body.action === undefined ? trigger.action : assertTriggerAction(body.action);
	// Validate against the config that will END UP stored under the action that will end up set —
	// an update that only changes `action` can strand config that was valid for the old one.
	const stored = parseConfig(trigger.config) as Record<string, unknown>;
	const effectiveConfig = body.config === undefined ? stored : body.config;
	assertValidConfig(action, trigger.type, effectiveConfig);
	let schedule = trigger.schedule;
	let next = trigger.next_run_at;
	const timezone = typeof effectiveConfig.timezone === "string" ? effectiveConfig.timezone : undefined;
	const zoneChanged = body.config !== undefined && timezone !== (typeof stored.timezone === "string" ? stored.timezone : undefined);
	if (trigger.type === "cron" && (body.schedule !== undefined || zoneChanged)) {
		schedule = body.schedule === undefined ? trigger.schedule : normalizeSchedule(body.schedule);
		const jm = typeof effectiveConfig.jitterMinutes === "number" ? effectiveConfig.jitterMinutes : undefined;
		// Changing the ZONE changes when the same expression fires, so the stored next_run_at is
		// stale the moment it changes. Not recomputing here would leave the trigger firing on the
		// old zone until its next run — and the console would show a next-run time that is wrong.
		next = schedule ? applyJitter(nextRunAt(schedule, new Date(), timezone), jm) : next;
	}
	const secret = trigger.type === "webhook" && body.rotateSecret === true ? makeTriggerSecret() : trigger.secret_token;
	await c.env.DB.prepare(
		`UPDATE agent_triggers
     SET name = ?2, action = ?3, enabled = ?4, secret_token = ?5, schedule = ?6, config = ?7, next_run_at = ?8, updated_at = datetime('now')
     WHERE id = ?1 AND user_id = ?9`,
	)
		.bind(
			trigger.id,
			name,
			action,
			body.enabled === undefined ? trigger.enabled : body.enabled ? 1 : 0,
			secret,
			schedule,
			body.config === undefined ? trigger.config : safeJson(body.config),
			next,
			session.uid,
		)
		.run();
	const updated = await requireOwnedTrigger(c.env, session.uid, trigger.id);
	return c.json({ trigger: presentTrigger(updated, publicOrigin(c.req.url)) });
});

triggerRoutes.delete("/:id", async (c) => {
	const session = await requireUser(c);
	const trigger = await requireOwnedTrigger(c.env, session.uid, c.req.param("id"));
	await c.env.DB.prepare("DELETE FROM agent_trigger_sync_state WHERE trigger_id = ?1 AND user_id = ?2")
		.bind(trigger.id, session.uid)
		.run()
		.catch(() => undefined);
	await c.env.DB.prepare("DELETE FROM agent_trigger_events WHERE trigger_id = ?1 AND user_id = ?2")
		.bind(trigger.id, session.uid)
		.run();
	await c.env.DB.prepare("DELETE FROM agent_triggers WHERE id = ?1 AND user_id = ?2")
		.bind(trigger.id, session.uid)
		.run();
	return c.json({ success: true });
});

triggerRoutes.get("/:id/events", async (c) => {
	const session = await requireUser(c);
	const trigger = await requireOwnedTrigger(c.env, session.uid, c.req.param("id"));
	const limit = Math.max(1, Math.min(Number(c.req.query("limit")) || 50, 200));
	const { results } = await c.env.DB.prepare(
		`SELECT id, trigger_id, user_id, instance_id, type, status, message, payload, error, created_at
     FROM agent_trigger_events
     WHERE trigger_id = ?1 AND user_id = ?2
     ORDER BY created_at DESC
     LIMIT ?3`,
	).bind(trigger.id, session.uid, limit).all();
	return c.json({ events: results ?? [] });
});

triggerRoutes.post("/:id/run", async (c) => {
	const session = await requireUser(c);
	const trigger = await requireOwnedTrigger(c.env, session.uid, c.req.param("id"));
	const payload = await c.req.json().catch(() => ({}));
	await dispatchTrigger(c.env, trigger, "manual", payload);
	return c.json({ success: true });
});

/** Public unauthenticated webhook endpoint. The token is a high-entropy capability URL. */
triggerRoutes.post("/webhook/:token", async (c) => {
	const token = c.req.param("token");
	const trigger = await c.env.DB.prepare("SELECT * FROM agent_triggers WHERE secret_token = ?1 AND type = 'webhook'")
		.bind(token)
		.first<TriggerRow>();
	if (!trigger || trigger.enabled !== 1) throw new HttpError(404, "Webhook trigger not found");
	await recordTriggerEvent(c.env, trigger, "webhook", "received");
	const contentType = c.req.header("content-type") || "";
	const payload = contentType.includes("application/json") ? await c.req.json().catch(() => ({})) : { text: await c.req.text() };
	await dispatchTrigger(c.env, trigger, "webhook", payload);
	return c.json({ ok: true }, 202 as ContentfulStatusCode);
});
