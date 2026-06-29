import type { Env } from "../types.js";
import { callRuntime, isRecord, mirrorRuntimeTasks, requireRuntime, runtimeJson } from "./instances-runtime.js";

export interface BrowserRuntimeTaskRequest {
	type: string;
	input: Record<string, unknown>;
}

export interface BrowserRuntimeTaskResult {
	taskId: string;
	payload: unknown;
}

/**
 * Common browser-workflow entry point: create a task on the user's registered
 * runtime, mirror the returned snapshot into PAGS history, and return the task id
 * a durable workflow can drive.
 */
export async function createBrowserRuntimeTask(
	env: Env,
	instanceId: string,
	userId: string,
	request: BrowserRuntimeTaskRequest,
): Promise<BrowserRuntimeTaskResult> {
	const runtime = await requireRuntime(env, instanceId, userId);
	const taskRes = await callRuntime(env, runtime, "/tasks", {
		method: "POST",
		body: JSON.stringify({ type: request.type, input: request.input }),
	});
	const payload = await runtimeJson(taskRes);
	if (!taskRes.ok) throw new Error("the runner rejected the task");
	await mirrorRuntimeTasks(env, instanceId, userId, payload);
	const taskId = isRecord(payload) ? String(payload.id ?? "") : "";
	if (!taskId) throw new Error("the runner did not return a task id");
	return { taskId, payload };
}
