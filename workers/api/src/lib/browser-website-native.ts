/** Ordinary browser.open tasks keep their original approval and opaque native pause. */
import type { Env } from "../types.js";
import { clearWebsiteWait, isCurrentGenericWebsiteRequest } from "./browser-website-state.js";
import { callRunner, getBoundRunnerConn, type RunnerConn } from "./runner-client.js";
import { getWebsiteAccessRequest, listWebsiteDomainDecisions, type WebsiteAccessRequest } from "./website-access.js";

import { nativePause, type NativeTask } from "./browser-website-native-pause.js";
export { mirrorNativeWebsitePause } from "./browser-website-native-pause.js";

interface ResumeDeps {
	connect(env: Env, instanceId: string, userId: string): Promise<RunnerConn | null>;
	dispatch(conn: RunnerConn, path: string, body: unknown): Promise<NativeTask>;
	mirror(env: Env, instanceId: string, userId: string, task: NativeTask): Promise<void>;
}
const defaultDeps: ResumeDeps = {
	connect: getBoundRunnerConn,
	dispatch: (conn, path, body) => callRunner<NativeTask>(conn, path, body),
	mirror: async (...args) => { const { mirrorRuntimeTask } = await import("../routes/instances-runtime.js"); await mirrorRuntimeTask(...args); },
};

/** The runner atomically consumes the exact pause key. Post-dispatch navigation is never replayed. */
export async function resumeNativeWebsiteRequest(env: Env, userId: string, request: WebsiteAccessRequest, deps: ResumeDeps = defaultDeps): Promise<{ resumed: boolean; reason: string; settled?: boolean }> {
	const held = { resumed: false, reason: "Permission saved. The original browser task is no longer waiting on this exact website pause; no action was dispatched." };
	if (!(await isCurrentGenericWebsiteRequest(env, userId, request))) return held;
	const row = await env.DB.prepare("SELECT payload FROM instance_runtime_tasks WHERE id=?1 AND instance_id=?2 AND user_id=?3 AND type='browser.open' AND status='needs_human'").bind(request.subjectId, request.instanceId, userId).first<{ payload: string }>();
	if (!row) return held;
	let pause: ReturnType<typeof nativePause>;
	try { pause = nativePause(JSON.parse(row.payload) as NativeTask); } catch { return held; }
	if (!pause || pause.pauseKey !== request.pauseKey || pause.hostname !== request.hostname) return held;
	const answer = await getWebsiteAccessRequest(env, userId, request.instanceId, request.id);
	if (!answer || answer.status === "pending") return held;
	const decision = answer.status === "approved" ? "allow" : "deny";
	if (!(await listWebsiteDomainDecisions(env, userId, request.instanceId)).some((d) => d.hostname === request.hostname && d.decision === decision)) return held;
	const conn = await deps.connect(env, request.instanceId, userId);
	if (!conn) return { resumed: false, reason: "Permission saved. The original task's runner is offline." };
	// Recheck after connection resolution: an owner Stop or a newer pause must win.
	if (!(await isCurrentGenericWebsiteRequest(env, userId, request))) return held;
	const task = await deps.dispatch(conn, `/tasks/${encodeURIComponent(request.subjectId)}/website-access-resume`, { pauseKey: request.pauseKey, websiteDecision: decision });
	if (task.id !== request.subjectId || task.type !== "browser.open") throw new Error("Runner returned another task while resuming website permission");
	await deps.mirror(env, request.instanceId, userId, task);
	const settled = task.status !== "needs_human" || nativePause(task)?.pauseKey !== request.pauseKey;
	if (settled) await clearWebsiteWait(env, { userId, instanceId: request.instanceId, taskId: request.subjectId, pauseKey: request.pauseKey }, request);
	const resumed = decision === "allow" && ["running", "completed"].includes(String(task.status));
	return { resumed, settled, reason: decision === "deny" ? (settled ? "Website access denied; the original browser task was stopped." : "Website denial was saved; the original task has not confirmed it stopped.") : resumed ? "The original browser task continued with the recorded website permission." : "Permission saved. Check the original task's current status before continuing." };
}

/** One host question can be shared by several retained native tasks. Its first subject is
 * history, not the complete set of pauses authorized by the owner's agent/host decision. */
async function currentNativeWebsiteWaiters(env: Env, userId: string, request: WebsiteAccessRequest): Promise<WebsiteAccessRequest[]> {
	const recorded = await getWebsiteAccessRequest(env, userId, request.instanceId, request.id);
	if (!recorded || recorded.hostname !== request.hostname) return [];
	const { results } = await env.DB.prepare(`SELECT t.id,t.payload,e.payload AS marker FROM instance_runtime_tasks t
		JOIN instance_runtime_task_events e ON e.task_id=t.id AND e.instance_id=t.instance_id AND e.user_id=t.user_id
		WHERE t.instance_id=?1 AND t.user_id=?2 AND t.type='browser.open' AND t.status='needs_human'
		AND e.id='website-wait:' || t.id AND e.type='browser.website_wait'
		AND json_extract(e.payload,'$.data.active')=1 AND json_extract(e.payload,'$.data.requestId')=?3
		AND json_extract(e.payload,'$.data.hostname')=?4`)
		.bind(request.instanceId, userId, request.id, recorded.hostname).all<{ id: string; payload: string; marker: string }>();
	const waiters: WebsiteAccessRequest[] = [];
	for (const row of results ?? []) {
		try {
			const pause = nativePause(JSON.parse(row.payload) as NativeTask);
			const marker = JSON.parse(row.marker) as { data?: { pauseKey?: string } };
			if (pause?.hostname === recorded.hostname && pause.pauseKey === marker.data?.pauseKey) waiters.push({ ...recorded, subjectKind: "runtime_task", subjectId: row.id, pauseKey: pause.pauseKey });
		} catch { /* Malformed or stale runner state grants no continuation. */ }
	}
	return waiters;
}

export async function hasCurrentNativeWebsiteWaiters(env: Env, userId: string, request: WebsiteAccessRequest): Promise<boolean> {
	return (await currentNativeWebsiteWaiters(env, userId, request)).length > 0;
}

/** Invoke only from the successful owner-answer callback, never from a read/mirror. Each
 * retained nonce is revalidated by the existing safe resume path and consumed by the runner. */
export async function resumeNativeWebsiteWaiters(env: Env, userId: string, request: WebsiteAccessRequest, opts: { excludeTaskId?: string } = {}, deps: ResumeDeps = defaultDeps): Promise<{ continued: number; denied: number; failed: number }> {
	const waiters = await currentNativeWebsiteWaiters(env, userId, request);
	const counts = { continued: 0, denied: 0, failed: 0 };
	for (const waiter of waiters) {
		if (waiter.subjectId === opts.excludeTaskId) continue;
		try {
			const outcome = await resumeNativeWebsiteRequest(env, userId, waiter, deps);
			if (outcome.resumed) counts.continued++;
			else if (waiter.status === "denied" && outcome.settled) counts.denied++;
			else counts.failed++;
		} catch { counts.failed++; }
	}
	return counts;
}
