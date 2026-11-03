import type { Env } from "../types.js";

export class BrowserActionUncertainError extends Error {
	constructor(message = "This browser action was dispatched but its durable result is unavailable. It will not be repeated; check the site's state before retrying.") {
		super(message);
		this.name = "BrowserActionUncertainError";
	}
}

/** At most one remote action per durable workflow step, even if the isolate dies after the click. */
export async function dispatchBrowserActionOnce<T>(
	env: Pick<Env, "DB">,
	key: { taskId: string; instanceId: string; userId: string; step: string },
	dispatch: () => Promise<T>,
): Promise<T> {
	// Use the task's existing durable audit store. No raw args, page text, credentials or images.
	const id = `browser-action:${key.taskId}:${key.step}`;
	const event = {
		id,
		taskId: key.taskId,
		type: "browser.action.claimed",
		message: "Browser action reserved; execution result is unverified.",
		data: { step: key.step, result: "unverified" },
		createdAt: new Date().toISOString(),
	};
	const claimed = await env.DB.prepare(`INSERT OR IGNORE INTO instance_runtime_task_events
		(id, instance_id, user_id, task_id, type, payload, created_at)
		SELECT ?1, ?2, ?3, ?4, 'browser.action.claimed', ?5, datetime('now')
		FROM instance_runtime_tasks WHERE id = ?4 AND instance_id = ?2 AND user_id = ?3
		AND status = 'running'`)
		.bind(id, key.instanceId, key.userId, key.taskId, JSON.stringify(event)).run();
	if (claimed.meta.changes !== 1) {
		const prior = await env.DB.prepare("SELECT 1 AS present FROM instance_runtime_task_events WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(id, key.instanceId, key.userId).first();
		if (prior) throw new BrowserActionUncertainError();
		throw new BrowserActionUncertainError("The browser task is not active for this owner; no action was dispatched.");
	}
	try {
		return await dispatch();
	} catch {
		// A lost response cannot tell "failed before click" from "clicked, then disconnected".
		throw new BrowserActionUncertainError();
	}
}

/** An old runner's broad supported flag does not prove the dispatch-time safety gate exists. */
export function requireSafeBrowserDispatch(receipt: { commitGuard?: { dispatchSafe?: boolean } } | undefined): void {
	if (receipt?.commitGuard?.dispatchSafe !== true) throw new Error("Update this browser runner to CLI 0.4.200 or newer before running applications: dispatch-time safety enforcement was not confirmed.");
}
