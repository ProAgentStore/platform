import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import { runUserWorkersAi } from "../lib/user-ai.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { applySettingsPatch, resolveSettingsValues } from "../lib/instance-settings.js";
import { buildInstanceBoard, setBoardItemStatus, clearFinishedBoardItems, columnsForInstance } from "../lib/board.js";
import { deriveJobPassword, listAtsCache } from "../lib/apply-cache.js";
import { findCredentialForHost } from "../lib/credentials.js";
import { getProfile, profileToCandidate, profileToPreferences } from "../lib/profile.js";
import { suspendSessionsFromOtherNodes, resumeSessionsForNode } from "../lib/coding-store.js";
import { createNotification } from "./notifications.js";
import { logEvent, listEvents } from "../lib/events.js";
import { parseLoopDecision } from "../lib/loop-decide.js";
import { readInstanceConfig, registerApplyRoutes } from "./instances-apply.js";
import { attachGlossesToMessages, registerTranslationRoutes } from "./instances-translation.js";
import { instanceCapFor, isEntitled, isPaywallEnforced, requirePro } from "../lib/billing.js";
import type { Env } from "../types.js";
import {
	callRuntime,
	cloudflareAiSetupTask,
	cloudflareAiSetupTaskId,
	clearFinishedRuntimeTasks,
	deleteMirroredRuntimeTask,
	encodeRuntimeToken,
	runtimeSetupTask,
	runtimeSetupTaskId,
	expireOrphanedRuntimeTasks,
	getRuntime,
	isCloudflareAiCredentialsError,
	isRecord,
	mirrorRuntimeTask,
	mirrorRuntimeEvents,
	mirrorRuntimeTasks,
	mirrorSyntheticTaskEvent,
	mirrorTaskLifecycleEvents,
	mirroredRuntimeEvents,
	mirroredRuntimeTask,
	mirroredRuntimeTasks,
	normalizeRunnerTaskBody,
	requireOwnedInstance,
	requireRuntime,
	runtimeErrorPayload,
	runtimeJson,
	runtimeResponse,
	runtimeStatus,
	safeCapabilities,
	syntheticEventsFromTasks,
	updateRuntimeStatus,
	UPSERT_INSTANCE_RUNTIME_SQL,
	validateRuntimeEndpointUrl,
	type InstanceRow,
	type RuntimeRegistrationBody,
} from "./instances-runtime.js";

export {
	cloudflareAiSetupTask,
	cloudflareAiSetupTaskId,
	runtimeSetupTask,
	runtimeSetupTaskId,
	isCloudflareAiCredentialsError,
	normalizeRunnerTaskBody,
	runtimeEventsFromPayload,
	runtimeTasksFromPayload,
	UPSERT_INSTANCE_RUNTIME_SQL,
	validateRuntimeEndpointUrl,
} from "./instances-runtime.js";

export const instanceRoutes = new Hono<{ Bindings: Env }>();

/** Subscribe to an agent — creates a personal instance with its own DO. */
instanceRoutes.post("/:agentId/subscribe", async (c) => {
	const session = await requireUser(c);
	const agentId = c.req.param("agentId");

	// Verify agent exists and is published
	const agent = await c.env.DB.prepare(
		`SELECT id, name, model, visibility, config FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
	)
		.bind(agentId)
		.first<{ id: string; name: string; model: string; config: string | null }>();
	if (!agent) throw new HttpError(404, "Agent not found or not published");

	// Multiple instances of the same agent are allowed (e.g. two Doc Chat libraries
	// with different documents). Later ones get a numbered display name so they're
	// distinguishable on the dashboard; rename via PUT /:instanceId/name.
	const sameAgent = await c.env.DB.prepare(
		"SELECT COUNT(*) AS n FROM agent_instances WHERE agent_id = ?1 AND user_id = ?2",
	)
		.bind(agent.id, session.uid)
		.first<{ n: number }>();
	const nth = (sameAgent?.n ?? 0) + 1;

	// Cap total instances per user: free tier 2, Pro the 100 fair-use cap (which also
	// bounds resource-exhaustion / notification-spam abuse — subscribe is expensive:
	// template DO fetch + instance DO init + KB copy + creator notification).
	const count = await c.env.DB.prepare(
		"SELECT COUNT(*) AS n FROM agent_instances WHERE user_id = ?1",
	)
		.bind(session.uid)
		.first<{ n: number }>();
	const enforced = isPaywallEnforced(c.env);
	const entitled = enforced ? await isEntitled(c.env, session) : true;
	const cap = instanceCapFor(entitled, enforced);
	if ((count?.n ?? 0) >= cap)
		throw new HttpError(
			429,
			cap === 2
				? "Free plan limit reached (2 agents). Upgrade to Pro ($9/mo) for up to 100."
				: "Subscription limit reached (100 agents). Cancel one to add another.",
		);

	const instanceId = crypto.randomUUID();

	// Create instance row. Second+ instances of the same agent get a numbered
	// display name (stored in config.displayName; user-renameable).
	const initialConfig = nth > 1 ? JSON.stringify({ displayName: `${agent.name} ${nth}` }) : "{}";
	await c.env.DB.prepare(
		`INSERT INTO agent_instances (id, agent_id, user_id, status, config, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'active', ?4, datetime('now'), datetime('now'))`,
	)
		.bind(instanceId, agent.id, session.uid, initialConfig)
		.run();

	// Upsert the subscription relationship row — it's UNIQUE(agent_id, user_id) and
	// per-(user, agent), not per-instance: a second instance of the same agent
	// reuses (and reactivates) it. The old one-instance-per-agent 409 masked this.
	await c.env.DB.prepare(
		`INSERT INTO subscriptions (id, user_id, agent_id, status, started_at)
     VALUES (?1, ?2, ?3, 'active', datetime('now'))
     ON CONFLICT(agent_id, user_id) DO UPDATE SET status = 'active', canceled_at = NULL`,
	)
		.bind(crypto.randomUUID(), session.uid, agent.id)
		.run();

	// Initialize the instance's DO — copy template state from the agent's DO
	const templateDoId = c.env.AGENT.idFromName(agent.id);
	const templateStub = c.env.AGENT.get(templateDoId);
	const stateRes = await templateStub.fetch(new Request("https://agent/state"));
	const templateState = (await stateRes.json()) as Record<string, unknown>;

	// First-party agents seeded straight into the catalog have no initialized
	// template DO, so their identity (personality/goal/guardrails) lives in the
	// agents.config.identity blob. Use it as the fallback when the template DO is
	// uninitialized; a real creator's template DO state always wins.
	const templateInited = Boolean(templateState.name) && !templateState.error;
	let identity: Record<string, unknown> = {};
	if (!templateInited && agent.config) {
		try {
			identity = ((JSON.parse(agent.config) as Record<string, unknown>).identity as Record<string, unknown>) || {};
		} catch {
			identity = {};
		}
	}

	// Initialize instance DO with template config
	const instanceDoId = c.env.AGENT.idFromName(instanceId);
	const instanceStub = c.env.AGENT.get(instanceDoId);
	await instanceStub.fetch(
		new Request("https://agent/init", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: instanceId,
				name: templateState.name || agent.name,
				personality: templateState.personality || identity.personality || "",
				goal: templateState.goal || identity.goal || "",
				model: templateState.model || agent.model,
				guardrails: templateState.guardrails || identity.guardrails || {},
				welcomeMessage: templateState.welcomeMessage || identity.welcomeMessage || "",
			}),
		}),
	);

	// Copy knowledge base from template to instance
	const kbRes = await templateStub.fetch(new Request("https://agent/knowledge"));
	const kbData = (await kbRes.json()) as {
		documents?: Array<{
			title: string;
			content: string;
			source: string;
			sourceUrl?: string;
		}>;
	};
	if (kbData.documents?.length) {
		for (const doc of kbData.documents) {
			await instanceStub.fetch(
				new Request("https://agent/knowledge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(doc),
				}),
			);
		}
	}

	// Track subscription event for analytics
	await c.env.DB.prepare(
		`INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'subscribe', '{}', datetime('now'))`,
	).bind(crypto.randomUUID(), agent.id, session.uid).run();

	// Notify the agent creator
	const creator = await c.env.DB.prepare(
		"SELECT owner_id FROM agents WHERE id = ?1",
	).bind(agent.id).first<{ owner_id: string }>();
	if (creator && creator.owner_id !== session.uid) {
		const subscriber = await c.env.DB.prepare(
			"SELECT github_login FROM users WHERE id = ?1",
		).bind(session.uid).first<{ github_login: string }>();
		await createNotification(
			c.env.DB, creator.owner_id, "subscribe",
			`New subscriber: ${subscriber?.github_login || "someone"}`,
			`${subscriber?.github_login || "A user"} subscribed to ${agent.name}.`,
			agent.id,
		);
	}

	return c.json({ instanceId, agentId: agent.id, status: "active" }, 201);
});

/** List my subscribed instances. */
instanceRoutes.get("/my/instances", async (c) => {
	const session = await requireUser(c);
	const { results } = await c.env.DB.prepare(
		`SELECT i.id, i.agent_id, i.status, i.created_at, i.config AS instance_config,
            a.name, a.slug, a.description, a.category, a.icon, a.icon_bg, a.config
     FROM agent_instances i
     JOIN agents a ON a.id = i.agent_id
     WHERE i.user_id = ?1
     ORDER BY i.updated_at DESC`,
	)
		.bind(session.uid)
		.all<Record<string, unknown>>();
	// Attach the resolved capability descriptor so the console renders surfaces
	// from a declared registry, not by branching on agent slug/category. `config`
	// (which may hold secrets/internal settings) is dropped from the response.
	const instances = (results ?? []).map((r) => {
		const { config, instance_config, ...rest } = r;
		// A user-set (or auto-numbered) per-instance display name overrides the agent
		// name — how two instances of the same agent stay distinguishable.
		let displayName: string | undefined;
		try {
			const cfg = instance_config ? (JSON.parse(instance_config as string) as Record<string, unknown>) : {};
			if (typeof cfg.displayName === "string" && cfg.displayName.trim()) displayName = cfg.displayName.trim();
		} catch { /* malformed config — keep the agent name */ }
		return {
			...rest,
			...(displayName ? { name: displayName, agentName: r.name } : {}),
			capabilities: agentCapabilities({ slug: r.slug as string, category: r.category as string, config: config as string }),
		};
	});
	return c.json({ instances });
});

/** Register or update the local/managed runtime for my instance. */
instanceRoutes.post("/:instanceId/runtime", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	// The local runner (`pags up`) is a Pro feature — fail loudly at registration.
	await requirePro(c.env, session);

	const body = await c.req.json<RuntimeRegistrationBody & { force?: boolean }>();
	const endpointUrl = validateRuntimeEndpointUrl(body.endpointUrl);
	const tokenParts = await encodeRuntimeToken(c.env, body.token);
	const capabilities = JSON.stringify(safeCapabilities(body.capabilities));
	const placement = body.placement === "managed" ? "managed" : "local";
	const runnerVersion = String(body.runnerVersion || "").slice(0, 80);
	const runnerNode = String(body.runnerNode || "").slice(0, 120);

	// Reject if a different machine is already connected (unless --force)
	if (!body.force && runnerNode) {
		const existing = await getRuntime(c.env, instanceId, session.uid);
		if (existing && existing.runner_node && existing.runner_node !== runnerNode && existing.status !== "offline") {
			const lastSeen = existing.last_seen_at ? Date.parse(`${existing.last_seen_at.replace(" ", "T")}Z`) : 0;
			const stale = lastSeen > 0 && Date.now() - lastSeen > 120_000; // 2 min without heartbeat = stale
			if (!stale) {
				return c.json({
					error: `Another machine is connected: ${existing.runner_node}. Disconnect it first, or use --force to take over.`,
					connectedNode: existing.runner_node,
					lastSeenAt: existing.last_seen_at,
				}, 409);
			}
		}
	}

	// Machine-switch session lifecycle, driven by per-session OWNERSHIP (runner_node) rather
	// than the last-registered node (the old comparison never matched on the reconnect path,
	// so resume was dead and sessions stranded 'suspended' forever):
	// - On a real node change → suspend sessions owned by the OTHER (departing) machine.
	// - Always → resume THIS machine's OWN suspended sessions (index-safe, per-repo where free).
	const prevRuntime = await getRuntime(c.env, instanceId, session.uid);
	if (runnerNode) {
		const nodeChanged = !!prevRuntime?.runner_node && prevRuntime.runner_node !== runnerNode;
		if (nodeChanged) {
			const suspended = await suspendSessionsFromOtherNodes(c.env, instanceId, session.uid, runnerNode).catch(() => 0);
			if (suspended) console.log(`Suspended ${suspended} session(s) from ${prevRuntime?.runner_node} → ${runnerNode}`);
		}
		const resumed = await resumeSessionsForNode(c.env, instanceId, session.uid, runnerNode).catch(() => 0);
		if (resumed) console.log(`Resumed ${resumed} suspended session(s) on ${runnerNode}`);
	}

	await c.env.DB.prepare(UPSERT_INSTANCE_RUNTIME_SQL)
		.bind(
			instanceId,
			session.uid,
			placement,
			endpointUrl,
			tokenParts.ciphertext,
			tokenParts.dekWrapped,
			tokenParts.iv,
			tokenParts.plaintext,
			capabilities,
			runnerVersion,
			runnerNode,
		)
		.run();

	// A fresh runner session can't own tasks paused on the previous one — expire
	// them so the board doesn't keep stale "Needs you" cards after a restart.
	await expireOrphanedRuntimeTasks(c.env, instanceId, session.uid).catch(() => undefined);

	// Read back to confirm (or just return success if readback fails)
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	return c.json({
		runtime: runtime ? runtimeResponse(runtime) : { instanceId, endpointUrl, placement, status: "registered" },
	}, 201);
});

/** Read my registered runtime without exposing its token. */
instanceRoutes.get("/:instanceId/runtime", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	return c.json({ runtime: runtime ? runtimeResponse(runtime) : null });
});

/** Heartbeat from user/CLI after checking the browser runtime is online. */
instanceRoutes.post("/:instanceId/runtime/heartbeat", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await requireRuntime(c.env, instanceId, session.uid);
	await updateRuntimeStatus(c.env, instanceId, session.uid, "online");
	return c.json({ success: true, status: "online" });
});

/** R2 key for a voice turn's saved audio (owner-scoped path). */
const voiceAudioKey = (userId: string, instanceId: string, turnId: string) =>
	`voice-audio/${userId}/${instanceId}/${turnId}`;
const cleanTurnId = (raw: string) => raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

/** Save a voice turn's raw audio so it can be replayed later (double-tap the message). */
instanceRoutes.put("/:instanceId/voice-audio/:turnId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const turnId = cleanTurnId(c.req.param("turnId"));
	if (!turnId) return c.json({ error: "bad turnId" }, 400);
	const body = await c.req.arrayBuffer();
	if (!body.byteLength) return c.json({ error: "empty audio" }, 400);
	if (body.byteLength > 5 * 1024 * 1024) return c.json({ error: "audio too large (max 5MB)" }, 400);
	const contentType = c.req.header("content-type") || "audio/webm";
	await c.env.STORAGE.put(voiceAudioKey(session.uid, instanceId, turnId), body, {
		httpMetadata: { contentType },
	});
	return c.json({ ok: true, turnId });
});

/** Fetch a saved voice turn's audio (owner-only) — the console plays it on replay. */
instanceRoutes.get("/:instanceId/voice-audio/:turnId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const turnId = cleanTurnId(c.req.param("turnId"));
	const obj = await c.env.STORAGE.get(voiceAudioKey(session.uid, instanceId, turnId));
	if (!obj) return c.json({ error: "not found" }, 404);
	return new Response(obj.body, {
		headers: {
			"Content-Type": obj.httpMetadata?.contentType || "audio/webm",
			"Cache-Control": "private, max-age=31536000",
		},
	});
});

/** Read voice settings for hands-off mode. */
instanceRoutes.get("/:instanceId/voice-settings", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
	return c.json({ voiceSettings: cfg.voiceSettings || { provider: "browser" } });
});

/**
 * Unified run trace — the complete time-ordered timeline of what this agent DID
 * (chat turns, tool calls, apply steps/handoffs/outcomes, and bridged failures),
 * so a run can be reconstructed and debugged from one place. Filter by `trace_id`
 * (one run/turn), `source`, or `level`; `limit` caps how many recent events.
 */
instanceRoutes.get("/:instanceId/trace", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const level = c.req.query("level");
	const events = await listEvents(c.env, {
		userId: session.uid,
		instanceId,
		traceId: c.req.query("trace_id") || c.req.query("traceId") || undefined,
		source: c.req.query("source") || undefined,
		level: level === "debug" || level === "info" || level === "warn" || level === "error" ? level : undefined,
		limit: Number(c.req.query("limit")) || 200,
	});
	return c.json({ instanceId, count: events.length, events });
});

/** Update voice settings for hands-off mode. */
instanceRoutes.put("/:instanceId/voice-settings", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = await c.req.json<Record<string, unknown>>();
	const provider = String(body.provider || "browser");
	if (!["browser", "openai-realtime", "gemini-live"].includes(provider)) {
		throw new HttpError(400, "provider must be browser, openai-realtime, or gemini-live");
	}
	const speed = typeof body.speed === "number" ? Math.max(50, Math.min(200, Math.round(body.speed))) : 100;
	// Conversation mode: ms of silence after you stop talking before the message is
	// sent. Higher = more tolerant of mid-sentence pauses.
	const silenceMs = typeof body.silenceMs === "number" ? Math.max(500, Math.min(6000, Math.round(body.silenceMs))) : 1500;
	// Speech recognition: "browser" dictation (default) or "openai" Whisper (AI).
	const sttMode = body.sttMode === "openai" ? "openai" : "browser";
	// Mic sensitivity for Whisper silence detection (0.4–2): higher = more sensitive
	// (quiet mics); lower = needs louder speech (noisy environments).
	const sensitivity = typeof body.sensitivity === "number" ? Math.max(0.4, Math.min(2, body.sensitivity)) : 1;
	const settings = {
		provider,
		speed,
		silenceMs,
		sttMode,
		sensitivity,
		openai: body.openai && typeof body.openai === "object" ? body.openai : undefined,
		gemini: body.gemini && typeof body.gemini === "object" ? body.gemini : undefined,
		language: typeof body.language === "string" ? body.language.slice(0, 10) : "en-US",
		// Hands-free voice commands (e.g. "repeat") — on unless explicitly disabled.
		commandsEnabled: body.commandsEnabled !== false,
	};
	const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
	cfg.voiceSettings = settings;
	await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
		.bind(JSON.stringify(cfg), instanceId, session.uid)
		.run();
	return c.json({ voiceSettings: settings });
});

/** Rename this instance (per-instance display name — distinguishes multiple
 *  instances of the same agent on the dashboard). Empty name = back to the agent's. */
instanceRoutes.put("/:instanceId/name", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
	const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
	const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
	if (name) cfg.displayName = name;
	else delete cfg.displayName;
	await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
		.bind(JSON.stringify(cfg), instanceId, session.uid)
		.run();
	return c.json({ name: name || null });
});

/** Resolve the agent's declared settings schema for an OWNED instance (404 if not yours). */
async function settingsSchemaForInstance(env: Env, instanceId: string, userId: string) {
	const row = await env.DB.prepare(
		`SELECT a.slug, a.category, a.config FROM agent_instances i
		 JOIN agents a ON a.id = i.agent_id
		 WHERE i.id = ?1 AND i.user_id = ?2`,
	)
		.bind(instanceId, userId)
		.first<{ slug: string | null; category: string | null; config: string | null }>();
	if (!row) throw new HttpError(404, "Instance not found");
	return agentCapabilities(row).settingsSchema ?? [];
}

/** Read this instance's typed agent settings (values merged over schema defaults).
 *  `fields` is included so the Settings tab never depends on a stale instance cache. */
instanceRoutes.get("/:instanceId/settings", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const schema = await settingsSchemaForInstance(c.env, instanceId, session.uid);
	const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
	return c.json({ settings: resolveSettingsValues(schema, cfg.settings), fields: schema });
});

/** Save typed agent settings (patch semantics — only sent fields change). A field
 *  declared `voiceLanguage: true` also updates the instance's voice-settings
 *  language, so STT/TTS follow the chosen language automatically. */
instanceRoutes.put("/:instanceId/settings", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const schema = await settingsSchemaForInstance(c.env, instanceId, session.uid);
	if (!schema.length) throw new HttpError(400, "This agent has no settings");
	const body = (await c.req.json().catch(() => ({}))) as { settings?: unknown };
	const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
	const result = applySettingsPatch(schema, cfg.settings, body.settings);
	cfg.settings = result.settings;
	if (result.voiceLanguageValue) {
		const voice = (cfg.voiceSettings && typeof cfg.voiceSettings === "object" ? cfg.voiceSettings : { provider: "browser" }) as Record<string, unknown>;
		voice.language = result.voiceLanguageValue.slice(0, 10);
		cfg.voiceSettings = voice;
	}
	await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
		.bind(JSON.stringify(cfg), instanceId, session.uid)
		.run();
	return c.json({ settings: resolveSettingsValues(schema, cfg.settings) });
});

/** Probe a registered runtime's health and capabilities through PAGS. */
instanceRoutes.get("/:instanceId/runtime/status", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);

	// A runner heartbeats every 30s (updateRuntimeStatus → "online"). If it was seen
	// in the last ~90s it's live, so a transient live-probe failure (the tunnel URL
	// just rotated on a `pags up` restart, a momentary blip) must NOT flip it offline:
	// getRunnerConn gates work on status != 'offline', so a destructive probe would
	// knock out coding/apply and flash "not connected" while the runner is actually fine.
	const lastSeenMs = runtime.last_seen_at ? Date.parse(`${runtime.last_seen_at.replace(" ", "T")}Z`) : 0;
	const recentlySeen = lastSeenMs > 0 && Date.now() - lastSeenMs < 90_000;

	try {
		const [healthRes, capabilitiesRes] = await Promise.all([
			callRuntime(c.env, runtime, "/health"),
			callRuntime(c.env, runtime, "/capabilities"),
		]);
		const health = await healthRes.json().catch(() => ({}));
		const capabilities = await capabilitiesRes.json().catch(() => ({}));
		const online = healthRes.ok && capabilitiesRes.ok;
		// Persist offline only when the probe fails AND the heartbeat has gone stale.
		const effective = online || recentlySeen ? "online" : "offline";
		await updateRuntimeStatus(c.env, instanceId, session.uid, effective);
		// Check relay status (is runner connected via WebSocket?)
		let relayConnected = false;
		if (c.env.RELAY) {
			try {
				const stub = c.env.RELAY.get(c.env.RELAY.idFromName(instanceId));
				const relayRes = await stub.fetch(new Request("https://relay/status"));
				const relayData = await relayRes.json().catch(() => ({})) as { connected?: boolean };
				relayConnected = relayData.connected === true;
			} catch { /* relay probe failed */ }
		}
		return c.json({
			runtime: runtimeResponse({ ...runtime, status: effective, last_seen_at: new Date().toISOString() }),
			health,
			capabilities,
			relay: { connected: relayConnected },
		});
	} catch (error) {
		// Probe threw (network blip). A recently-seen runner stays online — don't clobber it.
		if (recentlySeen) {
			return c.json({ runtime: runtimeResponse({ ...runtime, status: "online" }), transient: true });
		}
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		return c.json({
			runtime: runtimeResponse({ ...runtime, status: "offline" }),
			error: error instanceof Error ? error.message : String(error),
		}, 502);
	}
});

// ── Human takeover relay (console ⇄ PAGS ⇄ runner, through the tunnel) ──────

// Human-takeover proxies, Special Instructions, learned tips, and the ask-and-hold
// input channel live in instances-apply.ts to keep this file focused.
registerApplyRoutes(instanceRoutes);
registerTranslationRoutes(instanceRoutes);

/** Remove my registered runtime. */
instanceRoutes.delete("/:instanceId/runtime", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await c.env.DB.prepare(
		"DELETE FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.run();
	return c.json({ success: true });
});

/** List tasks on my registered runtime. */
instanceRoutes.get("/:instanceId/tasks", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	if (!runtime) {
		const tasks = await mirroredRuntimeTasks(c.env, instanceId, session.uid);
		const hasRuntimeSetupTask = tasks.some(
			(task) => isRecord(task) && task.id === runtimeSetupTaskId(instanceId),
		);
		if (!hasRuntimeSetupTask) tasks.unshift(runtimeSetupTask(instanceId));
		return c.json({
			tasks,
			runtimeUnavailable: true,
			error: "Runtime not registered",
		});
	}
	// Stale-while-revalidate (best practice on Workers + D1): serve the durable D1
	// MIRROR immediately — it's fast, persists across sessions, and survives a flaky
	// runner tunnel, so the board never blanks on a network blip. Refresh the mirror
	// from the runner in the BACKGROUND for the next poll; the console polls every few
	// seconds, so it converges within one tick. (Returning the mirror — not the raw
	// runner list — also keeps cleared/deleted tasks (hidden=1) off the board even
	// though the runner still re-sends them.) This replaces blocking the board on a
	// live runner round-trip, which went blank whenever the tunnel was slow.
	// Same recentlySeen guard as the /runtime/status probe: a heartbeat within
	// 90s means the runner is alive, so a transient /tasks failure must NOT flip
	// it offline — that would knock out getRunnerConn for coding/apply and flash
	// "not connected" while the runner is actually fine.
	const lastSeenMs = runtime.last_seen_at ? Date.parse(`${runtime.last_seen_at.replace(" ", "T")}Z`) : 0;
	const recentlySeen = lastSeenMs > 0 && Date.now() - lastSeenMs < 90_000;
	const revalidate = (async () => {
		try {
			const res = await callRuntime(c.env, runtime, "/tasks");
			if (res.ok) {
				await mirrorRuntimeTasks(c.env, instanceId, session.uid, await runtimeJson(res));
				await updateRuntimeStatus(c.env, instanceId, session.uid, "online");
			} else if (!recentlySeen) {
				await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
			}
		} catch {
			if (!recentlySeen) {
				await updateRuntimeStatus(c.env, instanceId, session.uid, "offline").catch(() => undefined);
			}
		}
	})();
	try { c.executionCtx.waitUntil(revalidate); } catch { await revalidate; }
	return c.json({ tasks: await mirroredRuntimeTasks(c.env, instanceId, session.uid) }, 200);
});

/**
 * The single work board: one card per job (task retries collapsed), placed in the
 * agent's configured columns, with the durable human status override applied.
 * Read straight from the D1 mirror — the /tasks poll keeps it fresh. Shared by the
 * console board and the MCP `instance_board` tool so they can't drift.
 */
instanceRoutes.get("/:instanceId/board", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json(await buildInstanceBoard(c.env, instanceId, session.uid));
});

/** Move a job to a column (human status override); empty status resets to automation. */
instanceRoutes.post("/:instanceId/board/status", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const jobKey = (typeof body.jobKey === "string" ? body.jobKey : "").slice(0, 400);
	if (!jobKey) return c.json({ error: "jobKey required" }, 400);
	const status = typeof body.status === "string" ? body.status.trim() : "";
	// Validate a move against the agent's actual columns — reject an unknown status
	// instead of silently parking the card in "Other". Empty = reset to automation.
	if (status) {
		const cols = await columnsForInstance(c.env, instanceId, session.uid);
		const valid = new Set<string>();
		for (const col of cols) { valid.add(col.id); for (const s of col.statuses ?? []) valid.add(s); }
		if (!valid.has(status)) return c.json({ error: `unknown board status: ${status}` }, 400);
	}
	// Snapshot the display fields so a moved card survives its runs being cleared.
	const meta = {
		title: typeof body.title === "string" ? body.title : "",
		subtitle: typeof body.subtitle === "string" ? body.subtitle : "",
		url: typeof body.url === "string" ? body.url : "",
	};
	await setBoardItemStatus(c.env, instanceId, session.uid, jobKey, status || null, meta);
	return c.json({ ok: true });
});

/** Create a task on my registered runtime. */
instanceRoutes.post("/:instanceId/tasks", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const body = normalizeRunnerTaskBody(await c.req.json());
	const res = await callRuntime(c.env, runtime, "/tasks", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const payload = await runtimeJson(res);
	if (res.ok) {
		await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
		await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "created");
	}
	return c.json(payload, runtimeStatus(res, 202));
});

/**
 * Start the remote LLM brain on a job application. Kicks off the JobApplyWorkflow
 * which drives the connected runner page-by-page (snapshot → Claude → act),
 * handing off to a human only for a CAPTCHA. Returns the workflow instance id.
 */
/** Read a task from my registered runtime. */
instanceRoutes.get("/:instanceId/tasks/:taskId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const taskId = c.req.param("taskId");
	try {
		const res = await callRuntime(c.env, runtime, `/tasks/${encodeURIComponent(taskId)}`);
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
			return c.json(payload, 200);
		}
		const mirrored = await mirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
		if (mirrored) return c.json({ ...(isRecord(mirrored) ? mirrored : {}), runtimeUnavailable: true });
		return c.json(payload, runtimeStatus(res, 200));
	} catch (error) {
		const mirrored = await mirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
		if (mirrored) return c.json({ ...(isRecord(mirrored) ? mirrored : {}), runtimeUnavailable: true });
		throw error;
	}
});

/** Approve a task waiting on local human approval. */
instanceRoutes.post("/:instanceId/tasks/:taskId/approve", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const res = await callRuntime(
		c.env,
		runtime,
		`/tasks/${encodeURIComponent(c.req.param("taskId"))}/approve`,
		{ method: "POST" },
	);
	const payload = await runtimeJson(res);
	if (res.ok) {
		await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
		await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "approved");
	}
	return c.json(payload, runtimeStatus(res, 200));
});

/** Cancel a runtime task. */
/** Send free-text guidance to a paused/stuck agent's brain (read on resume). */
instanceRoutes.post("/:instanceId/tasks/:taskId/hint", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const taskId = c.req.param("taskId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const hint = String(body.hint ?? "").trim().slice(0, 2000);
	if (!hint) return c.json({ error: "hint required" }, 400);
	await c.env.DB.prepare("UPDATE instance_runtime_tasks SET user_hint = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4")
		.bind(hint, taskId, instanceId, session.uid)
		.run();
	return c.json({ ok: true });
});

/** Clear all finished (failed/done/cancelled) tasks from the board. */
instanceRoutes.post("/:instanceId/tasks/clear-finished", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const cleared = await clearFinishedRuntimeTasks(c.env, instanceId, session.uid);
	await clearFinishedBoardItems(c.env, instanceId, session.uid);
	return c.json({ ok: true, cleared });
});

/** Delete a ticket: stop the runner task (best-effort) + drop it from the board. */
instanceRoutes.delete("/:instanceId/tasks/:taskId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const taskId = c.req.param("taskId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	if (runtime?.endpoint_url) {
		await callRuntime(c.env, runtime, `/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).catch(() => undefined);
	}
	await deleteMirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
	return c.json({ ok: true });
});

instanceRoutes.post("/:instanceId/tasks/:taskId/cancel", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const res = await callRuntime(
		c.env,
		runtime,
		`/tasks/${encodeURIComponent(c.req.param("taskId"))}/cancel`,
		{ method: "POST" },
	);
	const payload = await runtimeJson(res);
	if (res.ok) {
		await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
		await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "cancelled");
	}
	return c.json(payload, runtimeStatus(res, 200));
});

/** Read recent task events from my registered runtime. */
instanceRoutes.get("/:instanceId/task-events", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const rawLimit = Number(c.req.query("limit") || "100");
	const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.trunc(rawLimit))) : 100;
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	if (!runtime) {
		const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
		const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
		return c.json({
			events: events.length ? events : syntheticEventsFromTasks(tasks.length ? tasks : [runtimeSetupTask(instanceId)]),
			runtimeUnavailable: true,
			error: "Runtime not registered",
		});
	}
	// Stale-while-revalidate (same as /tasks): serve the D1 mirror immediately so the
	// activity feed never blanks/lags on a flaky tunnel; refresh from the runner in the
	// background. Falls back to events synthesised from tasks when there's no history.
	const lastSeenMs2 = runtime.last_seen_at ? Date.parse(`${runtime.last_seen_at.replace(" ", "T")}Z`) : 0;
	const recentlySeen2 = lastSeenMs2 > 0 && Date.now() - lastSeenMs2 < 90_000;
	const revalidate = (async () => {
		try {
			const res = await callRuntime(c.env, runtime, `/events?limit=${encodeURIComponent(String(limit))}`);
			if (res.ok) await mirrorRuntimeEvents(c.env, instanceId, session.uid, await runtimeJson(res));
			else if (!recentlySeen2) await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		} catch {
			if (!recentlySeen2) {
				await updateRuntimeStatus(c.env, instanceId, session.uid, "offline").catch(() => undefined);
			}
		}
	})();
	try { c.executionCtx.waitUntil(revalidate); } catch { await revalidate; }
	const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
	const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
	return c.json({ events: events.length ? events : syntheticEventsFromTasks(tasks) }, 200);
});

/** Chat with my instance of an agent. */
instanceRoutes.post("/:instanceId/chat", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const { message, audioKey } = await c.req.json<{ message: string; audioKey?: string }>();
	if (!message) throw new HttpError(400, "message required");

	// Verify ownership
	const instance = await c.env.DB.prepare(
		"SELECT id, agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first<InstanceRow>();
	if (!instance) throw new HttpError(404, "Instance not found");

	const doId = c.env.AGENT.idFromName(instanceId);
	const stub = c.env.AGENT.get(doId);
	// Pass agentId/agentName for auto-init if DO has no state
	const agentMeta = await c.env.DB.prepare(
		"SELECT name FROM agents WHERE id = ?1",
	).bind(instance.agent_id).first<{ name: string }>();

	const doRes = await stub.fetch(
		new Request("https://agent/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message, channel: "chat", userId: session.uid,
				agentId: instanceId, agentName: agentMeta?.name || "Agent",
				audioKey,
			}),
		}),
	);

	// Track usage
	await c.env.DB.prepare(
		`INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'instance_chat', ?4, datetime('now'))`,
	)
		.bind(
			crypto.randomUUID(),
			instance.agent_id,
			session.uid,
			JSON.stringify({ instanceId }),
		)
		.run();

	const data = await doRes.json();
	if (doRes.ok) {
		// Trace the turn (in → tools → out) grouped by one turn id so agent_trace
		// shows what the agent was asked, which tools it ran, and what it replied.
		const turnId = crypto.randomUUID();
		const reply = isRecord(data) && isRecord(data.message) ? String(data.message.content ?? "") : "";
		const tools = isRecord(data) && isRecord(data.toolMessage) ? String(data.toolMessage.content ?? "") : "";
		const now = Date.now();
		await logEvent(c.env, { source: "chat", event: "chat.in", message: message.slice(0, 200), userId: session.uid, instanceId, traceId: turnId, ts: now });
		if (tools) await logEvent(c.env, { source: "chat", event: "tool.call", message: tools.replace(/\s+/g, " ").slice(0, 200), userId: session.uid, instanceId, traceId: turnId, ts: now + 1 });
		await logEvent(c.env, { source: "chat", event: "chat.out", message: reply.replace(/\s+/g, " ").slice(0, 200), userId: session.uid, instanceId, traceId: turnId, ts: now + 2 });
		await deleteMirroredRuntimeTask(
			c.env,
			instanceId,
			session.uid,
			cloudflareAiSetupTaskId(instanceId),
		);
	} else if (
		isRecord(data) &&
		isCloudflareAiCredentialsError(data.error)
	) {
		const task = cloudflareAiSetupTask(instanceId, String(data.error));
		await mirrorRuntimeTask(c.env, instanceId, session.uid, task);
		await mirrorSyntheticTaskEvent(
			c.env,
			instanceId,
			session.uid,
			task,
			"setup.blocked",
			task.updatedAt,
			{ provider: "cloudflare" },
		);
	}
	return c.json(data, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
});

/** Loop orchestrator — BYOK Claude decides next action for an autonomous loop. */
instanceRoutes.post("/:instanceId/loop-decide", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	).bind(instanceId, session.uid).first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const { objective, messages, iteration, maxIterations } = await c.req.json<{
		objective: string;
		messages: { role: string; content: string }[];
		iteration: number;
		maxIterations: number;
	}>();
	if (!objective) throw new HttpError(400, "objective required");
	if (typeof objective !== "string" || objective.length > 2000) throw new HttpError(400, "objective too long");
	if (!Array.isArray(messages)) throw new HttpError(400, "messages must be an array");
	if (messages.length > 20) throw new HttpError(400, "too many messages");
	const safeIteration = Math.max(0, Math.min(50, Number(iteration) || 0));
	const safeMaxIterations = Math.max(1, Math.min(50, Number(maxIterations) || 10));

	const systemPrompt = `You are a loop orchestrator. You are on iteration ${safeIteration}/${safeMaxIterations}.

Read the user's objective and the conversation so far, then decide ONE of:
- CONTINUE: the objective is not yet met. Write the next instruction to give the agent.
- DONE: the objective is fully met. No more work needed.
- ESCALATE: the agent is stuck, pushing back, asking questions, or needs human help.
- FAILED: something went wrong or the agent keeps repeating itself.

Reply ONLY with JSON: { "decision": "continue"|"done"|"escalate"|"failed", "nextInstruction": "...", "reason": "..." }`;

	// Objective and messages go in the user turn, not interpolated into the system prompt
	const conversationText = (messages || [])
		.slice(-6)
		.map((m) => `${m.role}: ${(m.content || "").slice(0, 2000)}`)
		.join("\n\n");
	const userContent = `OBJECTIVE: ${(objective || "").slice(0, 500)}\n\nCONVERSATION:\n${conversationText || "(no messages yet)"}`;

	try {
		const res = (await runUserWorkersAi(c.env, session.uid, "claude-sonnet-4-6", {
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userContent },
			],
			maxTokens: 300,
		})) as { response?: string };

		// Robust parse: handles ```fences```, trailing prose, an example object first, or a
		// pure-prose reply — instead of dead-ending the loop on anything but clean JSON.
		return c.json(parseLoopDecision(res.response || ""));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("API key") || msg.includes("credentials")) {
			throw new HttpError(402, "No API key configured. Add one in Profile → API Keys.");
		}
		throw e;
	}
});

/** Persist a system/status message to the instance chat history. */
instanceRoutes.post("/:instanceId/system-message", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	).bind(instanceId, session.uid).first();
	if (!instance) throw new HttpError(404, "Instance not found");
	const { content } = await c.req.json<{ content: string }>();
	if (!content) throw new HttpError(400, "content required");
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	await stub.fetch(new Request("https://agent/system-message", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content }),
	}));
	return c.json({ ok: true });
});

/** Get messages for my instance. */
instanceRoutes.get("/:instanceId/messages", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const rawLimit = Number(c.req.query("limit") || "50");
	const limit = Math.max(1, Math.min(2000, Number.isFinite(rawLimit) ? rawLimit : 50));
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request(`https://agent/messages?limit=${limit}`),
	);
	const payload = (await doRes.json()) as { messages?: Array<Record<string, unknown>> };
	// Cached glosses ride along so translated history renders in the same paint —
	// see instances-translation.ts.
	await attachGlossesToMessages(c.env, instanceId, session.uid, payload.messages || []);
	return c.json(payload);
});

/** Add knowledge to my instance (client's own docs). */
instanceRoutes.post("/:instanceId/knowledge", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(
		await doRes.json(),
		(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
	);
});

/** Delete a doc from my instance's knowledge base. */
instanceRoutes.delete("/:instanceId/knowledge/:docId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const docId = c.req.param("docId");
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request(`https://agent/knowledge/${encodeURIComponent(docId)}`, { method: "DELETE" }),
	);
	return c.json(await doRes.json());
});

/** Read one document's full content (console viewer/editor). */
instanceRoutes.get("/:instanceId/knowledge/:docId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(new Request(`https://agent/knowledge/${encodeURIComponent(c.req.param("docId"))}`));
	return c.json(await doRes.json(), doRes.status as ContentfulStatusCode);
});

/** Edit a document's title/content (console editor). */
instanceRoutes.put("/:instanceId/knowledge/:docId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(new Request(`https://agent/knowledge/${encodeURIComponent(c.req.param("docId"))}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	}));
	return c.json(await doRes.json(), doRes.status as ContentfulStatusCode);
});

/** Import URL into my instance's knowledge base. */
instanceRoutes.post("/:instanceId/knowledge/ingest-url", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge/ingest-url", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(
		await doRes.json(),
		(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
	);
});

/** Get my instance's knowledge base. */
instanceRoutes.get("/:instanceId/knowledge", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(new Request("https://agent/knowledge"));
	return c.json(await doRes.json());
});

/** Cancel subscription / deactivate instance. */
instanceRoutes.post("/:instanceId/cancel", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id, agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first<InstanceRow>();
	if (!instance) throw new HttpError(404, "Instance not found");

	await c.env.DB.batch([
		c.env.DB.prepare(
			`UPDATE agent_instances SET status = 'canceled', updated_at = datetime('now') WHERE id = ?1`,
		).bind(instanceId),
		c.env.DB.prepare(
			`UPDATE subscriptions SET status = 'canceled', canceled_at = datetime('now')
       WHERE agent_id = ?1 AND user_id = ?2 AND status = 'active'`,
		).bind(instance.agent_id, session.uid),
	]);

	return c.json({ success: true });
});

/** Trim a value to a non-empty string, or undefined. */
function optionalStr(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

