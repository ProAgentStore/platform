import { authedCall, type McpEnv } from "./http.js";

export type AsyncRecovery = {
	tool: string;
	possibleOutcomes: string[];
	poll: { tool: string; input: Record<string, unknown> };
	retry?: { tool: string; input: Record<string, unknown> };
	/** How to settle this particular write, appended to the unknown outcome's `detail`. */
	hint?: string;
	timeoutMs?: number;
};

export type UnknownOutcome = {
	outcome: "unknown";
	confirmation: { reason: "deadline-exceeded" | "gateway-error" | "transport-error"; httpStatus?: number };
	tool: string;
	possibleOutcomes: string[];
	poll: AsyncRecovery["poll"];
	retry?: AsyncRecovery["retry"];
	detail: string;
};

export const isUnknownOutcome = (value: unknown): value is UnknownOutcome =>
	!!value && typeof value === "object" && (value as { outcome?: unknown }).outcome === "unknown";

/**
 * Run a write and either return its answer or say plainly that it is UNKNOWN, with what to poll
 * (#990, #1038). Past the deadline, on a throw, or when `reply()` says the answer was a gateway's and
 * not the write's (`lost`), the caller gets `outcome: "unknown"` — never a failure the write may not
 * have had. `reply().status` is the HTTP status seen, reported with the unknown outcome.
 * A lost reply does not prove a write failed. Never retry the write here.
 */
export async function confirmWithin<T>(
	run: (signal: AbortSignal) => Promise<T>,
	recovery: AsyncRecovery,
	reply?: () => { status?: number; lost?: boolean },
): Promise<T | UnknownOutcome> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deadlineExceeded = false;
	let lost = false;
	try {
		const result = await Promise.race([
			run(controller.signal),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					deadlineExceeded = true;
					reject(new Error("confirmation deadline exceeded"));
					controller.abort();
				}, recovery.timeoutMs ?? 20_000);
			}),
		]);
		if (reply?.().lost) {
			lost = true;
			throw new Error("upstream confirmation lost");
		}
		return result;
	} catch {
		const status = reply?.().status;
		return {
			outcome: "unknown",
			confirmation: {
				reason: deadlineExceeded ? "deadline-exceeded" : lost ? "gateway-error" : "transport-error",
				...(status !== undefined ? { httpStatus: status } : {}),
			},
			tool: recovery.tool,
			possibleOutcomes: recovery.possibleOutcomes,
			poll: recovery.poll,
			...(recovery.retry ? { retry: recovery.retry } : {}),
			detail: `The operation's reply could not be confirmed. It may not have started, may still be in flight, or may have completed. Poll ${recovery.poll.tool} before deciding whether to retry; a lost reply does not prove failure.${recovery.hint ? ` ${recovery.hint}` : ""}`,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** {@link confirmWithin} for one API call. A gateway can lose its upstream reply after the write landed. */
export async function authedAsyncCall(
	path: string,
	token: string,
	opts: RequestInit,
	env: McpEnv,
	recovery: AsyncRecovery,
): Promise<unknown> {
	let apiStatus: number | undefined;
	return confirmWithin(
		(signal) => authedCall(path, token, { ...opts, signal }, env, (response) => { apiStatus = response.status; }),
		recovery,
		// Application refusals on other HTTP statuses retain their original error payloads.
		() => ({ status: apiStatus, lost: apiStatus === 502 || apiStatus === 504 }),
	);
}
