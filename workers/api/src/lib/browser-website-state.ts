/** Receipt validation and durable pause markers, independent of workflow execution. */
import type { Env } from "../types.js";
import type { WebsiteAccessRequest } from "./website-access.js";

export interface BrowserWebsiteBlock {
	decision: "ask" | "deny";
	hostname: string;
	url: string;
	mode: "ask_once" | "allowlist";
	/** A dispatched action is not evidence that it succeeded, and must never be replayed. */
	actionDispatched: boolean;
}
export interface BrowserWebsiteReply { websiteAccess?: BrowserWebsiteBlock }

/** Only the authenticated runner's typed receipt is authority; page text cannot create a request. */
export function browserWebsiteBlock(value: unknown): BrowserWebsiteBlock | null {
	if (!value || typeof value !== "object" || !("websiteAccess" in value)) return null;
	const raw = (value as BrowserWebsiteReply).websiteAccess;
	if (!raw) return null;
	if ((raw.decision !== "ask" && raw.decision !== "deny") || (raw.mode !== "ask_once" && raw.mode !== "allowlist") || typeof raw.hostname !== "string" || typeof raw.url !== "string" || typeof raw.actionDispatched !== "boolean") throw new Error("Invalid browser website-access receipt; no continuation is permitted.");
	const url = new URL(raw.url);
	if (!/^https?:$/.test(url.protocol) || url.hostname !== raw.hostname || (raw.decision === "ask" && raw.mode !== "ask_once")) throw new Error("Invalid browser website-access destination; no continuation is permitted.");
	return raw;
}

export type TaskKey = { instanceId: string; userId: string; taskId: string };
const markerId = (taskId: string) => `website-wait:${taskId}`;

/** A dedicated API-owned event survives runner task mirroring and binds one current pause. */
export async function markWebsiteWait(env: Env, key: TaskKey & { pauseKey: string }, request: WebsiteAccessRequest): Promise<void> {
	const event = { id: markerId(key.taskId), taskId: key.taskId, type: "browser.website_wait", message: `Waiting for website permission: ${request.hostname}. ${request.questionUrl}`, data: { requestId: request.id, pauseKey: key.pauseKey, hostname: request.hostname, questionUrl: request.questionUrl, active: true }, createdAt: new Date().toISOString() };
	await env.DB.prepare(`INSERT INTO instance_runtime_task_events (id,instance_id,user_id,task_id,type,payload,created_at)
		SELECT ?1,?2,?3,?4,'browser.website_wait',?5,datetime('now') FROM instance_runtime_tasks
		WHERE id=?4 AND instance_id=?2 AND user_id=?3 AND status IN ('running','needs_human')
		ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at`)
		.bind(event.id, key.instanceId, key.userId, key.taskId, JSON.stringify(event)).run();
}

export async function isCurrentGenericWebsiteRequest(env: Pick<Env, "DB">, userId: string, request: WebsiteAccessRequest): Promise<boolean> {
	if (request.subjectKind !== "runtime_task") return false;
	const row = await env.DB.prepare(`SELECT e.payload FROM instance_runtime_task_events e JOIN instance_runtime_tasks t ON t.id=e.task_id AND t.instance_id=e.instance_id AND t.user_id=e.user_id
		WHERE e.id=?1 AND e.instance_id=?2 AND e.user_id=?3 AND t.status IN ('running','needs_human')`)
		.bind(markerId(request.subjectId), request.instanceId, userId).first<{ payload: string }>();
	if (!row) return false;
	try {
		const data = (JSON.parse(row.payload) as { data?: { requestId?: string; pauseKey?: string; active?: boolean } }).data;
		return data?.active === true && data.requestId === request.id && data.pauseKey === request.pauseKey;
	} catch { return false; }
}

export async function clearWebsiteWait(env: Env, key: TaskKey & { pauseKey: string }, request: WebsiteAccessRequest): Promise<void> {
	await env.DB.prepare("UPDATE instance_runtime_task_events SET payload=json_set(payload,'$.data.active',json('false')) WHERE id=?1 AND instance_id=?2 AND user_id=?3 AND json_extract(payload,'$.data.requestId')=?4 AND json_extract(payload,'$.data.pauseKey')=?5")
		.bind(markerId(key.taskId), key.instanceId, key.userId, request.id, key.pauseKey).run();
}
