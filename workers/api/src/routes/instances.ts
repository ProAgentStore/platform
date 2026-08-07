import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { createRepo, listRepos } from "../lib/coding-store.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { applySettingsPatch, resolveSettingsValues } from "../lib/instance-settings.js";
import { parseAccountPreferences, resolveVoice, sanitizeVoiceSettings, unknownVoiceField, type VoiceSettings } from "../lib/preferences.js";
import { resumeSessionsForNode, suspendSessionsFromOtherNodes } from "../lib/coding-store.js";
import { createNotification } from "./notifications.js";
import { listEvents } from "../lib/events.js";
import { validatePipeline } from "../lib/pipeline.js";
import { readInstanceConfig, registerApplyRoutes } from "./instances-apply.js";
import { registerBehaviourRoutes } from "./instances-behaviour.js";
import { registerBrowseRoutes } from "./instances-browse.js";
import { registerChatRoutes } from "./instances-chat.js";
import { registerKnowledgeRoutes } from "./instances-knowledge.js";
import { registerTaskRoutes } from "./instances-tasks.js";
import { registerTranslationRoutes } from "./instances-translation.js";
import { registerFileUploadRoutes } from "./instances-files.js";
import { instanceCapFor, isEntitled, isPaywallEnforced, requirePro } from "../lib/billing.js";
import { relayConnected } from "../lib/runner-client.js";
import type { Env } from "../types.js";
import {
	callRuntime,
	encodeRuntimeToken,
	expireOrphanedRuntimeTasks,
	getRuntime,
	listRuntimeNodes,
	isRecord,
	normalizeRunnerNode,
	requireOwnedInstance,
	requireRuntime,
	getLiveRuntime,
	runtimeNodeResponse,
	runtimeResponse,
	safeCapabilities,
	updateRuntimeStatus,
	UPSERT_INSTANCE_RUNTIME_NODE_SQL,
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
	normalizeRunnerNode,
	runtimeEventsFromPayload,
	runtimeTasksFromPayload,
	UPSERT_INSTANCE_RUNTIME_NODE_SQL,
	UPSERT_INSTANCE_RUNTIME_SQL,
	validateRuntimeEndpointUrl,
} from "./instances-runtime.js";
import { parseBoundRunnerNode } from "../lib/runtime-nodes.js";
import { diagnoseAttachment } from "../lib/runtime-attachment.js";
import { patchInstanceConfig, removeInstanceConfigKey } from "../lib/instance-config.js";

export const instanceRoutes = new Hono<{ Bindings: Env }>();

/**
 * The pipelines an agent DECLARES as defaults (agents.config.pipelines), for copying into a
 * new subscriber's instance config. Each definition is validated with the same
 * `validatePipeline` the runner uses, so a template with a broken def hands its subscribers
 * the working ones rather than a config the runner will reject later. Exported for tests.
 */
export function defaultPipelinesFor(agentConfig: string | null): Record<string, unknown> {
	if (!agentConfig) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(agentConfig);
	} catch {
		return {};
	}
	const declared = isRecord(parsed) && isRecord(parsed.pipelines) ? parsed.pipelines : null;
	if (!declared) return {};
	const out: Record<string, unknown> = {};
	for (const [name, def] of Object.entries(declared)) {
		if (validatePipeline(def) === null) out[name] = def;
	}
	return out;
}

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

	// Cap total instances per user: paid platform users are effectively unlimited for now.
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
			cap === 0 ? 402 : 429,
			cap === 0
				? "ProAgentStore billing is not enabled yet."
				: "Subscription limit reached. Cancel one to add another.",
		);

	const instanceId = crypto.randomUUID();

	// Create instance row. Second+ instances of the same agent get a numbered
	// display name (stored in config.displayName; user-renameable).
	//
	// An agent may also DECLARE default pipelines (agents.config.pipelines). For an agent
	// whose whole behaviour IS its pipelines, those have to arrive with the subscription —
	// loadPipeline reads the INSTANCE config, so without this a fresh subscriber gets an
	// agent that can do nothing until they attach each pipeline by hand. Copied (not
	// referenced) so the subscriber owns their copy and can edit it, which is the same
	// template→instance rule the KB and identity already follow. Invalid defs are dropped
	// rather than poisoning the instance config.
	const initial: Record<string, unknown> = nth > 1 ? { displayName: `${agent.name} ${nth}` } : {};
	const declaredPipelines = defaultPipelinesFor(agent.config);
	if (Object.keys(declaredPipelines).length) initial.pipelines = declaredPipelines;
	const initialConfig = JSON.stringify(initial);
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

/**
 * List my subscribed instances.
 *
 * Canceled instances are excluded by default (#67). `POST /:id/cancel` was the only
 * non-destructive way to retire a duplicate, but this list returned canceled rows
 * anyway — so a canceled instance kept showing in the console nav, kept being offered
 * to MCP's `findInstanceForAgent`, and kept being registered by `pags up`. Cancelling
 * therefore cancelled nothing the user could see, which is why dogfood duplicates
 * accumulated. `?includeCanceled=1` still returns them, so nothing is stranded.
 */
instanceRoutes.get("/my/instances", async (c) => {
	const session = await requireUser(c);
	const includeCanceled = ["1", "true", "yes"].includes((c.req.query("includeCanceled") ?? "").toLowerCase());
	const { results } = await c.env.DB.prepare(
		`SELECT i.id, i.agent_id, i.status, i.created_at, i.config AS instance_config,
            a.name, a.slug, a.description, a.category, a.icon, a.icon_bg, a.config
     FROM agent_instances i
     JOIN agents a ON a.id = i.agent_id
     WHERE i.user_id = ?1${includeCanceled ? "" : " AND i.status != 'canceled'"}
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
			// env carries the fail-closed custom-surface gate (#186) — this is the one response the
			// console renders tabs from, so it is the path that must consult it.
			capabilities: agentCapabilities({ slug: r.slug as string, category: r.category as string, config: config as string }, c.env),
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
	const runnerNode = normalizeRunnerNode(body.runnerNode);

	// Multi-machine Coder: each machine registers as an addressable node. The legacy
	// instance_runtimes row is still updated as the default runtime for browser/apply
	// features and older clients, but Coder sessions route by their stored runner_node.
	const prevRuntime = await getRuntime(c.env, instanceId, session.uid);
	if (runnerNode) {
		// `--force` takeover: this machine claims the instance. Park sessions still marked active
		// on OTHER machines (the previous one, disconnected without ever clearing its status) so
		// they don't (a) block this machine's sessions via the one-active-per-repo index or (b)
		// leave the Coding tab dead-ending on an offline node. History is preserved (suspended,
		// not ended); the old machine's sessions resume if it reconnects. This wires up the
		// documented takeover contract — the suspend half was previously never called.
		if (body.force) {
			const suspended = await suspendSessionsFromOtherNodes(c.env, instanceId, session.uid, runnerNode).catch(() => 0);
			if (suspended) console.log(`Suspended ${suspended} session(s) from other machines (force takeover of ${runnerNode})`);
		}
		const resumed = await resumeSessionsForNode(c.env, instanceId, session.uid, runnerNode).catch(() => 0);
		if (resumed) console.log(`Resumed ${resumed} suspended session(s) on ${runnerNode}`);
	}

	if (runnerNode) {
		await c.env.DB.prepare(UPSERT_INSTANCE_RUNTIME_NODE_SQL)
			.bind(
				instanceId,
				session.uid,
				runnerNode,
				placement,
				endpointUrl,
				tokenParts.ciphertext,
				tokenParts.dekWrapped,
				tokenParts.iv,
				tokenParts.plaintext,
				capabilities,
				runnerVersion,
			)
			.run();
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

	// A replacement default runner can't own tasks paused on the previous default,
	// but adding another Coder node should not expire work on other machines.
	if (!runnerNode || !prevRuntime?.runner_node || prevRuntime.runner_node === runnerNode) {
		await expireOrphanedRuntimeTasks(c.env, instanceId, session.uid).catch(() => undefined);
	}

	// Read back to confirm (or just return success if readback fails)
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	const nodes = runnerNode ? await listRuntimeNodes(c.env, instanceId, session.uid).catch(() => []) : [];
	return c.json({
		runtime: runtime ? runtimeResponse(runtime) : { instanceId, endpointUrl, placement, status: "registered" },
		nodes: nodes.map(runtimeNodeResponse),
	}, 201);
});

/** Read my registered runtime without exposing its token. */
instanceRoutes.get("/:instanceId/runtime", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	const nodes = await listRuntimeNodes(c.env, instanceId, session.uid).catch(() => []);
	return c.json({ runtime: runtime ? runtimeResponse(runtime) : null, nodes: nodes.map(runtimeNodeResponse) });
});

/**
 * Node binding: which machine this instance runs on. A platform primitive — ANY
 * agent (not just Coder) can be pinned to a specific connected node, and its runner
 * calls (chat tools, apply, coding defaults) route there. GET returns the current
 * pin + the nodes currently available to pin to.
 */
instanceRoutes.get("/:instanceId/runner-node", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const cfgRow = await c.env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, session.uid)
		.first<{ config: string | null }>();
	const runnerNode = parseBoundRunnerNode(cfgRow?.config);
	const nodes = await listRuntimeNodes(c.env, instanceId, session.uid).catch(() => []);
	// Distinct node names known for this instance (each registration = one machine).
	const available = [...new Set(nodes.map((n) => normalizeRunnerNode(n.runner_node)).filter(Boolean))];

	// Machine-level liveness: which of the user's machines are running a runner AT ALL
	// (any of their instances holds a live relay socket) — the same node-level truth the
	// Terminals page shows. This lets the picker distinguish "machine offline" from
	// "machine online but THIS agent isn't attached to it" (its `pags up` was started
	// before this agent, so it never opened this instance's socket).
	const allNodeRows = await c.env.DB.prepare(
		"SELECT DISTINCT instance_id, runner_node FROM instance_runtime_nodes WHERE user_id = ?1",
	).bind(session.uid).all<{ instance_id: string; runner_node: string }>();
	const idsByNode = new Map<string, string[]>();
	for (const r of allNodeRows.results ?? []) {
		const nn = normalizeRunnerNode(r.runner_node);
		if (!nn) continue;
		(idsByNode.get(nn) ?? idsByNode.set(nn, []).get(nn)!).push(r.instance_id);
	}
	const nodeMachineOnline = async (node: string): Promise<boolean> => {
		const ids = (idsByNode.get(node) ?? []).slice(0, 25);
		const checks = await Promise.all(ids.map((id) => relayConnected(c.env, id, node).catch(() => false)));
		return checks.some(Boolean);
	};

	// Report both flags per node: `connected` = THIS agent's own socket; `nodeOnline` =
	// the machine is up for any agent. Include the pinned node even if this agent never
	// registered on it, so the picker can label it correctly.
	const detailNodes = [...new Set([...available, ...(runnerNode ? [runnerNode] : [])])];
	const nodesDetail = await Promise.all(
		detailNodes.slice(0, 25).map(async (node) => {
			const connected = await relayConnected(c.env, instanceId, node).catch(() => false);
			return { node, connected, nodeOnline: connected ? true : await nodeMachineOnline(node) };
		}),
	);
	return c.json({ runnerNode: runnerNode || null, nodes: available, nodesDetail });
});

/** Pin (or clear, with an empty/null value) the node this instance runs on. */
instanceRoutes.put("/:instanceId/runner-node", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { runnerNode?: unknown };
	const node = normalizeRunnerNode(body.runnerNode);
	// Read-merge-write the instance config so we never clobber sibling fields.
	const row = await c.env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, session.uid)
		.first<{ config: string | null }>();
	let cfg: Record<string, unknown> = {};
	try { cfg = JSON.parse(row?.config || "{}") as Record<string, unknown>; } catch { cfg = {}; }
	// Patch just this key (#231) — pinning a runner must not clobber a Settings or behaviour
	// change saved from another tab between the read and the write.
	if (node) await patchInstanceConfig(c.env, instanceId, session.uid, "runnerNode", node);
	else await removeInstanceConfigKey(c.env, instanceId, session.uid, "runnerNode");
	return c.json({ runnerNode: node || null });
});

/** Heartbeat from user/CLI after checking the browser runtime is online. */
instanceRoutes.post("/:instanceId/runtime/heartbeat", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await requireRuntime(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { runnerNode?: unknown };
	await updateRuntimeStatus(c.env, instanceId, session.uid, "online", normalizeRunnerNode(body.runnerNode));
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
	const { effective, hasOverride } = await effectiveVoice(c.env, instanceId, session.uid, cfg);
	// Still `voiceSettings`, still the fully-resolved object: `getVoiceConfig` in
	// packages/sdk/src/voice/config.ts reads exactly that key, so the SDK, the console chat and
	// coder-web all keep working unchanged while resolution moves server-side.
	return c.json({ voiceSettings: effective, hasOverride });
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

/**
 * Resolve what this agent ACTUALLY uses: account defaults, then this instance's override if it has
 * one, then a declared `voiceLanguage` setting on top of the language.
 *
 * `hasOverride` is presence, not value equality — an override whose fields happen to match your
 * defaults is still an override, and the console's "Using your defaults / Customise" control has to
 * show what the user chose, not what the numbers came out as.
 */
async function effectiveVoice(
	env: Env,
	instanceId: string,
	userId: string,
	cfg: Record<string, unknown>,
): Promise<{ effective: VoiceSettings; hasOverride: boolean }> {
	const row = await env.DB.prepare("SELECT preferences FROM users WHERE id = ?1")
		.bind(userId)
		.first<{ preferences: string | null }>();
	const account = parseAccountPreferences(row?.preferences);
	const override = cfg.voiceSettings;
	const hasOverride = override !== undefined && override !== null;
	// The declared language (Language Buddy's `target_language`) read LIVE from the agent's schema
	// + this instance's settings — never from a stored copy, which is what used to go stale.
	const schema = await settingsSchemaForInstance(env, instanceId, userId).catch(() => []);
	const values = resolveSettingsValues(schema, cfg.settings as Record<string, unknown> | undefined);
	const declared = schema.find((f) => f.voiceLanguage);
	const declaredLanguage = declared && typeof values[declared.id] === "string" ? String(values[declared.id]) : undefined;
	return { effective: resolveVoice(account.voice, hasOverride ? override : undefined, declaredLanguage), hasOverride };
}

/**
 * Write a per-agent voice override. Sanitized against the ACCOUNT default, so a partial body keeps
 * the rest of your preferences instead of snapping unspecified fields back to platform defaults.
 */
instanceRoutes.put("/:instanceId/voice-settings", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
	// Strict on write: a caller asking for a provider we don't know must be told, not quietly
	// given "browser". The sanitizer stays lenient because it also parses stored rows.
	const bad = unknownVoiceField(body);
	if (bad) throw new HttpError(400, bad);
	const row = await c.env.DB.prepare("SELECT preferences FROM users WHERE id = ?1")
		.bind(session.uid)
		.first<{ preferences: string | null }>();
	const account = parseAccountPreferences(row?.preferences);
	const settings = sanitizeVoiceSettings(body, account.voice);
	await patchInstanceConfig(c.env, instanceId, session.uid, "voiceSettings", settings);
	// Resolve against the config AS WRITTEN, not the copy read beforehand. The patch now goes
	// straight to SQL without mutating a local blob, so resolving off the pre-write read would
	// echo the OLD override back — the panel would show your previous speed after saving a new one.
	const { effective } = await effectiveVoice(c.env, instanceId, session.uid, { voiceSettings: settings });
	return c.json({ voiceSettings: effective, hasOverride: true });
});

/** "Use my defaults" — drop the override entirely. Absence is what the resolver reads. */
instanceRoutes.delete("/:instanceId/voice-settings", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await removeInstanceConfigKey(c.env, instanceId, session.uid, "voiceSettings");
	// Resolve against an EMPTY override — that is the state just written, and "use my defaults"
	// must report the account default, not the override it has just deleted.
	const { effective } = await effectiveVoice(c.env, instanceId, session.uid, {});
	return c.json({ voiceSettings: effective, hasOverride: false });
});

/** Rename this instance (per-instance display name — distinguishes multiple
 *  instances of the same agent on the dashboard). Empty name = back to the agent's. */
instanceRoutes.put("/:instanceId/name", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
	const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
	const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
	if (name) await patchInstanceConfig(c.env, instanceId, session.uid, "displayName", name);
	else await removeInstanceConfigKey(c.env, instanceId, session.uid, "displayName");
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
	// A field declared `voiceLanguage: true` is NOT copied into voiceSettings any more (#211).
	// Writing it here made a stored duplicate of a declared value: change the setting and the old
	// language lingered until something re-saved, and — now that presence of `voiceSettings` marks
	// an agent as "customised" — merely picking a language would have silently flipped the agent
	// off your account defaults. `resolveVoice` applies it live from the declared setting instead.
	//
	// Patching just `$.settings` (#231) also means a settings save can no longer clobber
	// `voiceSettings` itself, which sits in the same blob and is written by a different route.
	await patchInstanceConfig(c.env, instanceId, session.uid, "settings", result.settings);

	// A `repo` setting on a coding agent should MEAN something. Before this it was prompt
	// context only: you told the agent which repo it owned, and it still had no repo attached,
	// so a delegated goal was refused with "no repository yet" and the owner had to add the
	// same path a second time on the Coding tab. Attach it here, once, when it is first named.
	// Idempotent by workdir, and never touches an instance that already has repos — the Coding
	// tab stays the place to manage several.
	// `result.settings`, not `cfg.settings`: the local blob is no longer mutated before the
	// write (the patch goes straight to SQL), so reading it back here would serve the values
	// from BEFORE the save — a settings page that shows your old choice, and a repo that never
	// attaches on the turn you first name it.
	await attachSettingRepo(c.env, instanceId, session.uid, result.settings).catch(() => undefined);

	return c.json({ settings: resolveSettingsValues(schema, result.settings) });
});

/**
 * Attach the repo named in an agent's typed settings, if it has none yet.
 *
 * Deliberately conservative: only for an agent whose declared runtime is coding, only when the
 * instance has NO repos, and only for a value that looks like a path or owner/name. Anything
 * more eager would fight the Coding tab rather than complement it.
 */
async function attachSettingRepo(env: Env, instanceId: string, userId: string, settings: unknown): Promise<void> {
	const value = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).repo : null);
	const spec = typeof value === "string" ? value.trim() : "";
	if (!spec || spec.length > 400) return;

	const row = await env.DB.prepare(
		"SELECT a.slug AS slug, a.category AS category, a.config AS config FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<{ slug: string; category: string; config: string | null }>();
	if (!row || agentCapabilities(row as never).runtime !== "coding") return;

	const existing = await listRepos(env, instanceId, userId);
	if (existing.length) return;

	const isLocalPath = spec.startsWith("~") || spec.startsWith("/") || spec.startsWith(".");
	const isOwnerRepo = /^[\w.-]+\/[\w.-]+$/.test(spec);
	const isUrl = /^(https?:\/\/|git@)/.test(spec);
	if (!isLocalPath && !isOwnerRepo && !isUrl) return;

	const name = isLocalPath ? spec.split("/").filter(Boolean).slice(-2).join("/") : spec.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
	await createRepo(env, instanceId, userId, {
		name: name || spec,
		workdir: isLocalPath ? spec : undefined,
		githubRepo: isOwnerRepo ? spec : undefined,
		cloneUrl: isUrl ? spec : undefined,
	});
}

/** Probe a registered runtime's health and capabilities through PAGS. */
instanceRoutes.get("/:instanceId/runtime/status", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	// Resolve the LIVE, pin-aware node first (#238). `requireRuntime` reads the single default
	// row, which the newest `pags up` overwrites and which is never cleared on disconnect — so
	// on a multi-machine account this route reported a machine that had gone away, and then
	// asked relayConnected about THAT node. The dot the user sees was derived from a row that
	// had no relationship to what is actually connected. Fall back to the default row only to
	// describe a registration that exists but is not live.
	const liveRuntime = await getLiveRuntime(c.env, instanceId, session.uid);
	const runtime = liveRuntime ?? (await requireRuntime(c.env, instanceId, session.uid));

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
		const relayIsConnected = await relayConnected(c.env, instanceId, runtime.runner_node);
		// Say WHY when it isn't attached (#237). The console previously had only a boolean, so a
		// machine that is demonstrably alive with one agent detached rendered as an unexplained
		// amber dot — the CLI knew the reason and the remedy and printed both to a terminal
		// nobody was watching.
		const attachment = diagnoseAttachment({
			hasRuntimeRow: true,
			relayConnected: relayIsConnected,
			lastSeenAt: runtime.last_seen_at,
		});
		return c.json({
			runtime: runtimeResponse({ ...runtime, status: effective, last_seen_at: new Date().toISOString() }),
			health,
			capabilities,
			relay: { connected: relayIsConnected, runnerNode: runtime.runner_node || null, live: Boolean(liveRuntime) },
			attachment,
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
registerBehaviourRoutes(instanceRoutes);
registerBrowseRoutes(instanceRoutes);
registerTranslationRoutes(instanceRoutes);
registerFileUploadRoutes(instanceRoutes);

/** Remove my registered runtime. */
instanceRoutes.delete("/:instanceId/runtime", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runnerNode = normalizeRunnerNode(c.req.query("node"));
	if (runnerNode) {
		await c.env.DB.prepare(
			"DELETE FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3",
		)
			.bind(instanceId, session.uid, runnerNode)
			.run();
		return c.json({ success: true });
	}
	await c.env.DB.prepare(
		"DELETE FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.run();
	await c.env.DB.prepare(
		"DELETE FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.run();
	return c.json({ success: true });
});

/**
 * The board/ticket surface, the conversation and the instance knowledge base are registered from
 * sibling modules (#305) — and deliberately from HERE, the positions their route blocks occupied,
 * rather than gathered with the five calls above. Hono matches in registration order, so moving a
 * block past a sibling pattern is a behaviour change even when the route SET is unchanged; keeping
 * the calls in place is what makes the resolved surface identical to the file they came out of.
 * `instances.contract.test.ts` pins the ordered table, so this cannot be tidied by accident.
 */
registerTaskRoutes(instanceRoutes);
registerChatRoutes(instanceRoutes);
registerKnowledgeRoutes(instanceRoutes);

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
