import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	assertTriggerAction,
	assertTriggerType,
	dispatchTrigger,
	makeTriggerSecret,
	parseConfig,
	publicWebhookUrl,
	recordTriggerEvent,
	safeJson,
	sanitizeTriggerName,
	type TriggerAction,
	type TriggerRow,
	type TriggerType,
} from "../lib/triggers.js";
import { advanceCron, normalizeSchedule, previewRuns } from "../lib/cron-schedule.js";
import { validateTriggerConfig } from "../lib/trigger-config.js";
import { triggerActionDenial, triggerActionOffers } from "../lib/trigger-capability.js";
import { activeInstanceSql, isActiveInstanceStatus } from "../lib/trigger-eligibility.js";
import { agentCapabilities, capabilitiesForInstance, type AgentCapabilities } from "../lib/agent-capabilities.js";
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
	// The shared predicate, not a second `!== "active"` (#649): this file already refused every
	// instance-scoped trigger operation on a cancelled instance, and the value it refuses on must
	// be the one the sweep, the pump and the retry loop admit on, spelled once.
	if (!isActiveInstanceStatus(row.status)) throw new HttpError(409, "Instance is not active");
	return row;
}

async function requireOwnedTrigger(env: Env, userId: string, triggerId: string): Promise<TriggerRow> {
	const row = await env.DB.prepare("SELECT * FROM agent_triggers WHERE id = ?1 AND user_id = ?2")
		.bind(triggerId, userId)
		.first<TriggerRow>();
	if (!row) throw new HttpError(404, "Trigger not found");
	return row;
}

/**
 * The trigger, refused when its instance is not active (#649).
 *
 * Only `/run` uses this. Read, edit and DELETE deliberately keep the plain lookup: gating those
 * would strand a cancelled instance's triggers — unreachable AND undeletable — which is the
 * recovery problem this issue is half about, not a fix for it.
 *
 * `/run` is owner-initiated and explicit, which is the argument for leaving it open; it is gated
 * anyway, for two reasons that outweigh it. First, `requireOwnedInstance` twelve lines up already
 * 409s create/list/preview for a non-active instance, so an open `/run` is the same operation
 * allowed through one door and refused through the other — an inconsistency, not a capability.
 * Second, `/run` dispatches exactly what the cron would (`run_pipeline`, `start_apply`), so the
 * spend it authorises is the spend #649 exists to stop; "the owner asked for it" does not make a
 * retired instance able to do work. Cancellation is terminal today — no route writes
 * `agent_instances.status = 'active'` — so no "test it after re-activating" case is lost.
 */
async function requireRunnableTrigger(env: Env, userId: string, triggerId: string): Promise<TriggerRow> {
	const row = await env.DB.prepare(
		`SELECT t.*, i.status AS instance_status FROM agent_triggers t
       JOIN agent_instances i ON i.id = t.instance_id
     WHERE t.id = ?1 AND t.user_id = ?2`,
	)
		.bind(triggerId, userId)
		.first<TriggerRow & { instance_status: string }>();
	if (!row) throw new HttpError(404, "Trigger not found");
	if (!isActiveInstanceStatus(row.instance_status)) throw new HttpError(409, "Instance is not active");
	const { instance_status: _status, ...trigger } = row;
	return trigger as TriggerRow;
}

function publicOrigin(requestUrl: string): string {
	const url = new URL(requestUrl);
	if (url.hostname.includes("localhost") || url.hostname === "127.0.0.1") return url.origin;
	return "https://api.proagentstore.online";
}

function presentTrigger(trigger: TriggerRow, origin: string, unavailable: string | null = null) {
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
		/**
		 * Why this saved trigger can never run, or null (#358).
		 *
		 * Rows predating the create-time gate exist, and some of them are wired to an action their
		 * agent cannot perform. They are NOT deleted or disabled here: silently failing forever is
		 * the bug, but a trigger the user wrote is theirs to remove. Surfacing it as broken — in
		 * the same sentence the save path would have refused it with — leaves the decision where
		 * it belongs while ending the pretence that the row is healthy.
		 */
		unavailable,
		lastRunAt: trigger.last_run_at,
		nextRunAt: trigger.next_run_at,
		/**
		 * The un-jittered slot `nextRunAt` was derived from (#412).
		 *
		 * Exposed because the two-runs-a-night bug was invisible from the outside: `nextRunAt`
		 * alone is a jittered time, and a jittered time cannot be checked against a schedule —
		 * "23:36 for an @daily trigger" is either a −24m jitter or a broken interval and the
		 * field does not say which. With the slot beside it, "did this advance by one period"
		 * is a question the API can answer. NULL on webhook triggers and on cron rows that have
		 * not swept since migration 0100.
		 */
		nextSlotAt: trigger.next_slot_at,
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

/** The keys this config actually carries — see the note at the update route's `stored`. */
function definedOnly(config: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
}

/**
 * Refuse an action this instance's agent cannot perform (#358).
 *
 * SERVER-side deliberately, and not in the console: there are three equal doors onto this
 * surface — the console, this API, and the MCP tool `create_instance_trigger` (which posts here)
 * — so a picker-only fix would leave two of them open.
 */
async function assertActionPossible(env: Env, userId: string, instanceId: string, action: TriggerAction): Promise<void> {
	const caps = await capabilitiesForInstance(env, instanceId, userId).catch(() => null);
	const denial = triggerActionDenial(action, caps);
	if (denial) throw new HttpError(400, denial);
}

/**
 * Capabilities for every instance these triggers point at, in ONE query.
 *
 * The listing spans instances (`GET /v1/triggers` with no `instanceId` returns the whole
 * account), and resolving them one at a time would be a request per row.
 */
async function capabilitiesForTriggers(env: Env, userId: string, triggers: readonly TriggerRow[]): Promise<Map<string, AgentCapabilities>> {
	const ids = [...new Set(triggers.map((t) => t.instance_id))];
	const out = new Map<string, AgentCapabilities>();
	if (!ids.length) return out;
	const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
	const { results } = await env.DB.prepare(
		`SELECT i.id AS instance_id, a.slug AS slug, a.category AS category, a.config AS config
       FROM agent_instances i JOIN agents a ON a.id = i.agent_id
      WHERE i.user_id = ?1 AND i.id IN (${placeholders})`,
	)
		.bind(userId, ...ids)
		.all<{ instance_id: string; slug: string | null; category: string | null; config: string | null }>()
		.catch(() => ({ results: [] as Array<{ instance_id: string; slug: string | null; category: string | null; config: string | null }> }));
	for (const row of results ?? []) out.set(row.instance_id, agentCapabilities(row, env));
	return out;
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
	const session = await requireUser(c);
	const body = await c.req.json<{ instanceId?: string; type?: string; action?: string; schedule?: string; config?: Record<string, unknown>; count?: number }>().catch(() => ({}) as Record<string, never>);
	const type: TriggerType = body.type === "cron" ? "cron" : "webhook";
	let action: TriggerAction = "create_task";
	try {
		action = assertTriggerAction(body.action || "create_task");
	} catch {
		// An unknown action is the caller's bug, not something to 500 over — validate what we can.
	}
	const issues = validateTriggerConfig(action, type, body.config);
	// #358: an action this agent cannot perform is exactly the kind of thing the preview exists
	// to say — "it would be stored and then never work" is the same class as "it would be stored
	// and then ignored". Only when an instance is named, since the check is per-agent.
	if (body.instanceId) {
		const instanceId = body.instanceId.trim();
		await requireOwnedInstance(c.env, session.uid, instanceId);
		const caps = await capabilitiesForInstance(c.env, instanceId, session.uid).catch(() => null);
		const denial = triggerActionDenial(action, caps);
		if (denial) issues.push(denial);
	}
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
	const caps = await capabilitiesForTriggers(c.env, session.uid, results ?? []);
	return c.json({
		triggers: (results ?? []).map((t) =>
			presentTrigger(t, origin, triggerActionDenial(t.action, caps.get(t.instance_id) ?? null)),
		),
	});
});

/**
 * GET /v1/triggers/actions?instanceId=… — the action vocabulary, annotated for one instance.
 *
 * The console's picker renders from THIS rather than from a hardcoded label list, which is what
 * let it offer "Run browser task" on 25 agents that would refuse it. Unavailable actions come
 * back with `available:false` and the reason, so the picker can disable the option and say why
 * instead of quietly having fewer entries on some agents than others.
 */
triggerRoutes.get("/actions", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.query("instanceId")?.trim();
	if (!instanceId) throw new HttpError(400, "instanceId required");
	await requireOwnedInstance(c.env, session.uid, instanceId);
	const caps = await capabilitiesForInstance(c.env, instanceId, session.uid).catch(() => null);
	return c.json({ actions: triggerActionOffers(caps) });
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
	await assertActionPossible(c.env, session.uid, instance.id, action);
	assertValidConfig(action, type, body.config);
	const schedule = type === "cron" ? normalizeSchedule(body.schedule) : null;
	const timezone = typeof body.config?.timezone === "string" ? body.config.timezone : undefined;
	// A create anchors the schedule at now — there is no prior slot to advance from — and stores
	// BOTH halves, so the very first run already has the un-jittered slot to step from (#412).
	const advance = schedule
		? advanceCron(schedule, { now: new Date(), timeZone: timezone, jitterMinutes: typeof body.config?.jitterMinutes === "number" ? body.config.jitterMinutes : undefined })
		: null;
	const secret = type === "webhook" ? makeTriggerSecret() : null;
	const id = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO agent_triggers
       (id, user_id, agent_id, instance_id, name, type, action, enabled, secret_token, schedule, config, next_run_at, next_slot_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, datetime('now'), datetime('now'))`,
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
			advance?.fire ?? null,
			advance?.slot ?? null,
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
	// Only when the action is being CHANGED. An update that renames a trigger, or disables one,
	// must keep working on a row that is already impossible — otherwise the only way to tidy up
	// after this gate lands is to delete, which is a worse answer than "turn it off".
	if (body.action !== undefined && body.action !== trigger.action) {
		await assertActionPossible(c.env, session.uid, trigger.instance_id, action);
	}
	// Validate against the config that will END UP stored under the action that will end up set —
	// an update that only changes `action` can strand config that was valid for the old one.
	//
	// `definedOnly` is load-bearing, not tidying. `parseConfig` builds a MAPPED type: it emits all
	// 21 vocabulary keys and leaves the ones this row does not set as `undefined`. But
	// `validateTriggerConfig` counts key PRESENCE, so the stored config of a `create_task` trigger
	// read back as fifteen wrong-action fields and EVERY update that did not resend `config` — a
	// rename, a disable, and the `{enabled:true}` this ticket is about — was rejected 400 before it
	// reached any of the logic below. A key holding `undefined` is not a field the user set, and the
	// row cannot be repaired by a message telling them to remove fields they never wrote.
	const stored = definedOnly(parseConfig(trigger.config) as Record<string, unknown>);
	const effectiveConfig = body.config === undefined ? stored : body.config;
	assertValidConfig(action, trigger.type, effectiveConfig);
	let schedule = trigger.schedule;
	let next = trigger.next_run_at;
	let nextSlot = trigger.next_slot_at;
	const timezone = typeof effectiveConfig.timezone === "string" ? effectiveConfig.timezone : undefined;
	const zoneChanged = body.config !== undefined && timezone !== (typeof stored.timezone === "string" ? stored.timezone : undefined);
	const wasEnabled = trigger.enabled === 1;
	const willBeEnabled = body.enabled === undefined ? wasEnabled : body.enabled;
	let lastError = trigger.last_error;
	if (trigger.type === "cron") {
		schedule = body.schedule === undefined ? trigger.schedule : normalizeSchedule(body.schedule);
		// Keyed on a REAL change, not on the field being present (#665). The old condition was
		// `body.schedule !== undefined`, so a save that re-sent the same expression re-anchored the
		// row at now and re-rolled its jitter — a console that PUTs the whole trigger on every edit
		// walked the next fire time forward each time the user touched the name. That accident was
		// also the ONLY recovery from the bug below, which is why it has to be replaced and not
		// merely narrowed.
		const scheduleChanged = schedule !== trigger.schedule;
		// The row is (or is becoming) enabled and has no anchor, so it can never be swept (#665).
		//
		// `runDueTriggers` selects `enabled = 1 AND next_run_at IS NOT NULL`, and the auto-disable
		// that fires on an invalid schedule clears `enabled`, `next_run_at` AND `next_slot_at`
		// together. Re-enabling only restored `enabled`: the row then read as ON in every listing
		// and could never be selected again — no error, no surfaced `last_error`, nothing in the
		// console to look at. The disabling statement's scope and the re-enabling statement's scope
		// have to match, and the reader's `next_run_at IS NOT NULL` is doing real work (it is what
		// keeps webhook rows and un-anchored rows out of the cron sweep), so the fix belongs here.
		const unanchored = willBeEnabled && !trigger.next_run_at;
		if (scheduleChanged || zoneChanged || unanchored) {
			const jm = typeof effectiveConfig.jitterMinutes === "number" ? effectiveConfig.jitterMinutes : undefined;
			// Changing the ZONE changes when the same expression fires, so the stored next_run_at is
			// stale the moment it changes. Not recomputing here would leave the trigger firing on the
			// old zone until its next run — and the console would show a next-run time that is wrong.
			//
			// Re-anchored at now with NO prior slot (#412): the old slot belongs to the old schedule
			// or the old zone, so advancing from it would carry the previous meaning forward. Both
			// halves are rewritten together — a slot from one schedule beside a fire time from another
			// is the split-state this ticket exists to remove.
			//
			// `advanceCron` re-validates through `normalizeSchedule`, which throws HttpError(400). On
			// the re-enable path that is the point: a row auto-disabled because its schedule is no
			// longer valid under the current grammar refuses the re-enable, naming the grammar's own
			// reason, instead of being re-armed into a row the sweep will disable again next minute.
			const advance = schedule ? advanceCron(schedule, { now: new Date(), timeZone: timezone, jitterMinutes: jm }) : null;
			next = advance ? advance.fire : next;
			nextSlot = advance ? advance.slot : nextSlot;
		}
	}
	// Cleared on the OFF → ON transition, and only there (#665). `last_error` is the record of why
	// this trigger stopped, not a diagnosis of what it is now: the auto-disable writes
	// "Disabled: schedule … is no longer valid" in the same statement that clears `enabled`, and no
	// statement anywhere ever cleared it again. So a trigger the owner had repaired and switched
	// back on displayed a permanent error it could not shed. Turning it on is the owner asserting
	// the condition is addressed — and for a cron that assertion is CHECKED, because the re-anchor
	// above 400s if it is not. `failure_count` is deliberately left alone: the history of how often
	// this row has failed is not the owner's to reset by flipping a switch, and the failures are
	// still in `agent_trigger_events` either way.
	if (!wasEnabled && willBeEnabled) lastError = null;
	const secret = trigger.type === "webhook" && body.rotateSecret === true ? makeTriggerSecret() : trigger.secret_token;
	await c.env.DB.prepare(
		`UPDATE agent_triggers
     SET name = ?2, action = ?3, enabled = ?4, secret_token = ?5, schedule = ?6, config = ?7, next_run_at = ?8, next_slot_at = ?10,
         last_error = ?11, updated_at = datetime('now')
     WHERE id = ?1 AND user_id = ?9`,
	)
		.bind(
			trigger.id,
			name,
			action,
			willBeEnabled ? 1 : 0,
			secret,
			schedule,
			body.config === undefined ? trigger.config : safeJson(body.config),
			next,
			session.uid,
			nextSlot,
			lastError,
		)
		.run();
	const updated = await requireOwnedTrigger(c.env, session.uid, trigger.id);
	const caps = await capabilitiesForInstance(c.env, updated.instance_id, session.uid).catch(() => null);
	return c.json({ trigger: presentTrigger(updated, publicOrigin(c.req.url), triggerActionDenial(updated.action, caps)) });
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
	const trigger = await requireRunnableTrigger(c.env, session.uid, c.req.param("id"));
	const payload = await c.req.json().catch(() => ({}));
	await dispatchTrigger(c.env, trigger, "manual", payload);
	return c.json({ success: true });
});

/**
 * Public unauthenticated webhook endpoint. The token is a high-entropy capability URL.
 *
 * Gated on the instance's status in the same statement that finds the trigger (#649). This is the
 * path where cancellation mattered most: the token is a bearer capability that outlives the
 * subscription, so anyone who was ever given the URL — a third-party SaaS, a Zap, a pasted curl —
 * kept running the agent's action after the owner cancelled it, from outside the platform, with no
 * console surface left to reach the trigger and switch it off.
 *
 * Filtered in SQL so the answer is indistinguishable from a bad token: a 404 either way tells the
 * caller nothing about whether an instance exists or what became of it.
 */
triggerRoutes.post("/webhook/:token", async (c) => {
	const token = c.req.param("token");
	const trigger = await c.env.DB.prepare(
		`SELECT t.* FROM agent_triggers t
       JOIN agent_instances i ON i.id = t.instance_id
     WHERE t.secret_token = ?1 AND t.type = 'webhook' AND ${activeInstanceSql("i")}`,
	)
		.bind(token)
		.first<TriggerRow>();
	if (trigger?.enabled !== 1) throw new HttpError(404, "Webhook trigger not found");
	await recordTriggerEvent(c.env, trigger, "webhook", "received");
	const contentType = c.req.header("content-type") || "";
	const payload = contentType.includes("application/json") ? await c.req.json().catch(() => ({})) : { text: await c.req.text() };
	await dispatchTrigger(c.env, trigger, "webhook", payload);
	return c.json({ ok: true }, 202 as ContentfulStatusCode);
});
