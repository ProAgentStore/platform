/**
 * The `run_local_browser` trigger action (#962): start a local CLI browser research run on a
 * schedule — the thing a `local_browser` agent such as Job Search Scout could only do by hand.
 *
 * It goes through `startLocalBrowserRun`, the same path as the owner's Start button, so a scheduled
 * run is held to the same policy, consent and `maxConcurrent` claim. As with `run_browse` (#172), the
 * owner's machine not being ready this tick — no runner, or a run already going — is a SKIP that is
 * recorded and told once, never a trigger failure; a run the agent can never make (not a local
 * browser agent, an unrunnable policy, a runner too old) IS one, and counts.
 */
import type { Env } from "../../types.js";
import { notifyTriggerSkip } from "../trigger-skip.js";
import { startLocalBrowserRun } from "./start.js";

/** Codes a run ends with when the machine was simply not there to take it. */
const NOT_READY = new Set(["runner_offline", "runner_unreachable"]);

export async function runLocalBrowserTrigger(
	env: Env,
	target: { id?: string; name: string; instance_id: string; user_id: string },
	objective: string,
): Promise<Record<string, unknown>> {
	const out = await startLocalBrowserRun(env, target.instance_id, target.user_id, { objective, requestId: crypto.randomUUID(), source: "trigger" });
	if (out.kind === "refused") throw new Error(out.error);
	if (out.kind === "at_capacity") {
		await notifyTriggerSkip(env, target, "busy");
		return { skipped: true, reason: "a run is already in progress", objective };
	}
	const run = out.run;
	if (run.status === "failed" && run.errorCode && NOT_READY.has(run.errorCode)) {
		await notifyTriggerSkip(env, target, "offline");
		return { skipped: true, reason: "runner offline", runId: run.id, objective };
	}
	if (run.status === "failed") throw new Error(run.error || `local browser run failed (${run.errorCode ?? "unknown"})`);
	return { runId: run.id, status: run.status, objective };
}
