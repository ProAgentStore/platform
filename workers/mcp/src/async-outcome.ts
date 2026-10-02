import { authedCall, type McpEnv } from "./http.js";

export type AsyncRecovery = {
	tool: string;
	possibleOutcomes: string[];
	poll: { tool: string; input: Record<string, unknown> };
	retry?: { tool: string; input: Record<string, unknown> };
	timeoutMs?: number;
};

/** A lost reply does not prove a machine-side write failed. Never retry the write here. */
export async function authedAsyncCall(
	path: string,
	token: string,
	opts: RequestInit,
	env: McpEnv,
	recovery: AsyncRecovery,
): Promise<unknown> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let apiStatus: number | undefined;
	let deadlineExceeded = false;
	try {
		const result = await Promise.race([
			authedCall(path, token, { ...opts, signal: controller.signal }, env, (response) => { apiStatus = response.status; }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					deadlineExceeded = true;
					reject(new Error("confirmation deadline exceeded"));
					controller.abort();
				}, recovery.timeoutMs ?? 20_000);
			}),
		]);
		// A gateway can lose its upstream reply after the write landed. Application
		// refusals on other HTTP statuses retain their original error payloads.
		if (apiStatus === 502 || apiStatus === 504) throw new Error("upstream confirmation lost");
		return result;
	} catch {
		return {
			outcome: "unknown",
			confirmation: {
				reason: deadlineExceeded ? "deadline-exceeded" : apiStatus === 502 || apiStatus === 504 ? "gateway-error" : "transport-error",
				...(apiStatus !== undefined ? { httpStatus: apiStatus } : {}),
			},
			tool: recovery.tool,
			possibleOutcomes: recovery.possibleOutcomes,
			poll: recovery.poll,
			...(recovery.retry ? { retry: recovery.retry } : {}),
			detail: `The operation's reply could not be confirmed. It may not have started, may still be in flight, or may have completed. Poll ${recovery.poll.tool} before deciding whether to retry; a lost reply does not prove failure.`,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
