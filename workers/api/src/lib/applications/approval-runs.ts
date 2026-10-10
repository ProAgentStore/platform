/** Read the full terminal runner record before exposing a submission-decision action. */
import type { Env } from "../../types.js";
import type { JobApplication } from "../local-artifact/store.js";
import { type ApplyRun, getApplyRun } from "../local-apply/store.js";

export async function approvalRuns(env: Env, uid: string, runners: string[], apps: JobApplication[]): Promise<Map<string, ApplyRun | null>> {
	const out = new Map<string, ApplyRun | null>();
	for (const app of apps) {
		if (!app.fillRunId || !["blocked", "awaiting_review"].includes(app.status)) continue;
		let run: ApplyRun | null = null;
		for (const runner of runners) {
			run = await getApplyRun(env, runner, uid, app.fillRunId).catch(() => null);
			if (run) break;
		}
		out.set(app.id, run);
	}
	return out;
}
