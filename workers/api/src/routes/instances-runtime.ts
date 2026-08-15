import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError } from "../lib/auth.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import { normalizeRunnerNode, relayNameForInstance, type RuntimeRow } from "../lib/runtime-nodes.js";
import { getBoundRunnerConn } from "../lib/runner-client.js";
import { isOrphanedByRunnerReconnect, ORPHANABLE_TASK_TYPES, orphanedTaskReason } from "../lib/runtime-task-ownership.js";
export { normalizeRunnerNode, relayNameForInstance } from "../lib/runtime-nodes.js";
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

export type { RuntimeRow } from "../lib/runtime-nodes.js";

export interface RuntimeRegistrationBody {
	endpointUrl: string;
	token?: string;
	placement?: "local" | "managed";
	capabilities?: unknown[];
	runnerVersion?: string;
	runnerNode?: string;
	/** Stable per-machine id, minted once by the CLI and persisted beside its session (#379).
	 *  Absent from every older CLI, which is why nothing may depend on it being present. */
	machineId?: string;
	/** Hostnames THIS machine has answered to while running the CLI — the backfill that
	 *  reconnects a pin already stranded on a name the machine has stopped using. */
	machineNames?: unknown;
}

export const UPSERT_INSTANCE_RUNTIME_SQL = `INSERT INTO instance_runtimes (
       instance_id, user_id, placement, endpoint_url,
       token_ciphertext, token_dek_wrapped, token_iv, token_plaintext,
       capabilities, runner_version, runner_node, status, last_seen_at, created_at, updated_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'registered', datetime('now'), datetime('now'), datetime('now'))
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
       runner_node = excluded.runner_node,
       status = 'registered',
       last_seen_at = datetime('now'),
       updated_at = datetime('now')`;

export const UPSERT_INSTANCE_RUNTIME_NODE_SQL = `INSERT INTO instance_runtime_nodes (
       instance_id, user_id, runner_node, placement, endpoint_url,
       token_ciphertext, token_dek_wrapped, token_iv, token_plaintext,
       capabilities, runner_version, machine_id, status, last_seen_at, created_at, updated_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'registered', datetime('now'), datetime('now'), datetime('now'))
     ON CONFLICT(instance_id, runner_node) DO UPDATE SET
       user_id = excluded.user_id,
       placement = excluded.placement,
       endpoint_url = excluded.endpoint_url,
       token_ciphertext = excluded.token_ciphertext,
       token_dek_wrapped = excluded.token_dek_wrapped,
       token_iv = excluded.token_iv,
       token_plaintext = excluded.token_plaintext,
       capabilities = excluded.capabilities,
       runner_version = excluded.runner_version,
       -- COALESCE, not excluded (#379): an OLDER CLI sends no machine id, and it must not erase
       -- the identity a newer one recorded for the same machine. Losing it would silently strand
       -- every pin that resolves through this row the next time the hostname moved.
       machine_id = COALESCE(excluded.machine_id, instance_runtime_nodes.machine_id),
       status = 'registered',
       last_seen_at = datetime('now'),
       updated_at = datetime('now')`;

export interface RunnerTaskBody {
	type: string;
	input?: Record<string, unknown>;
	/** Optional card presentation for the console kanban. */
	title?: string;
	subtitle?: string;
	description?: string;
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
const RUNTIME_SETUP_TASK_TYPE = "setup.pags_browser_runtime";

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

export { d1Timestamp, runtimeNodeResponse, runtimeResponse, safeParseArray } from "../lib/runtime-response.js";

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

export function runtimeSetupTaskId(instanceId: string): string {
	return `${instanceId}:setup:pags-browser-runtime`;
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

export function runtimeSetupTask(
	instanceId: string,
	now = new Date().toISOString(),
): Record<string, unknown> {
	return {
		id: runtimeSetupTaskId(instanceId),
		type: RUNTIME_SETUP_TASK_TYPE,
		status: "blocked",
		requiresApproval: false,
		approval: {
			prompt: "Connect the local ProAgentStore browser runtime before creating browser tasks.",
		},
		input: {
			install: "npm i -g @proagentstore/cli",
			// Canonical command: one runner serves ALL your agents (coding + browser).
			connect: "pags up",
		},
		error: "No ProAgentStore browser runtime is registered for this instance.",
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

/**
 * The statuses `clear-finished` sweeps — the ONE place that set is written down (#609).
 *
 * It was a literal inside the SQL, which is why the MCP tool driving this endpoint could publish
 * `(done/failed/cancelled)` for six months: `done` is not a `TaskStatus` member and never was, and
 * nothing could compare the sentence to the filter because the filter was not a value anything
 * could read. `workers/mcp/src/state-vocabulary.ts` derives its published vocabulary from THIS
 * array (parsed from source — the MCP worker is a separate deployable) and goes red on drift.
 *
 * `blocked` is deliberately absent: it means the agent is waiting on the user, so it counts as
 * active. A fourth member, `expired`, went in #611: nothing emits it (both functions NAMED for
 * expiry write `failed`) and the legacy rows #609 kept it for do not exist — a production census
 * found none. The test pins this array as `readonly TaskStatus[]`, so it cannot come back.
 */
export const CLEARED_RUNTIME_TASK_STATUSES = ["failed", "completed", "cancelled"] as const;

/** Remove all finished (failed/completed/cancelled) mirrored tasks for an instance. */
export async function clearFinishedRuntimeTasks(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<number> {
	// Tombstone (not DELETE) so the runner's re-sent copies stay off the board.
	// Built from the constant above rather than typed into the SQL, the same shape
	// `expireOrphanedRuntimeTasks` uses for `ORPHANABLE_TASK_TYPES` a few lines below.
	const placeholders = CLEARED_RUNTIME_TASK_STATUSES.map((_, i) => `?${i + 3}`).join(", ");
	const res = await env.DB.prepare(
		`UPDATE instance_runtime_tasks SET hidden = 1
     WHERE instance_id = ?1 AND user_id = ?2 AND hidden = 0 AND status IN (${placeholders})`,
	)
		.bind(instanceId, userId, ...CLEARED_RUNTIME_TASK_STATUSES)
		.run();
	return res.meta?.changes ?? 0;
}

/**
 * When a runner (re)registers, a task the DEAD PROCESS was itself running is orphaned — its
 * Playwright page / takeover session went with the process and can never be resumed. Mark those
 * failed so they drop out of the live board instead of lingering as stale "Needs you" cards
 * forever. Returns how many were expired.
 *
 * ## What it may touch, and why that is an allowlist now (#567)
 *
 * This named its EXCEPTIONS for most of its life, and the exception list drifted three times —
 * each drift silently killing a card type nobody had thought about. The production case: a live
 * coding session was failed and stamped `completedAt`, then ran for two more hours and made 15
 * irreversible pushes to `origin main`; a standing-policy card was failed with the same sentence,
 * for a policy that deliberately has no actuator. Both were told their browser session was gone.
 * Neither was a browser session.
 *
 * `ORPHANABLE_TASK_TYPES` inverts it: only work the runner process itself was executing is
 * sweepable, so an unclassified card type is left alone rather than destroyed. The SQL filter and
 * the per-row guard are both built from that one array — those two ARE what drifted first.
 */
export async function expireOrphanedRuntimeTasks(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<number> {
	const placeholders = ORPHANABLE_TASK_TYPES.map((_, i) => `?${i + 3}`).join(", ");
	const { results } = await env.DB.prepare(
		`SELECT id, payload FROM instance_runtime_tasks
     WHERE instance_id = ?1 AND user_id = ?2 AND status IN ('needs_human', 'running')
       AND type IN (${placeholders})`,
	)
		.bind(instanceId, userId, ...ORPHANABLE_TASK_TYPES)
		.all<RuntimeTaskMirrorRow>();
	if (!results.length) return 0;
	const now = new Date().toISOString();
	let expired = 0;
	for (const row of results) {
		const task = parsePayload(row.payload);
		if (!isRecord(task)) continue;
		const type = String(task.type ?? "");
		// The same predicate as the SQL, applied to the PAYLOAD's type. The column and the payload
		// are written together by `mirrorRuntimeTask`, but a row whose payload disagrees with its
		// column must fall to the safe side rather than be expired on the column's word.
		if (!isOrphanedByRunnerReconnect(type)) continue;
		task.status = "failed";
		task.error = orphanedTaskReason(type);
		task.updatedAt = now;
		// Deliberately NOT `completedAt`. That field is what the board and every reader treat as
		// "this finished at" (`isCodingCardOpen` states the rule), and the sweep does not know when
		// the work stopped — only when it gave up looking. Writing `now` put a completion time on a
		// task two hours before its last act.
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

/**
 * The event stream of ONE ticket, oldest→newest. The instance-wide reader above is
 * newest-first over every task, which the ticket thread cannot use: it would have to pull
 * a large window and filter client-side just to be sure it had this ticket's oldest turns
 * (which is exactly what the run-detail page does today, capped at 500 and silently lossy
 * for a long-running ticket). This seeks the `(task_id, created_at)` index instead.
 */
export async function mirroredTaskEvents(
	env: Env,
	instanceId: string,
	userId: string,
	taskIdValue: string,
	limit = 200,
): Promise<unknown[]> {
	const { results } = await env.DB.prepare(
		`SELECT payload FROM instance_runtime_task_events
     WHERE instance_id = ?1 AND user_id = ?2 AND task_id = ?3
     ORDER BY created_at ASC
     LIMIT ?4`,
	)
		.bind(instanceId, userId, taskIdValue, limit)
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
	const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
	return {
		type,
		input: isRecord(value.input) ? value.input : {},
		title: str(value.title, 200),
		subtitle: str(value.subtitle, 200),
		description: str(value.description, 500),
		requiresApproval,
		approvalPrompt: typeof value.approvalPrompt === "string"
			? value.approvalPrompt.slice(0, 500)
			: requiresApproval
				? `Approve task ${type}`
				: undefined,
	};
}

/**
 * Stamp this machine's id onto the rows left behind by the hostnames it used to wear (#379).
 *
 * Without this, the identity column only ever helps machines that have not renamed themselves YET
 * — every pin already stranded on a dead name would stay stranded forever, because that dead
 * name's row has no id and never will (the machine no longer registers under it). The claim is
 * what migrates the existing rows into the new identity.
 *
 * Three things keep it safe, and all three matter:
 *   - the names come from the machine's OWN record of hostnames it has actually run under, so it
 *     can never claim a name it has not been;
 *   - `machine_id IS NULL` — a row another machine has already claimed is never taken over;
 *   - `user_id` scoping — one account's machines only, like every other tenant-scoped read here.
 */
export async function claimMachineNames(
	env: Env,
	userId: string,
	machineId: string,
	names: readonly string[],
): Promise<number> {
	if (!machineId || !names.length) return 0;
	const placeholders = names.map((_, i) => `?${i + 3}`).join(",");
	const res = await env.DB.prepare(
		`UPDATE instance_runtime_nodes SET machine_id = ?1
     WHERE user_id = ?2 AND (machine_id IS NULL OR machine_id = '') AND runner_node IN (${placeholders})`,
	)
		.bind(machineId, userId, ...names)
		.run();
	return res.meta?.changes ?? 0;
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

export async function getRuntimeNode(
	env: Env,
	instanceId: string,
	userId: string,
	runnerNode: string,
): Promise<RuntimeRow | null> {
	const node = normalizeRunnerNode(runnerNode);
	if (!node) return null;
	return env.DB.prepare(
		"SELECT * FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3",
	)
		.bind(instanceId, userId, node)
		.first<RuntimeRow>();
}

export async function listRuntimeNodes(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<RuntimeRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC",
	)
		.bind(instanceId, userId)
		.all<RuntimeRow>();
	return results ?? [];
}

export async function getRuntimeForNode(
	env: Env,
	instanceId: string,
	userId: string,
	runnerNode?: string | null,
): Promise<RuntimeRow | null> {
	const node = normalizeRunnerNode(runnerNode);
	if (node) return (await getRuntimeNode(env, instanceId, userId, node)) ?? null;
	return getRuntime(env, instanceId, userId);
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

/**
 * Like requireRuntime, but resolves the row for the machine that is LIVE right now (pin-aware,
 * relay-checked) instead of the stale `instance_runtimes` default row. Anything that actually
 * DISPATCHES to the runner (apply task creation, human-takeover proxies, generic task CRUD)
 * must use this: the default row is overwritten by the newest `pags up` and never cleared on
 * disconnect, so `callRuntime` on it targets the wrong (often dead) machine's RelayDO — while
 * the JobApplyWorkflow drives via getBoundRunnerConn. This keeps both sides on the SAME node,
 * which is what lets a human actually solve a captcha the workflow paused on. 503 if none live.
 */
/**
 * The runtime row for the runner that is ACTUALLY connected, or null.
 *
 * The non-throwing half of the pair, mirroring getRuntime/requireRuntime. Reads and
 * best-effort writes need "the live node if there is one, otherwise serve the mirror" — with
 * only the throwing variant they reached for `getRuntime`, which returns the DEFAULT row.
 * That row is not cleared on disconnect, so on a multi-machine account it can name a machine
 * that went away while the task actually runs on another node's relay (#218).
 */
export async function getLiveRuntime(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<RuntimeRow | null> {
	const conn = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
	if (!conn) return null;
	return conn.runnerNode
		? await getRuntimeNode(env, instanceId, userId, conn.runnerNode)
		: await getRuntime(env, instanceId, userId);
}

export async function requireLiveRuntime(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<RuntimeRow> {
	const conn = await getBoundRunnerConn(env, instanceId, userId);
	const row = conn
		? conn.runnerNode
			? await getRuntimeNode(env, instanceId, userId, conn.runnerNode)
			: await getRuntime(env, instanceId, userId)
		: null;
	if (!row) throw new HttpError(503, "No runner connected. Start it with: pags up");
	return row;
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
	// Fail closed: this is the runner/relay auth token — every other vault path
	// stores nothing when the KEK is absent rather than persisting a secret in the
	// clear. In prod the KEK is set, so refuse instead of writing plaintext.
	if (!env.KEY_ENCRYPTION_KEY) {
		throw new Error("KEY_ENCRYPTION_KEY is not configured; refusing to store runtime token unencrypted");
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
	if (!env.RELAY) throw new Error("RELAY binding not configured");
	const stub = env.RELAY.get(env.RELAY.idFromName(relayNameForInstance(row.instance_id, row.runner_node)));
	const relayBody = init.body
		? typeof init.body === "string" ? JSON.parse(init.body) : init.body
		: undefined;
	const method = (typeof init.method === "string" ? init.method : "GET").toUpperCase();
	return stub.fetch(new Request("https://relay/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ method, path, body: relayBody }),
	}));
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
	runnerNode?: string | null,
): Promise<void> {
	const node = normalizeRunnerNode(runnerNode);
	// `last_seen_at` means "when we last heard from this runner", and only that. It used to advance
	// on EVERY write including `offline` — so the moment we concluded a machine was gone we also
	// recorded having just heard from it, and `heartbeatFresh` read the row as live for the next
	// 90 seconds. A stored `offline` out-ranks the derivation so the published status survived it,
	// but `lastSeenAt` itself is shown to the user and fed to `diagnoseAttachment`, and it was a
	// timestamp of our own conclusion rather than of any contact (#587).
	const seen = status === "offline" ? "" : ", last_seen_at = datetime('now')";
	if (node) {
		await env.DB.prepare(
			`UPDATE instance_runtime_nodes
       SET status = ?1${seen}, updated_at = datetime('now')
       WHERE instance_id = ?2 AND user_id = ?3 AND runner_node = ?4`,
		)
			.bind(status, instanceId, userId, node)
			.run();
	}
	// Node-SCOPED, when the caller knows which machine it heard from (#587). This UPDATE carried no
	// node filter while the one above did, and `instance_runtimes` is a SHARED row holding the LAST
	// REGISTRANT's `runner_node`, `runner_version` and `capabilities` — so one machine's heartbeat
	// refreshed the row's liveness while another machine's identity stayed on it. Not stale: two
	// machines BLENDED. Measured 2026-08-15, two instances reported `RLs-MacBook-Air.local` online
	// with `coding.repo-write` ten hours after it left, while the live Mac mini lacked that
	// capability — a run dispatched on that reading fails for a reason the status screen denies.
	//
	// `runner_node = ''` is the pre-0030 default: a registration that never said which machine it
	// was, and the only candidate row. Without that clause every pre-0030 row goes unheard-from.
	const scope = node ? " AND (runner_node = ?4 OR runner_node = '')" : "";
	const stmt = env.DB.prepare(
		`UPDATE instance_runtimes
     SET status = ?1${seen}, updated_at = datetime('now')
     WHERE instance_id = ?2 AND user_id = ?3${scope}`,
	);
	await (node ? stmt.bind(status, instanceId, userId, node) : stmt.bind(status, instanceId, userId)).run();
}
