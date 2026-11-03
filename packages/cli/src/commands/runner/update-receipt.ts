import { deferredUpdateLease, supervisorNote, type DeferredUpdateLease, type UpdatePlan } from "./self-update.js";
import { BoundExpired, type InstallBridgeResult } from "./update-bridge.js";

type InstallPlan = Extract<UpdatePlan, { action: "update" }>;
type WaitingPlan = Extract<UpdatePlan, { action: "wait" }>;
interface UpdateReceiptDeps {
	run: (plan: InstallPlan, automatic: boolean, lease?: DeferredUpdateLease) => Promise<InstallBridgeResult>;
	defer: (lease: DeferredUpdateLease) => boolean;
	/** Schedule exit after the reply has left the relay, never exit synchronously. */
	restart: (plan: InstallPlan) => void;
}

/** Preserve the bridge's actual admission result in the machine receipt (#1453). */
export async function answerPlannedUpdate(plan: InstallPlan | WaitingPlan, body: unknown, deps: UpdateReceiptDeps): Promise<{ status: number; result: Record<string, unknown> }> {
	const wait = (waiting: WaitingPlan, installedVersion?: string | null) => {
		const lease = deferredUpdateLease(body);
		const prepared = installedVersion ? { installedVersion } : {};
		if (!lease) return { status: 400, result: { ...prepared, waitingFor: waiting.waitingFor, error: "A busy runner_update needs a current operation lease; no delayed restart was scheduled." } };
		if (!deps.defer(lease)) return { status: 409, result: { ...prepared, error: "A runner update is already waiting for active work to finish." } };
		return { status: 200, result: { ...waiting, ...prepared, operationId: lease.operationId, deferredUntil: lease.expiresAt, detail: "This operation may restart only before its recorded lease expires; no delayed restart survives an expired or terminal operation." } };
	};
	if (plan.action === "wait") return wait(plan);
	const lease = deferredUpdateLease(body);
	const request = body as { operationId?: unknown; deferUntil?: unknown } | null | undefined;
	if (!lease && (request?.operationId !== undefined || request?.deferUntil !== undefined)) {
		return { status: 200, result: { action: "refused", current: plan.current, latest: plan.latest, reason: "The supplied operation lease is expired or invalid; nothing was installed or restarted." } };
	}
	let outcome: InstallBridgeResult;
	try {
		outcome = await deps.run(plan, false, lease ?? undefined);
	} catch (e) {
		return { status: e instanceof BoundExpired ? 504 : 500, result: { error: e instanceof BoundExpired ? e.message : `Runner update could not complete for ${plan.latest}: ${e instanceof Error ? e.message : String(e)}` } };
	}
	if (outcome.kind === "in-flight") return { status: 409, result: { error: "A runner update is already installing or restarting." } };
	if (outcome.kind === "work-active") return wait({ action: "wait", current: plan.current, latest: plan.latest, waitingFor: outcome.waitingFor }, outcome.installedVersion);
	if (outcome.kind !== "restarting") {
		const reasons = {
			"lease-expired": "The operation lease expired; no delayed restart was performed.",
			"policy-unavailable": "The owner policy could not be confirmed; nothing restarted.",
			"policy-disabled": "Automatic updates were disabled by the owner; nothing restarted.",
			"fleet-updating": "Another machine is updating first; nothing restarted.",
		};
		return { status: 200, result: { action: "refused", current: plan.current, latest: plan.latest, installedVersion: outcome.installedVersion, reason: reasons[outcome.kind] } };
	}
	deps.restart(plan);
	const supervisor = supervisorNote(plan.restarter);
	return { status: 200, result: { action: "restarting", current: plan.current, latest: plan.latest, restartedBy: plan.restarter, ...(supervisor ? { supervisor } : {}) } };
}
