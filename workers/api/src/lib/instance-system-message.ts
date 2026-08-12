/**
 * Append a system/status line to an instance's chat thread.
 *
 * The channel is the AgentDO's `/system-message` handler, and this is the one place that spells the
 * request. It was written out twice — once in `routes/instances-chat.ts` for the console, once
 * inside `workflows/coding-session.ts` for the Pilot's own progress lines — which is two copies of
 * a URL, a method and a header set that have to agree with the DO forever.
 *
 * It THROWS on failure, deliberately. The route has to answer the caller honestly; the workflow
 * swallows at its own call site, because there the thread is a record and never the work.
 */
import type { Env } from "../types.js";

export async function postSystemMessage(env: Env, instanceId: string, content: string): Promise<void> {
	const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
	await stub.fetch(
		new Request("https://agent/system-message", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		}),
	);
}
