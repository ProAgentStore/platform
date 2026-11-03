import type { Env } from "../types.js";

/** Close the durable task even when its runner disconnected; never overwrite an owner cancellation. */
export async function closeFailedBrowserTask(env: Pick<Env, "DB">, key: { taskId: string; instanceId: string; userId: string }, error: string): Promise<void> {
	const row = await env.DB.prepare("SELECT payload FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(key.taskId, key.instanceId, key.userId).first<{ payload: string }>();
	if (!row) return;
	let payload: Record<string, unknown> = {};
	try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* A corrupt payload still needs a terminal status. */ }
	const now = new Date().toISOString();
	payload = { ...payload, id: key.taskId, status: "failed", error, updatedAt: now, completedAt: now };
	await env.DB.prepare(`UPDATE instance_runtime_tasks SET status = 'failed', payload = ?4, updated_at = datetime('now')
		WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status NOT IN ('cancelled', 'completed', 'failed')`)
		.bind(key.taskId, key.instanceId, key.userId, JSON.stringify(payload)).run();
}

/** Called only after the runner acknowledged /browser/resume; a stale mirror must not block the next action. */
export async function markBrowserTaskResumed(env: Pick<Env, "DB">, key: { taskId: string; instanceId: string; userId: string }): Promise<void> {
	const row = await env.DB.prepare("SELECT status, payload FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(key.taskId, key.instanceId, key.userId).first<{ status: string; payload: string }>();
	if (row?.status === "running") return;
	if (row?.status !== "needs_human") throw new Error("The browser task cannot resume from its current state.");
	const payload = { ...JSON.parse(row.payload) as Record<string, unknown>, status: "running", updatedAt: new Date().toISOString() };
	const changed = await env.DB.prepare(`UPDATE instance_runtime_tasks SET status = 'running', payload = ?4, updated_at = datetime('now')
		WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'needs_human'`)
		.bind(key.taskId, key.instanceId, key.userId, JSON.stringify(payload)).run();
	if (changed.meta.changes !== 1) throw new Error("The browser task changed while resuming; no further action was dispatched.");
}
