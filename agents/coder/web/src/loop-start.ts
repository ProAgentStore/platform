import { api } from "@proagentstore/sdk/client";
import { type LoopStartAnswer, loopRequestKey, readLoopStart } from "./coding-loop-run";

/** The request key of the last UNCONFIRMED start — what a retry of the same start reuses. */
export type LastLoopStart = { current: { args: string; requestId: string } | null };

/**
 * `POST /loop`, with a request key and its answer read (#929 findings 9 and 10) — the one start
 * both live watchers use. The key is reused only while the same start is unconfirmed, so a retry
 * after a lost reply replays it instead of starting a second run; any definitive answer, including
 * a refusal, frees it. A refusal still throws (the SDK's `ApiError`), as before.
 */
export async function postLoopStart(instanceId: string, args: Record<string, unknown>, last: LastLoopStart): Promise<LoopStartAnswer> {
	const key = loopRequestKey(last.current, JSON.stringify(args));
	last.current = key;
	try {
		const answer = readLoopStart(await api<unknown>(`/v1/instances/${instanceId}/loop`, { method: "POST", body: JSON.stringify({ ...args, requestId: key.requestId }) }));
		if (answer.kind !== "pending") last.current = null;
		return answer;
	} catch (e) {
		if ((e as { status?: unknown } | null)?.status) last.current = null;
		throw e;
	}
}
