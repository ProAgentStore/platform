import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import { compareCliVersions } from "../machine-identity.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import { LOCAL_APPLY_OWNER_PAUSE_PATH } from "./handoff-contract.js";
import { syncApplyRun } from "./apply.js";
import type { ApplyRun } from "./store.js";

export const OWNER_PAUSE_MIN_CLI = "0.4.225";

/** Explicit owner action only: never inferred from viewing a frame or opening replay history. */
export async function pauseApplicationForOwner(env: Env, userId: string, instanceId: string, run: ApplyRun): Promise<ApplyRun> {
	const version = compareCliVersions(run.runnerVersion ?? "", OWNER_PAUSE_MIN_CLI);
	if (version === null || version < 0) throw new HttpError(409, `Pausing AI dispatch for owner control requires CLI ${OWNER_PAUSE_MIN_CLI} or later. This run cannot safely be taken over.`);
	const app = await getOwnedApplication(env, userId, run.applicationId);
	if (!app || app.fillRunId !== run.id) throw new HttpError(409, "This application is no longer bound to that exact Runner run.");
	if (run.status !== "running" && !(run.status === "paused" && run.pause?.reason === "owner_requested")) throw new HttpError(409, "Only a running application or its existing owner pause can be taken over.");
	const runtime = await getLiveRuntime(env, instanceId, userId).catch(() => null);
	if (!runtime) throw new HttpError(409, "The Runner is disconnected; no owner control was opened.");
	const liveVersion = compareCliVersions(runtime.runner_version ?? "", OWNER_PAUSE_MIN_CLI);
	if (liveVersion === null || liveVersion < 0) throw new HttpError(409, `The connected Runner must support owner pause with CLI ${OWNER_PAUSE_MIN_CLI} or later.`);
	const res = await callRuntime(env, runtime, LOCAL_APPLY_OWNER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ runId: run.id, applicationId: run.applicationId, browserProfile: run.policy.browserProfile }) }).catch(() => null);
	if (!res) throw new HttpError(409, "The Runner did not confirm native dispatch settlement. Owner control is unavailable; check the run before retrying.");
	const body = await runtimeJson(res) as { error?: unknown };
	if (!res.ok) {
		await syncApplyRun(env, userId, run).catch(() => run);
		throw new HttpError(409, typeof body.error === "string" ? body.error.slice(0, 500) : "The Runner could not safely pause native dispatch. Owner control is unavailable.");
	}
	const paused = await syncApplyRun(env, userId, run);
	if (paused.status !== "paused" || paused.pause?.reason !== "owner_requested" || !paused.pause.handoffRequestId) throw new HttpError(409, "The Runner did not confirm the exact owner pause; no owner control was opened.");
	return paused;
}
