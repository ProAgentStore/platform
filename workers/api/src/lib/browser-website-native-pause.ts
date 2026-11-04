/** Native task pause observation does not dispatch or resume a browser action. */
import type { Env } from "../types.js";
import { browserWebsiteBlock, markWebsiteWait, type BrowserWebsiteBlock } from "./browser-website-state.js";
import { deepLinkFor } from "./console-links.js";
import { ensureWebsiteAccessRequest } from "./website-access.js";

export type NativeTask = Record<string, unknown>;
export function nativePause(task: NativeTask): (BrowserWebsiteBlock & { pauseKey: string }) | null {
	if (task.type !== "browser.open" || task.status !== "needs_human") return null;
	const block = browserWebsiteBlock(task.output);
	if (block?.decision !== "ask") return null;
	const pauseKey = (block as BrowserWebsiteBlock & { pauseKey?: unknown }).pauseKey;
	if (typeof pauseKey !== "string" || !pauseKey || pauseKey.length > 200) throw new Error("Native website pause has no valid opaque key");
	return { ...block, pauseKey };
}

/** Mirroring records a question, never accepts one or dispatches a browser action. */
export async function mirrorNativeWebsitePause(env: Env, instanceId: string, userId: string, task: NativeTask): Promise<void> {
	const pause = nativePause(task);
	if (!pause || typeof task.id !== "string") return;
	const owned = await env.DB.prepare("SELECT id FROM instance_runtime_tasks WHERE id=?1 AND instance_id=?2 AND user_id=?3 AND type='browser.open' AND status='needs_human'").bind(task.id, instanceId, userId).first();
	if (!owned) return;
	const request = await ensureWebsiteAccessRequest(env, { userId, instanceId, subjectKind: "runtime_task", subjectId: task.id, hostname: pause.hostname, pauseKey: pause.pauseKey, subjectLink: deepLinkFor({ kind: "task", instanceId, taskId: task.id }) });
	await markWebsiteWait(env, { userId, instanceId, taskId: task.id, pauseKey: pause.pauseKey }, request);
}
