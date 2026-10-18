/**
 * The pin-scoped runner reconciliation PLAN (#1113, slice 2): desired state against what GitHub holds, as an
 * ordered list of operations — the part of the live loop where #1113's mutual exclusion is actually enforced.
 *
 * Pure. It talks to nothing: the executor that performs these operations through the GitHub App (runner groups,
 * the `PAGS_RUNNER` variable, run cancel / re-run) needs App permissions the owner has not granted yet
 * (docs/runner-self-hosted-design.md §1, follow-up issues). What is fixed here is WHAT that executor must do and
 * in WHAT ORDER, so the rules hold the day it is switched on:
 *
 *   • **One machine per repo.** A private, pinned repo belongs to exactly ONE runner group — its pinned machine's
 *     (`pags-<node>`). Every other group that can reach it loses it, and a repo found in more than one group is a
 *     VIOLATION: reported, and fixed in the same plan.
 *   • **Private only.** A public or internal repo is never added, and one found in any group is removed and reported.
 *   • **Ordered re-pin.** Every removal comes first, then every `PAGS_RUNNER` write, then every addition — so at no
 *     instant can two machines' runners both pick up a repo's job ((1) remove from the old group, (2) set the
 *     variable, (3) add to the new group).
 *   • **Stale queued runs.** A run still queued on labels that are no longer the repo's route is cancelled and
 *     re-dispatched, so the old machine runs nothing for that repo.
 *   • **Offline pinned machine.** A self-hosted route to a machine that is offline goes back to GitHub-hosted when
 *     minutes remain; when none remain the route stays (the jobs queue for the machine) and the owner is alerted —
 *     never queued silently.
 *
 * Idempotent: run against the state its own operations produced, it plans nothing.
 */
import { GITHUB_HOSTED_LABEL, isPinScoped, type MinutesState, type RepoVisibility, type RunnerDirective, selectRunnerLabel } from "./runner-routing.js";
import type { StartFailure } from "./github-actions.js";

export interface DesiredRepo {
	/** `owner/name`. */
	repo: string;
	visibility: RepoVisibility | string;
	/** The machine the repo's Coder is pinned to, by canonical node name; null when unpinned. */
	pinnedNode: string | null;
	/** Of the repo's org. */
	minutes?: MinutesState;
	/** A recent run's #1112 start-failure classification, if any. */
	failureReason?: Pick<StartFailure, "classification"> | null;
}

export interface ActualState {
	/** Each machine's runner group → the repos it can reach today. */
	groupAccess: Record<string, readonly string[]>;
	/** Each repo's current `PAGS_RUNNER` value (raw JSON); absent/null = unset (GitHub-hosted by the workflow default). */
	variables: Record<string, string | null | undefined>;
	/** Runs still queued, with the labels they asked for. */
	queuedRuns: ReadonlyArray<{ repo: string; runId: number; labels: readonly string[] }>;
	/** Machines whose runner is online now. */
	onlineNodes: ReadonlySet<string>;
}

export type ReconcileOp =
	| { op: "remove_repo_from_group"; node: string; repo: string; why: "unpinned" | "pinned_elsewhere" | "not_private" | "violation" }
	| { op: "set_variable"; repo: string; value: string; mode: RunnerDirective["mode"]; reason: string }
	| { op: "add_repo_to_group"; node: string; repo: string }
	| { op: "cancel_and_redispatch"; repo: string; runId: number; staleLabels: readonly string[] }
	| { op: "alert"; repo: string; message: string };

export interface ReconcilePlan {
	ops: ReconcileOp[];
	/** Breaches found in the ACTUAL state — each one is also fixed by `ops`, and must be alerted on. */
	violations: Array<{ repo: string; kind: "multiple_machines" | "public_repo_in_group" | "generic_route"; detail: string }>;
}

/** The route a repo should have now, with the pinned machine's availability taken into account. */
export function desiredRoute(r: DesiredRepo, onlineNodes: ReadonlySet<string>): { directive: RunnerDirective; alert?: string } {
	const directive = selectRunnerLabel({ visibility: r.visibility, pinnedNode: r.pinnedNode, minutes: r.minutes, failureReason: r.failureReason });
	if (directive.mode !== "self-hosted" || !r.pinnedNode || onlineNodes.has(r.pinnedNode)) return { directive };
	// The pinned machine is offline. GitHub-hosted if any minutes remain; otherwise wait for the machine, and say so.
	if (!r.minutes?.exhausted) {
		return { directive: { mode: "github-hosted", labels: [GITHUB_HOSTED_LABEL], variableValue: JSON.stringify(GITHUB_HOSTED_LABEL), reason: "default" }, alert: `${r.pinnedNode} is offline, so ${r.repo}'s jobs run on GitHub-hosted runners while minutes remain.` };
	}
	return { directive, alert: `${r.repo}'s jobs are waiting for ${r.pinnedNode}, which is offline, and the org's GitHub Actions minutes are exhausted. Bring the machine back (\`pags up\`) or raise the spending limit.` };
}

function parseLabels(value: string | null | undefined): string[] | null {
	if (!value) return null;
	try {
		const v = JSON.parse(value) as unknown;
		if (typeof v === "string") return [v];
		return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
	} catch {
		return null;
	}
}

const sameLabels = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Plan the operations that bring GitHub to the desired state — removals, then variables, then additions, then stale runs. */
export function planReconciliation(desired: readonly DesiredRepo[], actual: ActualState): ReconcilePlan {
	const removals: ReconcileOp[] = [];
	const variables: ReconcileOp[] = [];
	const additions: ReconcileOp[] = [];
	const runs: ReconcileOp[] = [];
	const alerts: ReconcileOp[] = [];
	const violations: ReconcilePlan["violations"] = [];

	const reachedBy = (repo: string) => Object.entries(actual.groupAccess).filter(([, repos]) => repos.includes(repo)).map(([node]) => node);
	const known = new Set(desired.map((d) => d.repo));

	for (const d of desired) {
		const isPrivate = d.visibility === "private";
		const target = isPrivate && d.pinnedNode ? d.pinnedNode : null;
		const holders = reachedBy(d.repo);
		if (holders.length > 1) violations.push({ repo: d.repo, kind: "multiple_machines", detail: `${d.repo} is reachable by the runners of ${holders.join(", ")}` });
		if (!isPrivate && holders.length) violations.push({ repo: d.repo, kind: "public_repo_in_group", detail: `${d.repo} is ${d.visibility || "not private"} but is in the runner group of ${holders.join(", ")}` });
		for (const node of holders) {
			if (node === target) continue;
			const why = !isPrivate ? "not_private" : holders.length > 1 && target && holders.includes(target) ? "violation" : !target ? "unpinned" : "pinned_elsewhere";
			removals.push({ op: "remove_repo_from_group", node, repo: d.repo, why });
		}

		const { directive, alert } = desiredRoute(d, actual.onlineNodes);
		const current = parseLabels(actual.variables[d.repo]);
		if (current && !sameLabels(current, [GITHUB_HOSTED_LABEL]) && !isPinScoped(current)) {
			violations.push({ repo: d.repo, kind: "generic_route", detail: `${d.repo}'s PAGS_RUNNER routes on ${JSON.stringify(current)}, which no single machine owns` });
		}
		const effective = current ?? [GITHUB_HOSTED_LABEL];
		if (!sameLabels(effective, directive.labels)) variables.push({ op: "set_variable", repo: d.repo, value: directive.variableValue, mode: directive.mode, reason: directive.reason });
		if (alert) alerts.push({ op: "alert", repo: d.repo, message: alert });

		if (target && !holders.includes(target)) additions.push({ op: "add_repo_to_group", node: target, repo: d.repo });

		for (const run of actual.queuedRuns) {
			if (run.repo === d.repo && !sameLabels(run.labels, directive.labels)) runs.push({ op: "cancel_and_redispatch", repo: d.repo, runId: run.runId, staleLabels: run.labels });
		}
	}

	// A repo in a group that no desired repo names (its Coder is gone): nobody pins it, so nobody may run it.
	for (const [node, repos] of Object.entries(actual.groupAccess)) {
		for (const repo of repos) if (!known.has(repo)) removals.push({ op: "remove_repo_from_group", node, repo, why: "unpinned" });
	}

	return { ops: [...removals, ...variables, ...additions, ...runs, ...alerts], violations };
}
