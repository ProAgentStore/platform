/**
 * Default-branch CI and deploy health for the repos a coding instance works on (#903).
 *
 * A coding instance could read perfectly healthy — idle, last run done, nothing running — while its
 * repository's CI on `main` had been red for three pushes. Nothing on the platform looked, so the
 * owner found out by accident. This module is the looking: a bounded cron sweep that reads each
 * repo's recent default-branch workflow runs, keeps the verdict on the `coding_repos` row, tells the
 * owner ONCE when a workflow turns red, and lets the status routes show the verdict beside — never
 * inside — the run's own `health`.
 *
 * TWO DIFFERENT THINGS, kept apart on purpose. `health` (lib/run-health.ts) answers "is this RUN
 * progressing"; this answers "is the REPOSITORY's pipeline green". A red CI does not make a run
 * stalled, and a stalled run does not make CI red. Folding either into the other is the conflation
 * the issue warns about, so this verdict has its own field and its own vocabulary.
 *
 * What counts, stated once:
 *   * only runs on the repo's DEFAULT branch, from `push`, `schedule` or `workflow_run` — a manual
 *     `workflow_dispatch` is somebody's experiment, and a PR run is about the PR;
 *   * per workflow, the newest DECISIVE conclusion decides: `success` is passing; `failure`,
 *     `timed_out` and `startup_failure` are failing. `cancelled`, `skipped`, `neutral`, `stale` and
 *     `action_required` are evidence of nothing (a superseded run, a path filter, an approval gate),
 *     so they are passed over, never counted — the rule `deploy-watch.ts` learned in #359;
 *   * a run still going is PENDING, never failing; it does not hide an earlier decisive failure,
 *     because until it concludes, red is still the last thing the pipeline said;
 *   * a workflow whose last decisive run is older than {@link CI_STALE_AFTER_MS} is dropped — a
 *     deleted or renamed workflow must not stay red forever;
 *   * no token, no access, a rate limit, GitHub down, or a page served from cache while GitHub was
 *     unreachable is UNKNOWN: neither healthy nor failed, and it moves no alert state.
 */
import { deepLinkFor } from "./console-links.js";
import { isDeployWorkflow } from "./deploy-watch.js";
import { logError } from "./error-log.js";
import { fetchWorkflowRuns } from "./github-actions.js";
import { type GithubCacheIdentity, githubConditionalJson, resolveGithubRead } from "./github-cache.js";
import { notificationDedupeKey } from "./notifications.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

/** Repos one sweep may check. Per-minute cron, two conditional reads per repo — the deploy watcher's bound. */
export const CI_HEALTH_BATCH = 20;
/** Default-branch runs read per repo. Enough for every workflow of the last several pushes, still one request. */
export const CI_HEALTH_RUNS_PER_REPO = 50;
/** A workflow with no decisive run for this long is not reported. */
export const CI_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const COUNTED_EVENTS = new Set(["push", "schedule", "workflow_run"]);
const FAILING = new Set(["failure", "timed_out", "startup_failure"]);
const DECISIVE = new Set(["success", ...FAILING]);

/** One run, reduced to what the verdict needs. */
export interface CiRun {
	id: string;
	workflowName: string;
	workflowPath: string;
	event: string;
	branch: string;
	status: string;
	conclusion: string | null;
	sha: string;
	url: string;
	/** ISO. When the run was created — the order a pipeline's runs happened in. */
	createdAt: string;
}

export type CiWorkflowState = "passing" | "failing" | "pending";

export interface CiWorkflowHealth {
	workflow: string;
	path: string;
	kind: "ci" | "deploy";
	state: CiWorkflowState;
	/** The decisive run behind `state` (absent when only an undecided run exists). */
	conclusion: string | null;
	runId: string | null;
	url: string | null;
	sha: string | null;
	at: string | null;
	/** A newer run of this workflow has not concluded yet. */
	running: boolean;
}

/** A repo's verdict, WORST FIRST — the order the instance-level `state` is chosen by. Mirrored in workers/mcp's state-vocabulary.ts. */
export const CI_STATES = ["failing", "unknown", "pending", "passing", "none"] as const;
export type CiState = (typeof CI_STATES)[number];

/** What is stored on the row and served by the status routes. */
export interface RepoCiHealth {
	state: CiState;
	branch: string | null;
	/** Failing workflows first. Empty when unknown. */
	workflows: CiWorkflowHealth[];
	/** Why the state is `unknown`. */
	reason?: string;
	checkedAt: string;
	/** On `unknown`, the last verdict that was not — so a red pipeline does not vanish behind a rate limit. */
	lastKnown?: { state: CiState; failing: CiWorkflowHealth[]; checkedAt: string };
}

function newestFirst(runs: CiRun[]): CiRun[] {
	return [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** The per-workflow verdicts for one page of runs. Pure. */
export function assessCiRuns(runs: CiRun[], defaultBranch: string, now: number): CiWorkflowHealth[] {
	const groups = new Map<string, CiRun[]>();
	for (const r of runs) {
		if (r.branch !== defaultBranch || !COUNTED_EVENTS.has(r.event)) continue;
		const key = r.workflowPath || r.workflowName;
		if (!key) continue;
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	const out: CiWorkflowHealth[] = [];
	for (const [path, group] of groups) {
		const ordered = newestFirst(group);
		const running = ordered[0].status !== "completed";
		const decisive = ordered.find((r) => r.status === "completed" && DECISIVE.has(r.conclusion ?? ""));
		const name = ordered[0].workflowName || path;
		const kind = isDeployWorkflow(name, path) ? "deploy" : "ci";
		if (!decisive) {
			if (running) out.push({ workflow: name, path, kind, state: "pending", conclusion: null, runId: null, url: null, sha: null, at: null, running });
			continue;
		}
		const at = Date.parse(decisive.createdAt);
		if (Number.isFinite(at) && now - at > CI_STALE_AFTER_MS) continue;
		out.push({
			workflow: name,
			path,
			kind,
			state: FAILING.has(decisive.conclusion ?? "") ? "failing" : "passing",
			conclusion: decisive.conclusion,
			runId: decisive.id,
			url: decisive.url || null,
			sha: decisive.sha || null,
			at: decisive.createdAt || null,
			running,
		});
	}
	const rank: Record<CiWorkflowState, number> = { failing: 0, pending: 1, passing: 2 };
	return out.sort((a, b) => rank[a.state] - rank[b.state] || a.workflow.localeCompare(b.workflow));
}

/** The repo's verdict from its workflows: any failing wins, then pending, then passing. */
export function overallCiState(workflows: CiWorkflowHealth[]): CiState {
	if (workflows.some((w) => w.state === "failing")) return "failing";
	if (workflows.some((w) => w.state === "pending")) return "pending";
	return workflows.length ? "passing" : "none";
}

/** Workflow path → the run id of the failure the owner was told about. Cleared when the workflow recovers. */
export type CiAlerted = Record<string, string>;

export interface CiAlertDecision {
	/** Workflows that turned red since the owner was last told — empty means no notification. */
	newlyFailing: CiWorkflowHealth[];
	/** The alert state to store. */
	alerted: CiAlerted;
}

/**
 * Who to tell about what, and the alert state that results. Pure.
 *
 * The unit is a workflow's RED STREAK, not a run: three red pushes in a row are one failure the
 * owner already knows about, and telling them three times is how a signal stops being read. So a
 * workflow alerts when it turns red and not again until it has gone green in between. A workflow
 * that drops out of view (stale, deleted) is forgotten, so its return is news. A pending workflow
 * keeps whatever it had — an undecided run says nothing either way.
 *
 * Only ever called on a KNOWN verdict: an unknown sweep does not reach here, so a rate limit can
 * neither clear a failure (and re-alert on the next good read) nor raise one.
 */
export function decideCiAlerts(workflows: CiWorkflowHealth[], previous: CiAlerted): CiAlertDecision {
	const alerted: CiAlerted = {};
	const newlyFailing: CiWorkflowHealth[] = [];
	for (const w of workflows) {
		if (w.state === "failing") {
			if (previous[w.path]) alerted[w.path] = previous[w.path];
			else {
				alerted[w.path] = w.runId ?? "";
				newlyFailing.push(w);
			}
		} else if (w.state === "pending" && previous[w.path]) {
			alerted[w.path] = previous[w.path];
		}
	}
	return { newlyFailing, alerted };
}

/** The notification for workflows that just turned red. One per repo per sweep, however many went red. */
export function ciFailureNotification(repoName: string, branch: string, failing: CiWorkflowHealth[]): { title: string; body: string } {
	const names = failing.map((w) => `${w.workflow} (${w.conclusion ?? "failed"})`).join(", ");
	const deploy = failing.some((w) => w.kind === "deploy");
	const sha = failing.find((w) => w.sha)?.sha?.slice(0, 7);
	return {
		title: `❌ ${deploy ? "Deploy" : "CI"} failing on ${branch} — ${repoName}`,
		body: `${names}${sha ? ` at ${sha}` : ""}. Open Builds to see why.`,
	};
}

/** The event identity of one alert, shared across every row that watches the same repository (#709's lesson). */
export function ciAlertEventKey(githubRepo: string, failing: CiWorkflowHealth[]): string {
	return `ci:${githubRepo.toLowerCase()}:${failing.map((w) => `${w.path}@${w.runId}`).sort().join(",")}`;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return (JSON.parse(raw) as T) ?? fallback;
	} catch {
		return fallback;
	}
}

/** Why GitHub gave no verdict, in words an owner can act on. */
function unknownReason(status: number | null): string {
	if (status === 401 || status === 403) return "GitHub refused the read (no access for this account, or rate-limited)";
	if (status === 404) return "the repository's workflow runs are not visible to this account (private repo without GitHub access?)";
	if (status === 429) return "GitHub rate limit";
	if (status === null) return "GitHub could not be reached";
	return `GitHub answered HTTP ${status}`;
}

/** An `unknown` verdict that keeps the last known one beside it. */
export function unknownHealth(reason: string, previous: RepoCiHealth | null, now: Date): RepoCiHealth {
	const lastKnown =
		previous && previous.state !== "unknown"
			? { state: previous.state, failing: previous.workflows.filter((w) => w.state === "failing"), checkedAt: previous.checkedAt }
			: previous?.lastKnown;
	return { state: "unknown", branch: previous?.branch ?? null, workflows: [], reason, checkedAt: now.toISOString(), ...(lastKnown ? { lastKnown } : {}) };
}

interface RepoRow {
	id: string;
	instance_id: string;
	user_id: string;
	name: string;
	github_repo: string;
	ci_health: string | null;
	ci_alerted: string | null;
}

async function writeHealth(env: Env, repoId: string, health: RepoCiHealth, alerted: CiAlerted | null): Promise<void> {
	await env.DB.prepare(
		alerted
			? "UPDATE coding_repos SET ci_health = ?1, ci_alerted = ?3, ci_checked_at = datetime('now') WHERE id = ?2"
			: "UPDATE coding_repos SET ci_health = ?1, ci_checked_at = datetime('now') WHERE id = ?2",
	)
		.bind(...(alerted ? [JSON.stringify(health), repoId, JSON.stringify(alerted)] : [JSON.stringify(health), repoId]))
		.run();
}

/** Has this event already been notified to this user, by any row, ever? */
async function alreadyNotified(env: Env, userId: string, eventKey: string): Promise<boolean> {
	const key = notificationDedupeKey("ci", eventKey, "", "");
	const row = await env.DB.prepare("SELECT 1 FROM notifications WHERE user_id = ?1 AND dedupe_key = ?2 LIMIT 1").bind(userId, key).first();
	return !!row;
}

/** Map a raw Actions run. */
function toCiRun(raw: Record<string, unknown>): CiRun {
	const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
	return {
		id: String(raw.id ?? ""),
		workflowName: s("name"),
		workflowPath: s("path"),
		event: s("event"),
		branch: s("head_branch"),
		status: s("status"),
		conclusion: typeof raw.conclusion === "string" ? raw.conclusion : null,
		sha: s("head_sha"),
		url: s("html_url"),
		createdAt: s("created_at"),
	};
}

/** At most this many out-of-window workflows are looked up per repo per sweep. */
export const CI_MISSING_WORKFLOW_LOOKUPS = 10;

/**
 * The file names of the repo's ACTIVE workflows that have no run in `runs`. Degrades to [] when the
 * workflow list cannot be read — the window's own verdict still stands, exactly as before.
 */
async function workflowsOutsideWindow(env: Env, identity: GithubCacheIdentity, githubRepo: string, headers: Record<string, string>, runs: Array<Record<string, unknown>>): Promise<string[]> {
	const listed = await githubConditionalJson<{ workflows?: Array<{ path?: string; state?: string }> }>(env, {
		identity,
		repo: githubRepo,
		resource: "workflows",
		variant: "list",
		url: `https://api.github.com/repos/${githubRepo}/actions/workflows?per_page=100`,
		headers,
	}).catch(() => null);
	if (!listed?.ok) return [];
	const seen = new Set(runs.map((r) => (typeof r.path === "string" ? r.path.split("@")[0] : "")));
	return (listed.data?.workflows ?? [])
		.filter((w) => w.state === "active" && typeof w.path === "string" && w.path.startsWith(".github/workflows/") && !seen.has(w.path))
		.map((w) => String(w.path).split("/").pop() ?? "")
		.filter(Boolean);
}

/** Check one repo and store the verdict. Exported for the sweep's tests. */
export async function checkRepoCi(env: Env, repo: RepoRow, now = new Date()): Promise<RepoCiHealth> {
	const previous = parseJson<RepoCiHealth | null>(repo.ci_health, null);
	const owner = repo.github_repo.split("/")[0] ?? "";
	const { token, authContext } = await resolveGithubRead(env, repo.user_id, owner);
	const identity = { userId: repo.user_id, authContext };
	const headers: Record<string, string> = {
		...(token ? { Authorization: `token ${token}` } : {}),
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "proagentstore-coding/1.0",
	};
	// The default branch is asked for, not assumed: `main` is a convention, and a repo on `master`
	// read as `main` would report "none" forever. Conditional, so an unchanged repo costs a 304.
	const meta = await githubConditionalJson<{ default_branch?: string }>(env, {
		identity,
		repo: repo.github_repo,
		resource: "repo",
		variant: "meta",
		url: `https://api.github.com/repos/${repo.github_repo}`,
		headers,
	});
	const unknown = async (reason: string) => {
		const health = unknownHealth(reason, previous, now);
		await writeHealth(env, repo.id, health, null);
		return health;
	};
	if (!meta.ok) return unknown(unknownReason(meta.status));
	const branch = meta.data?.default_branch;
	if (!branch) return unknown("GitHub did not report a default branch");
	const res = await fetchWorkflowRuns(repo.github_repo, token ?? undefined, { perPage: CI_HEALTH_RUNS_PER_REPO, branch }, { env, identity });
	if (!("runs" in res)) return unknown(unknownReason(res.status));
	// A stored page served while GitHub was unreachable can name an old run as the newest (#708).
	if (res.stale || meta.stale) return unknown("GitHub could not be reached — only a stored copy was available");

	// Every active workflow, not only those in the newest 50 runs (#898): a workflow that runs rarely
	// fell out of that window, its alert was forgotten, and a red one could read as passing. Each one
	// missing from the window gets its own latest default-branch runs — one extra conditional read,
	// only for the workflows the window did not cover.
	const missing = await workflowsOutsideWindow(env, identity, repo.github_repo, headers, res.runs);
	const extra = await Promise.all(
		missing.slice(0, CI_MISSING_WORKFLOW_LOOKUPS).map(async (file) => {
			const one = await fetchWorkflowRuns(repo.github_repo, token ?? undefined, { perPage: 5, branch, workflow: file }, { env, identity });
			return "runs" in one ? one.runs : [];
		}),
	);
	const workflows = assessCiRuns([...res.runs, ...extra.flat()].map(toCiRun), branch, now.getTime());
	const health: RepoCiHealth = { state: overallCiState(workflows), branch, workflows, checkedAt: now.toISOString() };
	const decision = decideCiAlerts(workflows, parseJson<CiAlerted>(repo.ci_alerted, {}));
	if (decision.newlyFailing.length) {
		const eventKey = ciAlertEventKey(repo.github_repo, decision.newlyFailing);
		// Another row watching the same repository may already have said it (#709).
		if (!(await alreadyNotified(env, repo.user_id, eventKey))) {
			const { title, body } = ciFailureNotification(repo.name, branch, decision.newlyFailing);
			await notifyUser(env, repo.user_id, "ci", title, body, deepLinkFor({ kind: "builds", instanceId: repo.instance_id, repoId: repo.id }), {
				key: eventKey,
				instanceId: repo.instance_id,
			});
		}
	}
	await writeHealth(env, repo.id, health, decision.alerted);
	return health;
}

/** One sweep. Never throws — the cron's other sweeps are independent failure domains. */
export async function runCiHealthWatch(env: Env): Promise<void> {
	let repos: RepoRow[] = [];
	try {
		const { results } = await env.DB.prepare(
			`SELECT id, instance_id, user_id, name, github_repo, ci_health, ci_alerted
			   FROM coding_repos
			  WHERE github_repo IS NOT NULL AND github_repo <> ''
			  ORDER BY COALESCE(ci_checked_at, '') ASC
			  LIMIT ?1`,
		)
			.bind(CI_HEALTH_BATCH)
			.all<RepoRow>();
		repos = results ?? [];
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		await logError(env, {
			source: "ci-health",
			level: /no such (table|column)/i.test(detail) ? "warn" : "error",
			message: `ci-health sweep could not read coding_repos, so no repo was checked this tick: ${detail}`,
		}).catch(() => undefined);
		return;
	}
	for (const repo of repos) {
		try {
			await checkRepoCi(env, repo);
		} catch (err) {
			await logError(env, {
				source: "ci-health",
				level: "warn",
				message: `ci-health skipped ${repo.github_repo}: ${err instanceof Error ? err.message : String(err)}`,
				userId: repo.user_id,
				context: { repoId: repo.id, instanceId: repo.instance_id },
			}).catch(() => undefined);
			// The rotation key still moves, so one broken repo cannot pin the batch to itself.
			await env.DB.prepare("UPDATE coding_repos SET ci_checked_at = datetime('now') WHERE id = ?1").bind(repo.id).run().catch(() => undefined);
		}
	}
}

export interface InstanceRepoCi {
	/** The worst verdict across the instance's repos: failing › unknown › pending › passing › none. */
	state: CiState;
	/** One sentence when something needs the owner's attention; absent otherwise. */
	attention?: string;
	repos: Array<{ repoId: string; name: string; githubRepo: string } & (RepoCiHealth | { state: "unchecked" })>;
}

/**
 * The instance's repository pipelines, as the status routes report them — beside the run's own
 * `health`, never merged into it. Reads the stored verdicts only: a status read must not spend
 * GitHub quota or wait on it. Returns null when the columns are not there yet (pre-migration).
 */
export async function instanceRepoCi(env: Env, instanceId: string, userId: string): Promise<InstanceRepoCi | null> {
	let rows: Array<{ id: string; name: string; github_repo: string; ci_health: string | null }>;
	try {
		const { results } = await env.DB.prepare(
			"SELECT id, name, github_repo, ci_health FROM coding_repos WHERE instance_id = ?1 AND user_id = ?2 AND github_repo IS NOT NULL AND github_repo <> '' ORDER BY name",
		)
			.bind(instanceId, userId)
			.all<{ id: string; name: string; github_repo: string; ci_health: string | null }>();
		rows = results ?? [];
	} catch {
		return null;
	}
	if (!rows.length) return null;
	const repos: InstanceRepoCi["repos"] = rows.map((r) => {
		const health = parseJson<RepoCiHealth | null>(r.ci_health, null);
		return { repoId: r.id, name: r.name, githubRepo: r.github_repo, ...(health ?? { state: "unchecked" as const }) };
	});
	const states = repos.map((r) => (r.state === "unchecked" ? "unknown" : r.state));
	const state = CI_STATES.find((s) => states.includes(s)) ?? "none";
	const failing = repos.flatMap((r) => ("workflows" in r ? r.workflows.filter((w) => w.state === "failing").map((w) => `${r.githubRepo}: ${w.workflow}`) : []));
	const attention = failing.length
		? `Default-branch CI/deploy is failing — ${failing.join("; ")}. This is the repository's pipeline, not this run's health.`
		: undefined;
	return { state, ...(attention ? { attention } : {}), repos };
}
