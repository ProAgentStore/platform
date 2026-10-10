/** The single durable submission-gate reader, shared by board previews and dispatch. */
import type { Env } from "../../types.js";
import type { JobApplication } from "../local-artifact/store.js";
import { type ApplicationRunnerSettings, evaluateSubmitGate } from "./policy.js";
import { applyRunCounts } from "./store.js";
import { usableSubmitAuthorization } from "./one-click-authorization.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export interface SubmitGateCounting {
	excludeRunId?: string;
	machineOnly?: boolean;
	/** The durable #1011 claim required to spend a verified one-click authorization. */
	oneClickRecoveryId?: string;
}

/** The gate's verdict for one application on one Runner — what dispatch and the board both use. */
export async function submitGateFor(env: Env, runnerInstanceId: string, uid: string, app: JobApplication, settings: ApplicationRunnerSettings, now: number, counting: SubmitGateCounting = {}) {
	const lead = (app.lead ?? {}) as { leadUrl?: string; lead?: { title?: string; company?: string; location?: string; match_rationale?: string } };
	const counts = await applyRunCounts(env, runnerInstanceId, uid, now, counting);
	const auth = await usableSubmitAuthorization(env, uid, runnerInstanceId, app, counting.oneClickRecoveryId);
	const gate = evaluateSubmitGate({
		settings,
		approval: auth ? { id: auth.id, usable: true } : null,
		application: {
			profileVersion: app.profileVersion,
			resumeSha: app.resumeArtifact?.sha256 ?? null,
			coverLetterSha: app.coverLetterArtifact?.sha256 ?? null,
			blockReason: app.blockReason,
			submitAttemptedAt: app.submitAttemptedAt,
			leadUrl: str(lead.leadUrl),
			lead: lead.lead ?? {},
		},
		autoSubmitsToday: counts.autoSubmitsToday,
		activeRuns: counts.active,
	});
	return {
		...gate,
		autoSubmitsToday: counts.autoSubmitsToday,
		dailyCap: settings.autoSubmit.dailyCap,
		authorizationId: auth?.id ?? null,
		...(auth?.kind === "verified_one_click" && counting.oneClickRecoveryId ? { recoveryId: counting.oneClickRecoveryId } : {}),
	};
}
