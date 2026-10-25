/**
 * The runner reconciliation sweep (#1211): gather what SHOULD be (every pinned Coder's private repos and its machine) and what IS
 * (each repo's `PAGS_RUNNER`, the runs queued on a label, which machines are online), plan with `planReconciliation`, and — in
 * `apply` mode — execute with `executePlan`. Idempotent: a second sweep over the state the first produced plans nothing.
 *
 * Off by default. `RUNNER_RECONCILE` is "plan" (compute and trace, change nothing) or "apply"; anything else does nothing. Writes need
 * the App's Variables permission accepted on the org (#1207); until then a repo's write is `denied`, named, and changes nothing.
 *
 * Which repos are swept: those of every pinned instance, plus the other known repos of the same orgs — so a repo whose Coder was
 * unpinned (and so left the pinned set) is still found and its stale route removed. An org with no pinned repo is never touched.
 */
import { createNotification } from "../routes/notifications.js";
import type { Env } from "../types.js";
import { type ExecDeps, executePlan, type OpOutcome, withoutGroupOps } from "./runner-reconcile-exec.js";
import { type ActualState, type DesiredRepo, planReconciliation, type ReconcilePlan } from "./runner-reconcile.js";
import { type MintDeps } from "./actions-runner-provision.js";
import { logEvent } from "./events.js";
import { listRepos } from "./coding-store.js";
import { readOrgMinutes, readRouteVariable } from "./runner-routing-sync.js";
import { resolveRunnerPin } from "./runtime-nodes.js";
import { installationTokenForOwner } from "./github-app.js";
import { safeFetch } from "./ssrf.js";
import { sqlTime } from "./sql-time.js";
import type { MinutesState } from "./runner-routing.js";

export type ReconcileMode = "off" | "plan" | "apply";

export function reconcileMode(env: Pick<Env, "RUNNER_RECONCILE">): ReconcileMode {
	const v = (env.RUNNER_RECONCILE ?? "").trim().toLowerCase();
	return v === "plan" || v === "apply" ? v : "off";
}

/** A machine that reported within this long is online for routing. */
export const ONLINE_WITHIN_MS = 3 * 60_000;
/** At most this many queued runs per repo are examined per sweep. */
const MAX_QUEUED_RUNS = 20;

export interface SweepDeps {
	/** GitHub access as one user's App installation: the token for an org is that user's to resolve. */
	forUser: (userId: string) => MintDeps;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

export interface SweepResult {
	mode: ReconcileMode;
	repos: number;
	plan: ReconcilePlan | null;
	outcomes: OpOutcome[];
	/** Repos that could not be read (the App lacks a permission, say) and were left alone, with why. */
	unreadable: Array<{ repo: string; detail: string }>;
	/** A repo pinned to more than one machine: left unrouted, and the owner told. */
	conflicts: Array<{ repo: string; nodes: string[] }>;
}

const ghHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ProAgentStore" });

interface Pinned {
	repo: string;
	userId: string;
	instanceId: string;
	node: string | null;
}

/** Every repo of every pinned instance, with its pin; and the other known repos of the same orgs, unpinned. */
export async function gatherRepos(env: Env): Promise<{ repos: Pinned[]; conflicts: Array<{ repo: string; nodes: string[] }> }> {
	const rows =
		(
			await env.DB.prepare(
				`SELECT id, user_id, config FROM agent_instances
				  WHERE json_valid(config) AND (json_extract(config, '$.runnerMachineId') IS NOT NULL OR json_extract(config, '$.runnerNode') IS NOT NULL)
				  LIMIT 500`,
			).all<{ id: string; user_id: string; config: string | null }>()
		).results ?? [];
	const byRepo = new Map<string, Pinned[]>();
	for (const r of rows) {
		const node = (await resolveRunnerPin(env, r.user_id, r.config)).node || null;
		for (const repo of await listRepos(env, r.id, r.user_id)) {
			if (!repo.githubRepo) continue;
			byRepo.set(repo.githubRepo, [...(byRepo.get(repo.githubRepo) ?? []), { repo: repo.githubRepo, userId: r.user_id, instanceId: r.id, node }]);
		}
	}
	const conflicts: Array<{ repo: string; nodes: string[] }> = [];
	const repos: Pinned[] = [];
	for (const [repo, pins] of byRepo) {
		const nodes = [...new Set(pins.map((p) => p.node).filter((n): n is string => !!n))];
		if (nodes.length > 1) {
			conflicts.push({ repo, nodes });
			repos.push({ ...pins[0], node: null }); // pinned to several machines: no single machine may take it
		} else repos.push({ ...pins[0], node: nodes[0] ?? null });
	}
	// The same orgs' other repos: a repo whose Coder was unpinned must still have its stale route found.
	const orgs = [...new Set(repos.map((r) => r.repo.split("/")[0]))];
	for (const org of orgs) {
		const more = (await env.DB.prepare("SELECT DISTINCT github_repo, user_id, instance_id FROM coding_repos WHERE github_repo LIKE ?1 LIMIT 500").bind(`${org}/%`).all<{ github_repo: string; user_id: string; instance_id: string }>()).results ?? [];
		for (const m of more) if (!byRepo.has(m.github_repo) && !repos.some((r) => r.repo === m.github_repo)) repos.push({ repo: m.github_repo, userId: m.user_id, instanceId: m.instance_id, node: null });
	}
	return { repos, conflicts };
}

async function visibilityOf(repo: string, deps: MintDeps): Promise<string> {
	const token = await deps.installationToken(repo.split("/")[0]);
	if (!token) return "unknown";
	const res = await deps.fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) });
	const v = res.ok ? ((await res.json().catch(() => null)) as { visibility?: unknown } | null)?.visibility : null;
	return typeof v === "string" ? v : "unknown";
}

/** Queued runs of a repo and the labels their (first) job asked for. */
async function queuedRuns(repo: string, deps: MintDeps): Promise<Array<{ repo: string; runId: number; labels: string[] }>> {
	const token = await deps.installationToken(repo.split("/")[0]);
	if (!token) return [];
	const res = await deps.fetch(`https://api.github.com/repos/${repo}/actions/runs?status=queued&per_page=${MAX_QUEUED_RUNS}`, { headers: ghHeaders(token) });
	if (!res.ok) return [];
	const runs = ((await res.json().catch(() => null)) as { workflow_runs?: Array<{ id?: number }> } | null)?.workflow_runs ?? [];
	const out: Array<{ repo: string; runId: number; labels: string[] }> = [];
	for (const run of runs) {
		if (typeof run.id !== "number") continue;
		const jr = await deps.fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs?per_page=1`, { headers: ghHeaders(token) });
		const jobs = jr.ok ? (((await jr.json().catch(() => null)) as { jobs?: Array<{ labels?: unknown }> } | null)?.jobs ?? []) : [];
		const labels = Array.isArray(jobs[0]?.labels) ? (jobs[0].labels as unknown[]).filter((l): l is string => typeof l === "string") : [];
		if (labels.length) out.push({ repo, runId: run.id, labels });
	}
	return out;
}

async function onlineNodes(env: Env, now: number): Promise<Set<string>> {
	const since = sqlTime(now - ONLINE_WITHIN_MS);
	const rows = (await env.DB.prepare("SELECT DISTINCT runner_node FROM instance_runtime_nodes WHERE last_seen_at >= ?1").bind(since).all<{ runner_node: string }>()).results ?? [];
	return new Set(rows.map((r) => r.runner_node));
}

/** Gather, plan, and (in apply mode) execute. Never throws: a sweep that fails is logged and reported, not retried in a loop. */
export async function sweepRunnerRoutes(env: Env, deps: SweepDeps, mode: ReconcileMode = reconcileMode(env)): Promise<SweepResult> {
	const empty: SweepResult = { mode, repos: 0, plan: null, outcomes: [], unreadable: [], conflicts: [] };
	if (mode === "off") return empty;
	const { repos, conflicts } = await gatherRepos(env);
	const unreadable: SweepResult["unreadable"] = [];
	const minutesByOrg = new Map<string, Promise<MinutesState>>();
	const desired: DesiredRepo[] = [];
	const variables: ActualState["variables"] = {};
	const queued: ActualState["queuedRuns"][number][] = [];
	const owners = new Map<string, { userId: string; instanceId: string }>();
	for (const r of repos) {
		owners.set(r.repo, { userId: r.userId, instanceId: r.instanceId });
		const gh = deps.forUser(r.userId);
		const current = await readRouteVariable(r.repo, gh).catch((e) => ({ denied: e instanceof Error ? e.message : "unreadable" }));
		if ("denied" in current) {
			unreadable.push({ repo: r.repo, detail: current.denied });
			continue;
		}
		variables[r.repo] = current.value;
		const org = r.repo.split("/")[0];
		if (!minutesByOrg.has(org)) minutesByOrg.set(org, readOrgMinutes(org, gh).then((m) => m.minutes).catch(() => ({})));
		desired.push({ repo: r.repo, visibility: await visibilityOf(r.repo, gh), pinnedNode: r.node, minutes: await (minutesByOrg.get(org) as Promise<MinutesState>) });
		queued.push(...(await queuedRuns(r.repo, gh).catch(() => [])));
	}
	const plan = withoutGroupOps(planReconciliation(desired, { groupAccess: {}, variables, queuedRuns: queued, onlineNodes: await onlineNodes(env, deps.now()) }));
	const result: SweepResult = { mode, repos: repos.length, plan, outcomes: [], unreadable, conflicts };
	await logEvent(env, { source: "runner", event: "runner_reconcile.sweep", message: `${mode}: ${repos.length} repos, ${plan.ops.length} operations, ${plan.violations.length} violations, ${unreadable.length} unreadable`, context: { mode, opCount: plan.ops.length, ops: plan.ops.filter((_, i) => i < 50).map((o) => `${o.op}:${"repo" in o ? o.repo : ""}`), opsTruncated: plan.ops.length > 50, violations: plan.violations.map((v) => v.kind) } });
	if (mode === "apply") result.outcomes = await executePlan(plan, liveExecDeps(env, deps, owners));
	for (const c of conflicts) await tell(env, owners.get(c.repo), c.repo, `${c.repo} is pinned to more than one machine (${c.nodes.join(", ")}), so no machine takes its CI until one pin is removed.`);
	return result;
}

function liveExecDeps(env: Env, deps: SweepDeps, owners: Map<string, { userId: string; instanceId: string }>): ExecDeps {
	const gh = (repo: string) => deps.forUser(owners.get(repo)?.userId ?? "");
	return {
		mintFor: gh,
		variableExists: async (repo) => {
			const v = await readRouteVariable(repo, gh(repo));
			return "value" in v && v.value !== null;
		},
		cancelAndRerun: async (repo, runId) => {
			const g = gh(repo);
			const token = await g.installationToken(repo.split("/")[0]);
			if (!token) throw new Error(`The ProAgentStore GitHub App is not installed on ${repo.split("/")[0]}.`);
			const base = `https://api.github.com/repos/${repo}/actions/runs/${runId}`;
			const cancel = await g.fetch(`${base}/cancel`, { method: "POST", headers: ghHeaders(token) });
			if (!cancel.ok && cancel.status !== 409) throw new Error(`GitHub returned ${cancel.status} cancelling run ${runId}`);
			// A run can be re-run only once it has finished cancelling.
			for (let i = 0; i < 5; i++) {
				const state = await g.fetch(base, { headers: ghHeaders(token) });
				if (state.ok && ((await state.json().catch(() => null)) as { status?: string } | null)?.status === "completed") break;
				await deps.sleep(2000);
			}
			const rerun = await g.fetch(`${base}/rerun`, { method: "POST", headers: ghHeaders(token) });
			if (!rerun.ok) throw new Error(`GitHub returned ${rerun.status} re-running run ${runId}`);
		},
		alert: (repo, message) => tell(env, owners.get(repo), repo, message),
		onRouteChange: async (c) => {
			const o = owners.get(c.repo);
			await logEvent(env, { source: "runner", event: "runner_routing.flip", userId: o?.userId ?? null, instanceId: o?.instanceId ?? null, message: `${c.repo} → ${c.to}`, context: { ...c } });
			await tell(env, o, c.repo, c.to === "self-hosted" ? `${c.repo}'s CI moved to your pinned machine (${c.reason}).` : `${c.repo}'s CI is back on GitHub-hosted runners.`, "update");
		},
	};
}

/** A short stable digest of the WHOLE message, so two alerts that differ only late in the text do not share a dedupe key. */
function fingerprint(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** One owner notification; the dedupe key keeps a repeated condition from notifying on every sweep. */
async function tell(env: Env, owner: { userId: string; instanceId: string } | undefined, repo: string, message: string, kind: "alert" | "update" = "alert"): Promise<void> {
	if (!owner) return;
	await createNotification(env.DB, owner.userId, "runner_reconcile", `${repo}: CI routing`, message, undefined, undefined, { kind, dedupeKey: `runner-reconcile:${repo}:${fingerprint(message)}`, instanceId: owner.instanceId });
}

/** The cron entry: live GitHub access through the App, never throws. */
export async function runRunnerReconcile(env: Env): Promise<SweepResult> {
	const mode = reconcileMode(env);
	if (mode === "off") return { mode, repos: 0, plan: null, outcomes: [], unreadable: [], conflicts: [] };
	const deps: SweepDeps = {
		forUser: (userId) => ({ installationToken: (owner) => installationTokenForOwner(env, userId, owner), fetch: (url, init) => safeFetch(url, init) }),
		now: Date.now,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	};
	return sweepRunnerRoutes(env, deps, mode);
}
