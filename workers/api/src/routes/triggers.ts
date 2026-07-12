import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	assertTriggerAction,
	assertTriggerType,
	dispatchTrigger,
	makeTriggerSecret,
	nextRunAt,
	normalizeSchedule,
	publicWebhookUrl,
	recordTriggerEvent,
	safeJson,
	sanitizeTriggerName,
	type TriggerAction,
	type TriggerRow,
	type TriggerType,
} from "../lib/triggers.js";
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
		config: parseConfig(trigger.config),
		lastRunAt: trigger.last_run_at,
		nextRunAt: trigger.next_run_at,
		failureCount: trigger.failure_count,
		lastError: trigger.last_error,
		createdAt: trigger.created_at,
		updatedAt: trigger.updated_at,
		webhookUrl: trigger.type === "webhook" && trigger.secret_token ? publicWebhookUrl(origin, trigger.secret_token) : undefined,
	};
}

function parseConfig(value: string): Record<string, unknown> {
	try {
		return JSON.parse(value) as Record<string, unknown>;
	} catch {
		return {};
	}
}

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
	const schedule = type === "cron" ? normalizeSchedule(body.schedule) : null;
	const next = schedule ? nextRunAt(schedule) : null;
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
	let schedule = trigger.schedule;
	let next = trigger.next_run_at;
	if (trigger.type === "cron" && body.schedule !== undefined) {
		schedule = normalizeSchedule(body.schedule);
		next = nextRunAt(schedule);
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
