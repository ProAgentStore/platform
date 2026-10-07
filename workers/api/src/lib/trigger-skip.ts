/**
 * "⏭️ Scheduled run skipped" — said once per (trigger, reason) window, for every scheduled action
 * that needs the owner's machine (#172 `run_browse`, #962 `run_local_browser`). One sentence, one
 * dedupe key and one deep link for both, so the two cannot drift in how they tell the owner.
 */
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { deepLinkFor } from "./console-links.js";
import { runnerSkipMessage } from "./trigger-capability.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

export type TriggerSkipReason = "offline" | "busy";

export async function notifyTriggerSkip(
	env: Env,
	target: { id?: string; name: string; instance_id: string; user_id: string },
	why: TriggerSkipReason,
): Promise<void> {
	// #358: the offline text used to name `pags up` unconditionally. For an agent whose
	// capabilities declare no runtime that is a false remedy — `pags up` skips it — so the
	// message is derived from what the agent actually declares.
	const caps = why === "offline" ? await capabilitiesForInstance(env, target.instance_id, target.user_id).catch(() => null) : null;
	await notifyUser(
		env,
		target.user_id,
		"trigger",
		"⏭️ Scheduled run skipped",
		why === "offline" ? runnerSkipMessage(target.name, caps) : `${target.name}: a run is already in progress; skipping this one.`,
		deepLinkFor({ kind: "triggers", instanceId: target.instance_id }),
		// Keyed on (trigger, condition), so a five-minute cron whose runner stayed offline all
		// afternoon says so once per window instead of once per tick. A synthetic target (a manual
		// run) carries no id — fall back to the instance so the key is still about a THING.
		{ key: `trigger-skip:${target.id ?? target.instance_id}:${why}`, instanceId: target.instance_id },
	).catch(() => undefined);
}
