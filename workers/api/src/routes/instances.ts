import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import { createNotification } from "./notifications.js";
import type { Env } from "../types.js";

export const instanceRoutes = new Hono<{ Bindings: Env }>();

interface InstanceRow {
	id: string;
	agent_id: string;
	user_id: string;
	status: string;
	config: string;
	created_at: string;
	updated_at: string;
}

interface RuntimeRow {
	instance_id: string;
	user_id: string;
	placement: string;
	endpoint_url: string;
	token_ciphertext: ArrayBuffer | Uint8Array | null;
	token_dek_wrapped: ArrayBuffer | Uint8Array | null;
	token_iv: ArrayBuffer | Uint8Array | null;
	token_plaintext: string | null;
	capabilities: string;
	runner_version: string;
	status: string;
	last_seen_at: string | null;
	created_at: string;
	updated_at: string;
}

interface RuntimeRegistrationBody {
	endpointUrl: string;
	token?: string;
	placement?: "local" | "managed";
	capabilities?: unknown[];
	runnerVersion?: string;
}

interface RunnerTaskBody {
	type: string;
	input?: Record<string, unknown>;
	requiresApproval?: boolean;
	approvalPrompt?: string;
}

interface RuntimeTaskMirrorRow {
	payload: string;
}

interface RuntimeTaskEventMirrorRow {
	payload: string;
}

const APPROVAL_REQUIRED_RUNNER_TASKS = new Set(["browser.open", "job.apply_basic"]);
const CLOUDFLARE_AI_SETUP_TASK_TYPE = "setup.cloudflare_workers_ai";
const FAGS_RUNTIME_SETUP_TASK_TYPE = "setup.fags_browser_runtime";

export function validateRuntimeEndpointUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new HttpError(400, "endpointUrl must be a valid URL");
	}

	const isLocalhost =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]" ||
		url.hostname === "::1";
	if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
		throw new HttpError(400, "endpointUrl must be https, except localhost for development");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function safeCapabilities(value: unknown): unknown[] {
	return Array.isArray(value)
		? value.filter((item) => typeof item === "string").slice(0, 50)
		: [];
}

function runtimeResponse(row: RuntimeRow) {
	return {
		instanceId: row.instance_id,
		placement: row.placement,
		endpointUrl: row.endpoint_url,
		capabilities: safeParseArray(row.capabilities),
		runnerVersion: row.runner_version,
		status: row.status,
		lastSeenAt: row.last_seen_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		hasToken: Boolean(row.token_plaintext || row.token_ciphertext),
	};
}

function safeParseArray(value: string): unknown[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ error: "Value could not be serialized" });
	}
}

function parsePayload(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return {};
	}
}

function taskTimestamp(value: unknown): string {
	return typeof value === "string" && value.trim()
		? value
		: new Date().toISOString();
}

function taskId(value: Record<string, unknown>): string | null {
	return typeof value.id === "string" && value.id.trim() ? value.id : null;
}

export function cloudflareAiSetupTaskId(instanceId: string): string {
	return `${instanceId}:setup:cloudflare-workers-ai`;
}

export function fagsRuntimeSetupTaskId(instanceId: string): string {
	return `${instanceId}:setup:fags-browser-runtime`;
}

export function isCloudflareAiCredentialsError(value: unknown): boolean {
	const text = typeof value === "string" ? value : "";
	return text.includes("Cloudflare Workers AI account ID and API token") ||
		text.includes("Stored Cloudflare Workers AI credentials are invalid");
}

export function cloudflareAiSetupTask(
	instanceId: string,
	message: string,
	now = new Date().toISOString(),
): Record<string, unknown> {
	return {
		id: cloudflareAiSetupTaskId(instanceId),
		type: CLOUDFLARE_AI_SETUP_TASK_TYPE,
		status: "blocked",
		requiresApproval: false,
		approval: {
			prompt: "Add caller-owned Cloudflare Workers AI credentials in Profile -> API Keys.",
		},
		input: {
			provider: "cloudflare",
			profilePath: "/profile",
		},
		error: message,
		createdAt: now,
		updatedAt: now,
		synthetic: true,
	};
}

export function fagsRuntimeSetupTask(
	instanceId: string,
	now = new Date().toISOString(),
): Record<string, unknown> {
	return {
		id: fagsRuntimeSetupTaskId(instanceId),
		type: FAGS_RUNTIME_SETUP_TASK_TYPE,
		status: "blocked",
		requiresApproval: false,
		approval: {
			prompt: "Connect the local FAGS browser runtime before creating browser tasks.",
		},
		input: {
			install: "npm i -g @proagentstore/cli",
			connect: `pags runner connect ${instanceId} --pags-token <your-token>`,
		},
		error: "No FAGS browser runtime is registered for this instance.",
		createdAt: now,
		updatedAt: now,
		synthetic: true,
	};
}

export function runtimeTasksFromPayload(value: unknown): Record<string, unknown>[] {
	if (!isRecord(value)) return [];
	if (Array.isArray(value.tasks)) {
		return value.tasks.filter(isRecord);
	}
	return taskId(value) ? [value] : [];
}

export function runtimeEventsFromPayload(value: unknown): Record<string, unknown>[] {
	if (!isRecord(value) || !Array.isArray(value.events)) return [];
	return value.events.filter(isRecord);
}

async function mirrorRuntimeTask(
	env: Env,
	instanceId: string,
	userId: string,
	task: Record<string, unknown>,
): Promise<void> {
	const id = taskId(task);
	if (!id) return;
	const type = typeof task.type === "string" ? task.type.slice(0, 120) : "task";
	const status = typeof task.status === "string" ? task.status.slice(0, 80) : "queued";
	const createdAt = taskTimestamp(task.createdAt ?? task.created_at);
	const updatedAt = taskTimestamp(task.updatedAt ?? task.updated_at ?? createdAt);
	await env.DB.prepare(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       status = excluded.status,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
	)
		.bind(id, instanceId, userId, type, status, safeJsonStringify(task), createdAt, updatedAt)
		.run();
}

async function mirrorRuntimeTasks(
	env: Env,
	instanceId: string,
	userId: string,
	payload: unknown,
): Promise<void> {
	const tasks = runtimeTasksFromPayload(payload);
	await Promise.all(tasks.map((task) => mirrorRuntimeTask(env, instanceId, userId, task)));
}

async function mirroredRuntimeTasks(
	env: Env,
	instanceId: string,
	userId: string,
	limit = 200,
): Promise<unknown[]> {
	const { results } = await env.DB.prepare(
		`SELECT payload FROM instance_runtime_tasks
     WHERE instance_id = ?1 AND user_id = ?2
     ORDER BY updated_at DESC
     LIMIT ?3`,
	)
		.bind(instanceId, userId, limit)
		.all<RuntimeTaskMirrorRow>();
	return results.map((row) => parsePayload(row.payload));
}

async function mirroredRuntimeTask(
	env: Env,
	instanceId: string,
	userId: string,
	id: string,
): Promise<unknown | null> {
	const row = await env.DB.prepare(
		`SELECT payload FROM instance_runtime_tasks
     WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(id, instanceId, userId)
		.first<RuntimeTaskMirrorRow>();
	return row ? parsePayload(row.payload) : null;
}

async function deleteMirroredRuntimeTask(
	env: Env,
	instanceId: string,
	userId: string,
	id: string,
): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(id, instanceId, userId)
		.run();
}

async function mirrorRuntimeEvent(
	env: Env,
	instanceId: string,
	userId: string,
	event: Record<string, unknown>,
): Promise<void> {
	const id = typeof event.id === "string" && event.id.trim()
		? event.id
		: `event_${crypto.randomUUID()}`;
	const task_id = typeof event.taskId === "string"
		? event.taskId
		: typeof event.task_id === "string"
			? event.task_id
			: null;
	const type = typeof event.type === "string" ? event.type.slice(0, 120) : "task.event";
	const createdAt = taskTimestamp(event.createdAt ?? event.created_at);
	await env.DB.prepare(
		`INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       payload = excluded.payload,
       created_at = excluded.created_at`,
	)
		.bind(id, instanceId, userId, task_id, type, safeJsonStringify({ ...event, id }), createdAt)
		.run();
}

async function mirrorSyntheticTaskEvent(
	env: Env,
	instanceId: string,
	userId: string,
	task: Record<string, unknown>,
	type: string,
	createdAt: unknown,
	data: Record<string, unknown> = {},
): Promise<void> {
	const id = taskId(task);
	if (!id) return;
	await mirrorRuntimeEvent(env, instanceId, userId, {
		id: `${id}:${type}`,
		taskId: id,
		type,
		message: `Task ${type.replace("task.", "")}: ${typeof task.type === "string" ? task.type : "task"}`,
		data: Object.keys(data).length ? data : undefined,
		createdAt: taskTimestamp(createdAt),
	});
}

async function mirrorTaskLifecycleEvents(
	env: Env,
	instanceId: string,
	userId: string,
	payload: unknown,
	phase: "created" | "approved" | "cancelled",
): Promise<void> {
	const tasks = runtimeTasksFromPayload(payload);
	await Promise.all(tasks.map(async (task) => {
		if (phase === "created") {
			await mirrorSyntheticTaskEvent(env, instanceId, userId, task, "task.created", task.createdAt, {
				status: task.status,
			});
		}
		if (phase === "approved") {
			const approval = isRecord(task.approval) ? task.approval : {};
			await mirrorSyntheticTaskEvent(
				env,
				instanceId,
				userId,
				task,
				"task.approved",
				approval.approvedAt ?? task.updatedAt,
			);
			if (task.status === "completed") {
				await mirrorSyntheticTaskEvent(env, instanceId, userId, task, "task.completed", task.completedAt ?? task.updatedAt, task);
			}
			if (task.status === "failed") {
				await mirrorSyntheticTaskEvent(env, instanceId, userId, task, "task.failed", task.updatedAt, {
					error: task.error,
				});
			}
		}
		if (phase === "cancelled") {
			await mirrorSyntheticTaskEvent(env, instanceId, userId, task, "task.cancelled", task.updatedAt, {
				status: task.status,
			});
		}
	}));
}

async function mirrorRuntimeEvents(
	env: Env,
	instanceId: string,
	userId: string,
	payload: unknown,
): Promise<void> {
	const events = runtimeEventsFromPayload(payload);
	await Promise.all(events.map((event) => mirrorRuntimeEvent(env, instanceId, userId, event)));
}

async function mirroredRuntimeEvents(
	env: Env,
	instanceId: string,
	userId: string,
	limit = 100,
): Promise<unknown[]> {
	const { results } = await env.DB.prepare(
		`SELECT payload FROM instance_runtime_task_events
     WHERE instance_id = ?1 AND user_id = ?2
     ORDER BY created_at DESC
     LIMIT ?3`,
	)
		.bind(instanceId, userId, limit)
		.all<RuntimeTaskEventMirrorRow>();
	return results.map((row) => parsePayload(row.payload));
}

function syntheticEventsFromTasks(tasks: unknown[]): unknown[] {
	return tasks
		.filter(isRecord)
		.map((task) => {
			const id = taskId(task);
			const status = typeof task.status === "string" ? task.status : "updated";
			const type = status === "completed"
				? "task.completed"
				: status === "failed"
					? "task.failed"
					: status === "cancelled"
						? "task.cancelled"
						: `task.${status}`;
			return {
				id: id ? `${id}:${type}:synthetic` : `event_${crypto.randomUUID()}`,
				taskId: id,
				type,
				message: `Task ${status}: ${typeof task.type === "string" ? task.type : "task"}`,
				data: task,
				createdAt: taskTimestamp(task.completedAt ?? task.updatedAt ?? task.createdAt),
				synthetic: true,
			};
		});
}

function runtimeErrorPayload(payload: unknown): string {
	if (isRecord(payload) && typeof payload.error === "string") return payload.error;
	return "Runtime unavailable";
}

export function normalizeRunnerTaskBody(value: unknown): RunnerTaskBody {
	if (!isRecord(value) || typeof value.type !== "string" || !value.type.trim()) {
		throw new HttpError(400, "task type required");
	}
	const type = value.type.trim().slice(0, 120);
	const requiresApproval =
		value.requiresApproval === true || APPROVAL_REQUIRED_RUNNER_TASKS.has(type);
	return {
		type,
		input: isRecord(value.input) ? value.input : {},
		requiresApproval,
		approvalPrompt: typeof value.approvalPrompt === "string"
			? value.approvalPrompt.slice(0, 500)
			: requiresApproval
				? `Approve task ${type}`
				: undefined,
	};
}

async function requireOwnedInstance(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<InstanceRow> {
	const instance = await env.DB.prepare(
		"SELECT id, agent_id, user_id, status, config, created_at, updated_at FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<InstanceRow>();
	if (!instance) throw new HttpError(404, "Instance not found");
	return instance;
}

async function getRuntime(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<RuntimeRow | null> {
	return env.DB.prepare(
		"SELECT * FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<RuntimeRow>();
}

async function requireRuntime(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<RuntimeRow> {
	const runtime = await getRuntime(env, instanceId, userId);
	if (!runtime) throw new HttpError(404, "Runtime not registered");
	return runtime;
}

async function encodeRuntimeToken(env: Env, token: string | undefined): Promise<{
	ciphertext: Uint8Array | null;
	dekWrapped: Uint8Array | null;
	iv: Uint8Array | null;
	plaintext: string | null;
}> {
	if (!token) {
		return { ciphertext: null, dekWrapped: null, iv: null, plaintext: null };
	}
	if (!env.KEY_ENCRYPTION_KEY) {
		return { ciphertext: null, dekWrapped: null, iv: null, plaintext: token };
	}
	const encrypted = await encryptKey(token, env.KEY_ENCRYPTION_KEY);
	return {
		ciphertext: encrypted.ciphertext,
		dekWrapped: encrypted.dekWrapped,
		iv: encrypted.iv,
		plaintext: null,
	};
}

async function decodeRuntimeToken(env: Env, row: RuntimeRow): Promise<string | null> {
	if (row.token_plaintext) return row.token_plaintext;
	if (
		!row.token_ciphertext ||
		!row.token_dek_wrapped ||
		!row.token_iv ||
		!env.KEY_ENCRYPTION_KEY
	) {
		return null;
	}
	return decryptKey(
		new Uint8Array(row.token_ciphertext),
		new Uint8Array(row.token_dek_wrapped),
		new Uint8Array(row.token_iv),
		env.KEY_ENCRYPTION_KEY,
	);
}

async function callRuntime(
	env: Env,
	row: RuntimeRow,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const token = await decodeRuntimeToken(env, row);
	const url = new URL(path, `${row.endpoint_url}/`);
	const headers = new Headers(init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);
	headers.set("X-PAGS-Instance-Id", row.instance_id);
	headers.set("X-PAGS-Runtime-Placement", row.placement);
	if (init.body && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	return fetch(url.toString(), {
		...init,
		headers,
	});
}

async function runtimeJson(res: Response): Promise<unknown> {
	const text = await res.text();
	if (!text) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return {
			error: text || res.statusText || "Runtime returned a non-JSON response",
		};
	}
}

function runtimeStatus(res: Response, okStatus: number): ContentfulStatusCode {
	return (res.ok ? okStatus : Math.max(400, Math.min(599, res.status))) as ContentfulStatusCode;
}

async function updateRuntimeStatus(
	env: Env,
	instanceId: string,
	userId: string,
	status: string,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE instance_runtimes
     SET status = ?1, last_seen_at = datetime('now'), updated_at = datetime('now')
     WHERE instance_id = ?2 AND user_id = ?3`,
	)
		.bind(status, instanceId, userId)
		.run();
}

/** Subscribe to an agent — creates a personal instance with its own DO. */
instanceRoutes.post("/:agentId/subscribe", async (c) => {
	const session = await requireUser(c);
	const agentId = c.req.param("agentId");

	// Verify agent exists and is published
	const agent = await c.env.DB.prepare(
		`SELECT id, name, model, visibility FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
	)
		.bind(agentId)
		.first<{ id: string; name: string; model: string }>();
	if (!agent) throw new HttpError(404, "Agent not found or not published");

	// Check if already subscribed
	const existing = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE agent_id = ?1 AND user_id = ?2",
	)
		.bind(agent.id, session.uid)
		.first();
	if (existing) throw new HttpError(409, "Already subscribed to this agent");

	const instanceId = crypto.randomUUID();

	// Create instance row
	await c.env.DB.prepare(
		`INSERT INTO agent_instances (id, agent_id, user_id, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'active', datetime('now'), datetime('now'))`,
	)
		.bind(instanceId, agent.id, session.uid)
		.run();

	// Create subscription row
	await c.env.DB.prepare(
		`INSERT INTO subscriptions (id, user_id, agent_id, status, started_at)
     VALUES (?1, ?2, ?3, 'active', datetime('now'))`,
	)
		.bind(crypto.randomUUID(), session.uid, agent.id)
		.run();

	// Initialize the instance's DO — copy template state from the agent's DO
	const templateDoId = c.env.AGENT.idFromName(agent.id);
	const templateStub = c.env.AGENT.get(templateDoId);
	const stateRes = await templateStub.fetch(new Request("https://agent/state"));
	const templateState = (await stateRes.json()) as Record<string, unknown>;

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
				personality: templateState.personality || "",
				goal: templateState.goal || "",
				model: templateState.model || agent.model,
				guardrails: templateState.guardrails || {},
				welcomeMessage: templateState.welcomeMessage || "",
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
		`SELECT i.id, i.agent_id, i.status, i.created_at,
            a.name, a.slug, a.description, a.category, a.icon, a.icon_bg
     FROM agent_instances i
     JOIN agents a ON a.id = i.agent_id
     WHERE i.user_id = ?1
     ORDER BY i.updated_at DESC`,
	)
		.bind(session.uid)
		.all();
	return c.json({ instances: results });
});

/** Register or update the local/managed runtime for my instance. */
instanceRoutes.post("/:instanceId/runtime", async (c) => {
	try {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);

	const body = await c.req.json<RuntimeRegistrationBody>();
	const endpointUrl = validateRuntimeEndpointUrl(body.endpointUrl);
	const tokenParts = await encodeRuntimeToken(c.env, body.token);
	const capabilities = JSON.stringify(safeCapabilities(body.capabilities));
	const placement = body.placement === "managed" ? "managed" : "local";
	const runnerVersion = String(body.runnerVersion || "").slice(0, 80);

	await c.env.DB.prepare(
		`INSERT INTO instance_runtimes (
       instance_id, user_id, placement, endpoint_url,
       token_ciphertext, token_dek_wrapped, token_iv, token_plaintext,
       capabilities, runner_version, status, last_seen_at, created_at, updated_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'registered', datetime('now'), datetime('now'), datetime('now'))
     ON CONFLICT(instance_id) DO UPDATE SET
       placement = excluded.placement,
       endpoint_url = excluded.endpoint_url,
       token_ciphertext = excluded.token_ciphertext,
       token_dek_wrapped = excluded.token_dek_wrapped,
       token_iv = excluded.token_iv,
       token_plaintext = excluded.token_plaintext,
       capabilities = excluded.capabilities,
       runner_version = excluded.runner_version,
       status = 'registered',
       last_seen_at = datetime('now'),
       updated_at = datetime('now')`,
	)
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
		)
		.run();

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

/** Heartbeat from user/CLI after checking the FAGS runtime is online. */
instanceRoutes.post("/:instanceId/runtime/heartbeat", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await requireRuntime(c.env, instanceId, session.uid);
	await updateRuntimeStatus(c.env, instanceId, session.uid, "online");
	return c.json({ success: true, status: "online" });
});

/** Probe a registered runtime's health and capabilities through PAGS. */
instanceRoutes.get("/:instanceId/runtime/status", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);

	try {
		const [healthRes, capabilitiesRes] = await Promise.all([
			callRuntime(c.env, runtime, "/health"),
			callRuntime(c.env, runtime, "/capabilities"),
		]);
		const health = await healthRes.json().catch(() => ({}));
		const capabilities = await capabilitiesRes.json().catch(() => ({}));
		const online = healthRes.ok && capabilitiesRes.ok;
		await updateRuntimeStatus(c.env, instanceId, session.uid, online ? "online" : "offline");
		return c.json({
			runtime: runtimeResponse({
				...runtime,
				status: online ? "online" : "offline",
				last_seen_at: new Date().toISOString(),
			}),
			health,
			capabilities,
		});
	} catch (error) {
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		return c.json({
			runtime: runtimeResponse({ ...runtime, status: "offline" }),
			error: error instanceof Error ? error.message : String(error),
		}, 502);
	}
});

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
			(task) => isRecord(task) && task.id === fagsRuntimeSetupTaskId(instanceId),
		);
		if (!hasRuntimeSetupTask) tasks.unshift(fagsRuntimeSetupTask(instanceId));
		return c.json({
			tasks,
			runtimeUnavailable: true,
			error: "Runtime not registered",
		});
	}
	try {
		const res = await callRuntime(c.env, runtime, "/tasks");
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
			return c.json(payload, 200);
		}
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		return c.json({
			tasks: await mirroredRuntimeTasks(c.env, instanceId, session.uid),
			runtimeUnavailable: true,
			error: runtimeErrorPayload(payload),
		});
	} catch (error) {
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		return c.json({
			tasks: await mirroredRuntimeTasks(c.env, instanceId, session.uid),
			runtimeUnavailable: true,
			error: error instanceof Error ? error.message : String(error),
		});
	}
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
			events: events.length ? events : syntheticEventsFromTasks(tasks.length ? tasks : [fagsRuntimeSetupTask(instanceId)]),
			runtimeUnavailable: true,
			error: "Runtime not registered",
		});
	}
	try {
		const res = await callRuntime(c.env, runtime, `/events?limit=${encodeURIComponent(String(limit))}`);
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeEvents(c.env, instanceId, session.uid, payload);
			return c.json(payload, 200);
		}
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
		const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
		return c.json({
			events: events.length ? events : syntheticEventsFromTasks(tasks),
			runtimeUnavailable: true,
			error: runtimeErrorPayload(payload),
		});
	} catch (error) {
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
		const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
		return c.json({
			events: events.length ? events : syntheticEventsFromTasks(tasks),
			runtimeUnavailable: true,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});

/** Chat with my instance of an agent. */
instanceRoutes.post("/:instanceId/chat", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const { message } = await c.req.json<{ message: string }>();
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

	const limit = c.req.query("limit") || "50";
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request(`https://agent/messages?limit=${limit}`),
	);
	return c.json(await doRes.json());
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
		new Request(`https://agent/knowledge/${docId}`, { method: "DELETE" }),
	);
	return c.json(await doRes.json());
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
