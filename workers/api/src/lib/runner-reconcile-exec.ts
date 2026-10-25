/**
 * The EXECUTOR of the runner reconciliation plan (#1211, #1113 slice 2 → follow-up 5): performs what `planReconciliation` ordered,
 * in that order, through injected GitHub operations.
 *
 * The topology is the owner's Free-plan choice (#1210, 2026-10-21: "no GitHub plan upgrade"): GitHub Free has ONE runner group
 * per org, so there is no per-machine group to add a repo to or remove it from. Exclusion is by LABEL alone — `PAGS_RUNNER` is
 * always `["self-hosted","pags-<node>"]`, so only the pinned machine's runner can match a job. The group operations in the plan
 * are therefore reported `skipped` with that reason, never faked; the ordered, mutual-exclusion-relevant steps that remain are the
 * variable write and the cancel-and-redispatch of runs still queued on a stale label.
 *
 *   • A variable write that is `denied` (the App lacks the permission, #1207) or fails ends that REPO's work: its stale runs are not
 *     re-dispatched onto a route that was not set.
 *   • GitHub-hosted is the variable REMOVED (the workflows fall back to their own pin, #1214), never the plan's `"ubuntu-latest"`.
 *   • One op failing never stops another repo's.
 */
import type { RouteSyncDeps } from "./runner-routing-sync.js";
import { writeRouteVariable } from "./runner-routing-sync.js";
import type { RunnerRoutingMode } from "./runner-routing.js";
import type { ReconcileOp, ReconcilePlan } from "./runner-reconcile.js";

export interface ExecDeps {
	/** GitHub access for ONE repo: the App installation of the user who owns it. */
	mintFor: (repo: string) => Pick<RouteSyncDeps, "installationToken" | "fetch">;
	/** Is the variable currently set on this repo (decides create vs update)? */
	variableExists: (repo: string) => Promise<boolean>;
	/** Cancel a queued run, then re-run it so it reads the CURRENT route. */
	cancelAndRerun: (repo: string, runId: number) => Promise<void>;
	/** Tell the owner. Deduped by the implementation. */
	alert: (repo: string, message: string) => Promise<void>;
	/** A route changed: trace and notify (RouteSyncDeps.onFlip's job). */
	onRouteChange: (change: { repo: string; to: RunnerRoutingMode; value: string | null; reason: string }) => Promise<void>;
}

export type OpOutcome = { op: ReconcileOp; status: "done" | "skipped" | "denied" | "failed"; detail?: string };

export const GROUPLESS_REASON = "this org is on the GitHub Free plan, which has no per-machine runner groups; exclusion is by the pinned machine's label (#1210)";

/**
 * The plan without its group operations. With no per-machine groups there is nothing to add a repo to or remove it from, so
 * `planReconciliation` — which plans an addition for every pinned repo not in a group — would plan the same additions on every
 * sweep and never be idle. Dropping them keeps a sweep over settled state empty (idempotent) and the trace free of noise.
 */
export function withoutGroupOps(plan: ReconcilePlan): ReconcilePlan {
	return { ...plan, ops: plan.ops.filter((o) => o.op !== "add_repo_to_group" && o.op !== "remove_repo_from_group") };
}

export async function executePlan(plan: ReconcilePlan, deps: ExecDeps): Promise<OpOutcome[]> {
	const out: OpOutcome[] = [];
	const blocked = new Set<string>();
	for (const op of plan.ops) {
		try {
			switch (op.op) {
				case "remove_repo_from_group":
				case "add_repo_to_group":
					out.push({ op, status: "skipped", detail: GROUPLESS_REASON });
					break;
				case "set_variable": {
					const value = op.mode === "self-hosted" ? op.value : null; // hosted = unset
					const written = await writeRouteVariable(op.repo, value, await deps.variableExists(op.repo), deps.mintFor(op.repo));
					if ("denied" in written) {
						blocked.add(op.repo);
						out.push({ op, status: "denied", detail: written.denied });
						break;
					}
					await deps.onRouteChange({ repo: op.repo, to: op.mode, value, reason: op.reason });
					out.push({ op, status: "done" });
					break;
				}
				case "cancel_and_redispatch":
					if (blocked.has(op.repo)) {
						out.push({ op, status: "skipped", detail: "the route was not changed, so the run is left where it is" });
						break;
					}
					await deps.cancelAndRerun(op.repo, op.runId);
					out.push({ op, status: "done" });
					break;
				case "alert":
					await deps.alert(op.repo, op.message);
					out.push({ op, status: "done" });
					break;
			}
		} catch (e) {
			if (op.op === "set_variable") blocked.add(op.repo);
			out.push({ op, status: "failed", detail: e instanceof Error ? e.message : String(e) });
		}
	}
	// A violation the plan found is alerted on even though its fix is in the ops: the owner learns it happened.
	for (const v of plan.violations) {
		try {
			await deps.alert(v.repo, `${v.detail} (fixed)`);
		} catch {
			// An undelivered alert is not a reason to fail the sweep.
		}
	}
	return out;
}
