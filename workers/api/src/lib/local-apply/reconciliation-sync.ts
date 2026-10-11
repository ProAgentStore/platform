/**
 * Durable cron consumer for Runner-owned reconciliation deadlines.  This is deliberately not a
 * Console-read side effect: closing an owner mobile tab must not leave its browser lease live or a
 * terminal timeout only in the Runner's process memory.  An offline relay is not evidence, so the
 * requested record remains unresolved until its exact Runner reports a bounded terminal result.
 */
import type { Env } from "../../types.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import { LOCAL_APPLY_RECONCILIATION_STATUS_PATH, type LocalApplyReconciliationStatus } from "./contract.js";
import {
	activeLocalApplyReconciliations,
	getApplyRun,
	getLocalApplyReconciliation,
	recordLocalApplyReconciliationProof,
} from "./store.js";

export async function syncActiveApplyReconciliations(env: Env, limit = 25, now = Date.now()): Promise<number> {
	let synced = 0;
	for (const item of await activeLocalApplyReconciliations(env, limit)) {
		const [run, app] = await Promise.all([
			getApplyRun(env, item.instanceId, item.userId, item.runId),
			getOwnedApplication(env, item.userId, item.applicationId),
		]);
		if (!run || !app) continue;
		const runtime = await getLiveRuntime(env, item.instanceId, item.userId).catch(() => null);
		if (!runtime) continue;
		const res = await callRuntime(env, runtime, LOCAL_APPLY_RECONCILIATION_STATUS_PATH, {
			method: "POST", body: JSON.stringify({ reconciliationId: item.id }),
		}).catch(() => null);
		if (!res?.ok) continue;
		const status = await runtimeJson(res) as LocalApplyReconciliationStatus;
		if (status.reconciliationId !== item.id || status.runId !== run.id || status.applicationId !== app.id || status.state !== "ended" || !status.result) continue;
		const reconciliation = await getLocalApplyReconciliation(env, run.id, item.instanceId, item.userId);
		if (!reconciliation) continue;
		await recordLocalApplyReconciliationProof(env, {
			reconciliation, app, run, userId: item.userId, state: status.result.state,
			proofKind: status.result.proofKind, actor: "runner",
		}, now);
		synced++;
	}
	return synced;
}
