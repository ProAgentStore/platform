import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { applySettingsPatch, resolveSettingsValues } from "../lib/instance-settings.js";
import { overrideVoiceBase, parseAccountPreferences, resolveVoice, sanitizeVoiceSettings, unknownVoiceField, type VoiceSettings } from "../lib/preferences.js";
import { deriveVoiceVocabulary } from "../lib/voice-vocabulary.js";
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
import { registerConnectorBindingRoutes } from "./instances-terminal.js";
import { registerDeployStatusRoutes } from "./instances-deploy.js";
import { instanceCapFor, isEntitled, isPaywallEnforced, requirePro } from "../lib/billing.js";
import { liveAliasForPin, liveNodeIgnoringPin, relayConnected } from "../lib/runner-client.js";
import type { Env } from "../types.js";
import {
	callRuntime,
	claimMachineNames,
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
import { foldNodesByMachine, normalizeMachineId, sanitizeMachineNames } from "../lib/machine-identity.js";
import { parseBoundRunnerNode } from "../lib/runtime-nodes.js";
import { diagnoseAttachment } from "../lib/runtime-attachment.js";
import { instanceListView, patchInstanceConfig, removeInstanceConfigKey } from "../lib/instance-config.js";
import { setRunnerNodePin } from "../lib/runner-node-pin.js";

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

/**
 * A per-instance display name as it is stored — trimmed, capped at 60. ONE expression, shared by
 * subscribe and `PUT /:instanceId/name`: both now write that key for the same reason, and a second
 * copy of "what a name is" would drift.
 */
function displayNameFrom(raw: unknown): string {
	return typeof raw === "string" ? raw.trim().slice(0, 60) : "";
}

/** Subscribe to an agent — creates a personal instance with its own DO.
 *  Optional body `{ displayName }`: the name the subscriber CHOSE for this one (#450). */
instanceRoutes.post("/:agentId/subscribe", async (c) => {
	const session = await requireUser(c);
	const agentId = c.req.param("agentId");
	const body = (await c.req.json().catch(() => ({}))) as { displayName?: unknown };
	const chosenName = displayNameFrom(body.displayName);

	// Verify agent exists and is published
	const agent = await c.env.DB.prepare(
		`SELECT id, name, model, visibility, config FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
	)
		.bind(agentId)
		.first<{ id: string; name: string; model: string; config: string | null }>();
	if (!agent) throw new HttpError(404, "Agent not found or not published");

	// Multiple instances of the same agent are allowed (e.g. two Doc Chat libraries
	// with different documents). Later ones fall back to a numbered display name so they're
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

	// Create instance row. A name the subscriber CHOSE wins; second+ instances of the same agent
	// otherwise fall back to a numbered display name (config.displayName; user-renameable).
	//
	// `<Agent> 2` is a uniqueness suffix, not a name anybody would say out loud, and that is a
	// functional defect rather than an aesthetic one (#450): a transcriber writes "repo coder
	// two", the roster says "Repo Coder 2", and nothing bridges them — `normalizeSpeech` does not
	// convert number words and deliberately must not, since that table is per-language and shared
	// with every voice command in the SDK. So a spoken transfer to an auto-numbered agent resolves
	// to nothing. The console now ASKS for a name when you subscribe to an agent you already have;
	// the fallback stays for API/MCP callers, which have nobody to ask, and `resolveSubordinate`'s
	// refusal names what it produced so the dead end points at the fix.
	//
	// An agent may also DECLARE default pipelines (agents.config.pipelines). For an agent
	// whose whole behaviour IS its pipelines, those have to arrive with the subscription —
	// loadPipeline reads the INSTANCE config, so without this a fresh subscriber gets an
	// agent that can do nothing until they attach each pipeline by hand. Copied (not
	// referenced) so the subscriber owns their copy and can edit it, which is the same
	// template→instance rule the KB and identity already follow. Invalid defs are dropped
	// rather than poisoning the instance config.
	const displayName = chosenName || (nth > 1 ? `${agent.name} ${nth}` : "");
	const initial: Record<string, unknown> = displayName ? { displayName } : {};
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
		`SELECT i.id, i.agent_id, i.status, i.created_at, i.last_activity_at, i.config AS instance_config,
            a.name, a.slug, a.description, a.category, a.icon, a.icon_bg, a.config
     FROM agent_instances i
     JOIN agents a ON a.id = i.agent_id
     WHERE i.user_id = ?1${includeCanceled ? "" : " AND i.status != 'canceled'"}
     ORDER BY COALESCE(i.last_activity_at, i.updated_at) DESC`,
	)
		.bind(session.uid)
		.all<Record<string, unknown>>();
	// Attach a LIGHTWEIGHT capability descriptor — surfaces, runtime, workflow are
	// all a list consumer needs to route/display. The heavy per-agent blobs
	// (boardColumns: up to 10 objects, settingsSchema: up to 12 fields with option
	// arrays) are omitted here and remain fetchable per-instance via
	// GET /v1/agents/:id/settings-schema and GET /v1/instances/:id/settings.
	//
	// `config` (which may hold secrets/internal settings) is dropped from the response — all of
	// it except the two keys `instanceListView` whitelists: the display name (how two instances
	// of one agent stay distinguishable) and the runner-node PIN, which `pags up` filters its
	// membership on and could not see while the whole blob was dropped (#500).
	const instances = (results ?? []).map((r) => {
		const { config, instance_config, last_activity_at, ...rest } = r;
		const view = instanceListView(instance_config as string | null);
		// Full capabilities (with boardColumns + settingsSchema) cost ~83 KB for 28
		// instances. The list only needs the routing fields; heavy config lives on the
		// per-instance/per-agent detail routes.
		const fullCaps = agentCapabilities({ slug: r.slug as string, category: r.category as string, config: config as string }, c.env);
		const { boardColumns: _bc, settingsSchema: _ss, ...lightCaps } = fullCaps;
		return {
			...rest,
			...(view.displayName ? { name: view.displayName, agentName: r.name } : {}),
			// Present ONLY when pinned, so an unpinned instance answers with no `config` key at
			// all and the shipped runner's `inst.config?.runnerNode` reads undefined as before.
			...(view.runnerNode ? { config: { runnerNode: view.runnerNode } } : {}),
			lastActivityAt: last_activity_at ?? null,
			// env carries the fail-closed custom-surface gate (#186) — this is the one response the
			// console renders tabs from, so it is the path that must consult it.
			capabilities: lightCaps,
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
	// Stable machine identity (#379), additive to the hostname — see lib/machine-identity.ts for
	// why the hostname could not simply be replaced. Empty for every older CLI, which then behaves
	// exactly as it does today: no id, no alias, no change.
	const machineId = normalizeMachineId(body.machineId);
	const machineNames = sanitizeMachineNames(body.machineNames);

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
				machineId || null,
			)
			.run();
		// Adopt the rows this machine left under the hostnames it used to wear, so a pin already
		// stranded on a dead name resolves again. Best-effort: a failed backfill must not fail the
		// registration — the runner would then be unreachable for a bookkeeping write.
		if (machineId && machineNames.length) {
			await claimMachineNames(c.env, session.uid, machineId, machineNames).catch(() => 0);
		}
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
	// Distinct MACHINES known for this instance. One laptop used to appear three times here —
	// `Mac`, `RLs-MacBook-Air.local`, `RLs-MacBook-Air` — because a registration is keyed by a
	// hostname that moves under it (#379). Rows sharing a `machine_id` collapse to their freshest
	// name; rows without one stay separate, because without the proof they ARE separate.
	const machines = foldNodesByMachine(nodes.map((n) => ({ node: normalizeRunnerNode(n.runner_node), machineId: n.machine_id ?? null, lastSeenAt: n.last_seen_at })));
	const available = [...new Set(machines.map((n) => n.node).filter(Boolean))];

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
	// Where the pin ACTUALLY resolves right now (#379). A pin names a hostname, and a hostname
	// moves under the machine — so a pin can name the right MACHINE and a dead NAME at once. The
	// console has to be told, or it prints "⚠ pinned machine offline" over an agent that is
	// working. Null when the pin resolves to itself, or to nothing.
	const pinnedDetail = nodesDetail.find((d) => d.node === runnerNode);
	const resolvedNode = runnerNode && pinnedDetail && !pinnedDetail.connected
		? await liveAliasForPin(c.env, instanceId, session.uid, runnerNode).catch(() => null)
		: null;
	return c.json({ runnerNode: runnerNode || null, nodes: available, nodesDetail, resolvedNode });
});

/** Pin (or clear, with an empty/null value) the node this instance runs on.
 *
 *  The write itself lives in `lib/runner-node-pin.ts`, which records the change to the trace (#533).
 *  It is there rather than here because this key decides whether every runner call routes anywhere,
 *  and an audit a route remembers is one the next writer forgets — see that module's header. */
instanceRoutes.put("/:instanceId/runner-node", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { runnerNode?: unknown };
	const { to } = await setRunnerNodePin(c.env, instanceId, session.uid, body.runnerNode, { via: "api" });
	return c.json({ runnerNode: to || null });
});

/** Read which terminal session was last selected in the UI for this instance (#491). */
instanceRoutes.get("/:instanceId/terminal-session", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const row = await c.env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, session.uid)
		.first<{ config: string | null }>();
	let target: string | null = null;
	try {
		const cfg = JSON.parse(row?.config || "{}") as { activeTerminalTarget?: unknown };
		target = typeof cfg.activeTerminalTarget === "string" && cfg.activeTerminalTarget ? cfg.activeTerminalTarget : null;
	} catch { /* stay null */ }
	return c.json({ activeTerminalTarget: target });
});

/** Persist (or clear) the last-selected terminal session for this instance (#491).
 *  Mirrors the `runnerNode` pattern — a per-instance pin written to config and read back on mount. */
instanceRoutes.put("/:instanceId/terminal-session", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { activeTerminalTarget?: unknown };
	const target = typeof body.activeTerminalTarget === "string" ? body.activeTerminalTarget.trim().slice(0, 200) : "";
	if (target) await patchInstanceConfig(c.env, instanceId, session.uid, "activeTerminalTarget", target);
	else await removeInstanceConfigKey(c.env, instanceId, session.uid, "activeTerminalTarget");
	return c.json({ activeTerminalTarget: target || null });
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
	// Still `voiceSettings`, still the fully-resolved object: `getVoiceConfig` in
	// packages/sdk/src/voice/config.ts reads exactly that key, so the SDK, the console chat and
	// coder-web all keep working unchanged while resolution moves server-side.
	return c.json(await voiceSettingsBody(c.env, instanceId, session.uid, cfg));
});

/**
 * The voice-settings response, identical from GET, PUT and DELETE so the panel never repaints
 * differently depending on which one it just called.
 *
 * `voiceSettings` carries two READ-ONLY companions to `vocabulary`, inside the same object because
 * that is the object the SDK and the shared `VoiceFields` control both already receive. Neither is
 * a setting and neither survives a write — `sanitizeVoiceSettings` builds a fresh object from the
 * fields it knows, so an echo of either back through PUT is dropped rather than persisted.
 *
 *   inheritedVocabulary — your ACCOUNT words, which apply here AS WELL AS this agent's. Rendering
 *     them is what makes the union visible, since every other control on that panel overrides.
 *   derivedVocabulary — what the platform already knows (see `deriveVoiceVocabulary`). Delivered
 *     here rather than assembled in the console because this response is re-fetched on every mic
 *     start, so attaching a repo changes the NEXT turn's bias (#372).
 */
async function voiceSettingsBody(env: Env, instanceId: string, userId: string, cfg: Record<string, unknown>) {
	const { effective, hasOverride, accountVocabulary } = await effectiveVoice(env, instanceId, userId, cfg);
	return {
		voiceSettings: {
			...effective,
			inheritedVocabulary: accountVocabulary,
			derivedVocabulary: await deriveVoiceVocabulary(env, instanceId, userId),
		},
		hasOverride,
	};
}

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
): Promise<{ effective: VoiceSettings; hasOverride: boolean; accountVocabulary: string[] }> {
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
	return {
		effective: resolveVoice(account.voice, hasOverride ? override : undefined, declaredLanguage),
		hasOverride,
		accountVocabulary: account.voice?.vocabulary || [],
	};
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
	// Everything seeds from your account EXCEPT the vocabulary, which seeds from this agent's own
	// current list — see `overrideVoiceBase`. A union that snapshots the thing it unions with is
	// not a union, and the snapshot is invisible from the panel that made it.
	const existing = await readInstanceConfig(c.env, instanceId, session.uid);
	const settings = sanitizeVoiceSettings(body, overrideVoiceBase(account.voice, existing.voiceSettings));
	await patchInstanceConfig(c.env, instanceId, session.uid, "voiceSettings", settings);
	// Resolve against the config AS WRITTEN, not the copy read beforehand. The patch now goes
	// straight to SQL without mutating a local blob, so resolving off the pre-write read would
	// echo the OLD override back — the panel would show your previous speed after saving a new one.
	return c.json(await voiceSettingsBody(c.env, instanceId, session.uid, { voiceSettings: settings }));
});

/** "Use my defaults" — drop the override entirely. Absence is what the resolver reads. */
instanceRoutes.delete("/:instanceId/voice-settings", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await removeInstanceConfigKey(c.env, instanceId, session.uid, "voiceSettings");
	// Resolve against an EMPTY override — that is the state just written, and "use my defaults"
	// must report the account default, not the override it has just deleted.
	return c.json(await voiceSettingsBody(c.env, instanceId, session.uid, {}));
});

/** Rename this instance (per-instance display name — distinguishes multiple
 *  instances of the same agent on the dashboard). Empty name = back to the agent's.
 *  Gated on `requireOwnedInstance`, not the `readInstanceConfig` it discarded (#350): that
 *  answers `{}` for a row that is not yours exactly as for an owned instance with no config, so
 *  it could not tell them apart and never threw. The writes bind `user_id` — nothing crossed
 *  tenants — but a stranger got `200 {"name":…}` for an UPDATE matching zero rows, and a route
 *  must not report success for work it did not do. */
instanceRoutes.put("/:instanceId/name", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
	const name = displayNameFrom(body.name);
	await requireOwnedInstance(c.env, instanceId, session.uid);
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

	// ── A settings field does NOT get to create or move a repo row (#411)
	//
	// `attachSettingRepo` used to run here: a `repo` setting on a coding agent created a
	// `coding_repos` row, once, if the instance had none. It was added for a real gap (#157/#182 —
	// you named the repo an agent owned and it still had none, so a delegated goal was refused with
	// "no repository yet"), and it is exactly HALF a wire, which turned out to be worse than none.
	//
	// It fired on create and never again. So the second edit — the one an owner makes because the
	// first path was wrong — was stored faithfully in `config.settings.repo` and read by nothing,
	// while every tool went on reading `coding_repos.workdir`. That is the whole of the reported
	// bug: "I updated it, but it is still using the old one." Both halves were true.
	//
	// Removed rather than finished. A mirror is a second place the same fact is written down; it
	// needs a sync, and a sync that can fail is a disagreement waiting to happen. `settings.repo`
	// was declared on ONE agent (`coder-repo`, migration 0063) and migration 0101 takes it off;
	// the repo row is the single home for a repo's address, and #410 makes that address editable
	// where the repo actually lives — the Coding tab's repo settings sheet.
	//
	// Stored `settings.repo` values are left ORPHANED on purpose. They were never validated and at
	// least one of them is wrong, so adopting one into `workdir` would install a broken path as
	// though somebody had chosen it — the false claim #405 spent a ticket removing.

	return c.json({ settings: resolveSettingsValues(schema, result.settings) });
});

/** Probe a registered runtime's health and capabilities through PAGS. */
instanceRoutes.get("/:instanceId/runtime/status", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
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
		// #380: liveness is the PIN-AWARE answer or nothing. This used to ask `relayConnected`
		// about `runtime.runner_node` — which, once `getLiveRuntime` returned null, is the FALLBACK
		// row's node, a machine the pin excludes. So the pin-blind question overrode the pin-aware
		// one and the endpoint whose job is "is this agent's runner up" answered "Connected." for
		// an agent that could not reach a runner at all. `getLiveRuntime` is itself relay-checked
		// (via `getBoundRunnerConn`), so its result IS the live check — no second probe, and no
		// route by which a node the pin excludes can contribute to this boolean.
		const relayIsConnected = Boolean(liveRuntime);
		// Only when it is NOT attached, and only to DESCRIBE: which machine is actually up, so the
		// sentence below can name it instead of prescribing a command the user is already running.
		const pinnedNode = liveRuntime ? "" : parseBoundRunnerNode(instance.config);
		const liveNodeExcludedByPin = pinnedNode
			? await liveNodeIgnoringPin(c.env, instanceId, session.uid).catch(() => null)
			: null;
		// Say WHY when it isn't attached (#237). The console previously had only a boolean, so a
		// machine that is demonstrably alive with one agent detached rendered as an unexplained
		// amber dot — the CLI knew the reason and the remedy and printed both to a terminal
		// nobody was watching.
		//
		// THIRD construction site for `diagnoseAttachment` (#468) — a direct call on purpose: the
		// liveness and the pin are already resolved above, so going through `describeFacts` would
		// re-probe the relay and swap this row's `last_seen_at` for a different fact. A sixth input
		// to the diagnosis must be added HERE as well as in the two adapters.
		const attachment = diagnoseAttachment({
			hasRuntimeRow: true,
			relayConnected: relayIsConnected,
			lastSeenAt: runtime.last_seen_at,
			pinnedNode,
			liveNodeExcludedByPin,
		});
		return c.json({
			runtime: runtimeResponse({ ...runtime, status: effective, last_seen_at: new Date().toISOString() }),
			health,
			capabilities,
			relay: {
				connected: relayIsConnected,
				// The node the answer is ABOUT: the live one when there is one, else the pin — never
				// the fallback row's machine, which is what made "Connected." name the wrong laptop.
				runnerNode: (liveRuntime?.runner_node || pinnedNode || runtime.runner_node) || null,
				live: Boolean(liveRuntime),
			},
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
// The connector bindings (#402, #447) — the subscriber's half of a creator-declared ceiling
// (`/terminal-target`, `/tmux-session`), the same shape as the `/runner-node` pin above and mounted
// from its own module for the same reason the others are: this file is already at its size pin.
registerConnectorBindingRoutes(instanceRoutes);
// Deployment / build status for any instance — the Operator counterpart to the Coder Build Status
// panel (#488). Mounted from its own module to keep this file at its size pin.
registerDeployStatusRoutes(instanceRoutes);

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
