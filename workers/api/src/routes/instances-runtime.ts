import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError } from "../lib/auth.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import type { Env } from "../types.js";

export interface InstanceRow {
	id: string;
	agent_id: string;
	user_id: string;
	status: string;
	config: string;
	created_at: string;
	updated_at: string;
}

export interface RuntimeRow {
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

export interface RuntimeRegistrationBody {
	endpointUrl: string;
	token?: string;
	placement?: "local" | "managed";
	capabilities?: unknown[];
	runnerVersion?: string;
}

export const UPSERT_INSTANCE_RUNTIME_SQL = `INSERT INTO instance_runtimes (
       instance_id, user_id, placement, endpoint_url,
       token_ciphertext, token_dek_wrapped, token_iv, token_plaintext,
       capabilities, runner_version, status, last_seen_at, created_at, updated_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'registered', datetime('now'), datetime('now'), datetime('now'))
     ON CONFLICT(instance_id) DO UPDATE SET
       user_id = excluded.user_id,
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
       updated_at = datetime('now')`;

export interface RunnerTaskBody {
	type: string;
	input?: Record<string, unknown>;
	requiresApproval?: boolean;
	approvalPrompt?: string;
}

export interface RuntimeTaskMirrorRow {
	payload: string;
}

export interface RuntimeTaskEventMirrorRow {
	payload: string;
}

const APPROVAL_REQUIRED_RUNNER_TASKS = new Set(["browser.open"]);
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

export function safeCapabilities(value: unknown): unknown[] {
	return Array.isArray(value)
		? value.filter((item) => typeof item === "string").slice(0, 50)
		: [];
}

export function runtimeResponse(row: RuntimeRow) {
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

export function safeParseArray(value: string): unknown[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ error: "Value could not be serialized" });
	}
}

export function parsePayload(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return {};
	}
}

export function taskTimestamp(value: unknown): string {
	return typeof value === "string" && value.trim()
		? value
		: new Date().toISOString();
}

export function taskId(value: Record<string, unknown>): string | null {
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

export async function mirrorRuntimeTask(
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

export async function mirrorRuntimeTasks(
	env: Env,
	instanceId: string,
	userId: string,
	payload: unknown,
): Promise<void> {
	const tasks = runtimeTasksFromPayload(payload);
	await Promise.all(tasks.map((task) => mirrorRuntimeTask(env, instanceId, userId, task)));
}

export async function mirroredRuntimeTasks(
	env: Env,
	instanceId: string,
	userId: string,
	limit = 200,
): Promise<unknown[]> {
	const { results } = await env.DB.prepare(
		`SELECT payload FROM instance_runtime_tasks
     WHERE instance_id = ?1 AND user_id = ?2 AND hidden = 0
     ORDER BY updated_at DESC
     LIMIT ?3`,
	)
		.bind(instanceId, userId, limit)
		.all<RuntimeTaskMirrorRow>();
	return results.map((row) => parsePayload(row.payload));
}

export async function mirroredRuntimeTask(
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

export async function deleteMirroredRuntimeTask(
	env: Env,
	instanceId: string,
	userId: string,
	id: string,
): Promise<void> {
	// Tombstone (not DELETE): the runner re-sends its tasks on the next poll, so a
	// deleted row reappears. hidden=1 keeps it out of the board permanently.
	await env.DB.prepare(
		"UPDATE instance_runtime_tasks SET hidden = 1 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(id, instanceId, userId)
		.run();
}

/** Remove all finished (failed/completed/cancelled) mirrored tasks for an instance. */
export async function clearFinishedRuntimeTasks(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<number> {
	// Tombstone (not DELETE) so the runner's re-sent copies stay off the board.
	const res = await env.DB.prepare(
		"UPDATE instance_runtime_tasks SET hidden = 1 WHERE instance_id = ?1 AND user_id = ?2 AND hidden = 0 AND status IN ('failed','completed','cancelled','blocked','expired')",
	)
		.bind(instanceId, userId)
		.run();
	return res.meta?.changes ?? 0;
}

/**
 * When a runner (re)registers, any task that was mid-flight on the PREVIOUS
 * session is orphaned — its browser page / takeover session died with the old
 * process and can never be resumed. Mark those (needs_human / running) as failed
 * so they drop out of the live board instead of lingering as stale "Needs you"
 * cards forever. Returns how many were expired.
 */
export async function expireOrphanedRuntimeTasks(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<number> {
	const { results } = await env.DB.prepare(
		// Job-application tasks are driven by a DURABLE Cloudflare Workflow, not the
		// runner process — they survive a runner reconnect (flaky tunnel / WiFi blip),
		// and the workflow owns their lifecycle + its own handoff timeout. So they are
		// NOT orphaned by a re-register and must NOT be expired here, or a network blip
		// would kill a live "needs_human" apply task mid-takeover.
		`SELECT id, payload FROM instance_runtime_tasks
     WHERE instance_id = ?1 AND user_id = ?2 AND status IN ('needs_human', 'running')
       AND type != 'job.apply_agent'`,
	)
		.bind(instanceId, userId)
		.all<RuntimeTaskMirrorRow>();
	if (!results.length) return 0;
	const now = new Date().toISOString();
	const reason =
		"Runner reconnected — this paused task was orphaned (its browser session is gone). Re-run it to try again.";
	let expired = 0;
	for (const row of results) {
		const task = parsePayload(row.payload);
		if (!isRecord(task)) continue;
		// Workflow-driven apply tasks survive a runner reconnect — never expire them.
		if (task.type === "job.apply_agent") continue;
		task.status = "failed";
		task.error = reason;
		task.updatedAt = now;
		task.completedAt = now;
		await mirrorRuntimeTask(env, instanceId, userId, task);
		expired += 1;
	}
	return expired;
}

export async function mirrorRuntimeEvent(
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

export async function mirrorSyntheticTaskEvent(
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

export async function mirrorTaskLifecycleEvents(
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

export async function mirrorRuntimeEvents(
	env: Env,
	instanceId: string,
	userId: string,
	payload: unknown,
): Promise<void> {
	const events = runtimeEventsFromPayload(payload);
	await Promise.all(events.map((event) => mirrorRuntimeEvent(env, instanceId, userId, event)));
}

export async function mirroredRuntimeEvents(
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

export function syntheticEventsFromTasks(tasks: unknown[]): unknown[] {
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

export function runtimeErrorPayload(payload: unknown): string {
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

export async function requireOwnedInstance(
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

export async function getRuntime(
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

export async function requireRuntime(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<RuntimeRow> {
	const runtime = await getRuntime(env, instanceId, userId);
	if (!runtime) throw new HttpError(404, "Runtime not registered");
	return runtime;
}

export async function encodeRuntimeToken(env: Env, token: string | undefined): Promise<{
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

export async function decodeRuntimeToken(env: Env, row: RuntimeRow): Promise<string | null> {
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

export async function callRuntime(
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

export async function runtimeJson(res: Response): Promise<unknown> {
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

export function runtimeStatus(res: Response, okStatus: number): ContentfulStatusCode {
	return (res.ok ? okStatus : Math.max(400, Math.min(599, res.status))) as ContentfulStatusCode;
}

export async function updateRuntimeStatus(
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

