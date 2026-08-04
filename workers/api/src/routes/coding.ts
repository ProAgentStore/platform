import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { requirePro } from "../lib/billing.js";
import { callRunner, getRunnerConn, getBoundRunnerConn, relayConnected, READ_TIMEOUT_MS, type RunnerConn } from "../lib/runner-client.js";
import { githubAppConfigured, installationTokenForOwner } from "../lib/github-app.js";
import { computeETag, mergeRuns, persistBuildHistory, readBuildHistory, type BuildRun } from "../lib/build-history.js";
import { fetchWorkflowRuns, mapWorkflowRun } from "../lib/github-actions.js";
import { listIssues, readIssue, type IssueDetail } from "../lib/github-issues.js";
import { getUserProviderKey, runUserWorkersAi } from "../lib/user-ai.js";
import {
	asClient,
	deriveClientType,
	engineAuthFor,
	ENGINE_AUTHS,
	readEngines,
	resolveEngine,
	resolveEngineEnv,
	type CodingEngine,
	type EngineAuth,
} from "../lib/coding-engines.js";
import { appendTimeline, clearChat, contextForCopilot, lastTerminal, loadChat, loadTimeline } from "../lib/coding-timeline.js";
import { copilotSummary } from "../lib/coding-copilot.js";
import {
	createRepo,
	createSession,
	deleteRepo,
	endSession,
	getActiveSessionForRepo,
	getRepo,
	getSession,
	listRepos,
	listSessions,
	reassignSessionNode,
	reconcileOrphanedSessions,
	updateRepo,
	updateRepoClone,
} from "../lib/coding-store.js";
import { getRuntime, getRuntimeForNode, normalizeRunnerNode, mirrorRuntimeTask } from "./instances-runtime.js";
import { logEvent } from "../lib/events.js";
import { authPromptGuidance, detectAuthPrompt } from "../lib/engine-auth-prompt.js";
import { delegationTaskRecord } from "../lib/delegation.js";
import { isExecutableTarget, parseDelegationTarget, targetId, unsupportedTargetReason, type DelegationTarget } from "../lib/delegate-target.js";
import { readInstanceRunnerNode } from "../lib/runtime-nodes.js";
import type { CodingActionKind, CodingGoal } from "../lib/coding-loop.js";
import type { CodingClientType, CodingRepo, CodingSessionRecord } from "../lib/coding-types.js";
import type { Env } from "../types.js";

/** Parse a stored JSON column, falling back on corrupt/missing data instead of throwing —
 *  a malformed row must never 500 a whole route (esp. the diagnostics page users open to
 *  self-diagnose a broken runner). */
function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/**
 * Ensure a session is live on the user's runner: clone the repo (idempotent on
 * the runner) and launch the CLI. Returns the connection it actually used (null if
 * no runner is connected). Used both when creating a session and when re-attaching
 * an orphaned one (created while the runner was offline, or after a runner restart).
 *
 * IMPORTANT: on a machine switch this RELOCATES the session to the live machine and
 * returns THAT machine's connection — callers retrying a command must use the returned
 * conn, not one they captured earlier (which may point at the now-dead old machine).
 */
async function startSessionOnRunner(
	env: Env,
	instanceId: string,
	uid: string,
	session: CodingSessionRecord,
	repo: CodingRepo,
): Promise<RunnerConn | null> {
	let conn = await getSessionRunnerConn(env, instanceId, uid, session);
	// Machine-switch reclaim. `conn` resolves from the DB (endpoint+token) even for a machine
	// that's gone offline — the `status` column isn't cleared on disconnect — so verify the
	// session's own machine actually holds a live relay socket. If it doesn't, but the user is
	// now running the agent on another machine, relocate the session there so switching laptops
	// "just works" instead of dead-ending on the offline node. `getBoundRunnerConn` is live +
	// pin-aware: pinned-elsewhere stays put (returns that node), pinned-to-this-offline → null.
	const sessionLive = session.runnerNode
		? await relayConnected(env, instanceId, session.runnerNode).catch(() => false)
		: await relayConnected(env, instanceId, null).catch(() => false);
	if (!sessionLive) {
		const fallback = await getBoundRunnerConn(env, instanceId, uid);
		if (fallback && normalizeRunnerNode(fallback.runnerNode) !== normalizeRunnerNode(session.runnerNode)) {
			await reassignSessionNode(env, instanceId, uid, session.id, fallback.runnerNode ?? null);
			session.runnerNode = fallback.runnerNode ?? null;
			conn = fallback;
		}
	}
	if (!conn) return null;
	const owner = repo.githubRepo ? repo.githubRepo.split("/")[0] : "";
	const token = owner ? await installationTokenForOwner(env, uid, owner) : null;
	const engineEnv = await resolveEngineEnv(env, instanceId, uid, session);
	try {
		await callRunner(conn, "/coding/start", {
			sessionId: session.id,
			repoId: repo.id,
			// Local checkout → run in that dir (no clone). Else clone to a managed dir.
			workDir: repo.workdir || undefined,
			cloneUrl: repo.cloneUrl,
			branch: repo.branch || undefined,
			token: token ?? undefined,
			clientType: session.clientType,
			// The exact CLI command for this session's engine (Claude default, or a
			// user-configured Codex/Grok/custom). The runner spawns it.
			command: session.launchCommand || undefined,
			env: engineEnv,
		});
		await updateRepoClone(env, repo.id, { cloneStatus: "ready", cloneError: null });
		return conn;
	} catch (e) {
		const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
		await updateRepoClone(env, repo.id, { cloneStatus: "error", cloneError: msg });
		return null;
	}
}

async function getSessionRunnerConn(env: Env, instanceId: string, uid: string, session: CodingSessionRecord) {
	return getRunnerConn(env, instanceId, uid, session.runnerNode ?? null);
}

async function getDefaultRunnerConn(env: Env, instanceId: string, uid: string) {
	const runtime = await getRuntime(env, instanceId, uid);
	return getRunnerConn(env, instanceId, uid, runtime?.runner_node ?? null);
}

/**
 * The coding-workspace control plane (the AgentCoder port). A workspace IS the
 * agent instance; these routes manage its repos + coding sessions and proxy the
 * brain-driven controls to the user's local runner. Mounted on `/v1/instances`.
 */
export const codingRoutes = new Hono<{ Bindings: Env }>();

/** "~/dev/stores/pags/platform" → "pags/platform" — a less generic default name. */
function lastTwoSegments(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
	return parts.slice(-2).join("/");
}

/** Confirm the caller owns the instance (the workspace). */
async function requireOwned(
	c: Context<{ Bindings: Env }>,
): Promise<{ uid: string; instanceId: string; session: Awaited<ReturnType<typeof requireUser>> }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	const owned = await c.env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, session.uid)
		.first();
	if (!owned) throw new HttpError(404, "Instance not found");
	return { uid: session.uid, instanceId, session };
}

/** The instance's Special Instructions (user rules) from its JSON config. */
async function readSpecialInstructions(env: Env, instanceId: string, userId: string): Promise<string | undefined> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string }>();
	try {
		const cfg = JSON.parse(row?.config || "{}") as { specialInstructions?: string };
		return cfg.specialInstructions || undefined;
	} catch {
		return undefined;
	}
}

/** How the Loop sources its objective: `direct` (you type each objective) or `issues`
 *  (the backlog IS the GitHub issue tracker — the Loop proposes the next open issue and you
 *  approve it). Instance-wide for v1. Stored in the instance's JSON config (no migration). */
export type WorkMode = "direct" | "issues";

async function readWorkMode(env: Env, instanceId: string, userId: string): Promise<WorkMode> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string }>();
	try {
		const cfg = JSON.parse(row?.config || "{}") as { workMode?: string };
		return cfg.workMode === "issues" ? "issues" : "direct";
	} catch {
		return "direct";
	}
}

/**
 * The next open GitHub issue to work on a repo, for issues-mode: lowest number first,
 * skipping any the caller excludes (declined this Loop run) and the one already in an active
 * session. Returns the full detail (body included) so the console can pre-fill the objective,
 * or null when the backlog is empty. Never throws (listIssues/readIssue degrade to []/null).
 */
/** Pure selection: lowest-numbered issue not excluded (deterministic ordering). Exported for
 *  tests — the ordering/skip rule is the part worth pinning. */
export function pickNextIssue<T extends { number: number }>(issues: T[], exclude: Set<number>): T | null {
	return [...issues].sort((a, b) => a.number - b.number).find((i) => !exclude.has(i.number)) ?? null;
}

async function nextOpenIssue(env: Env, userId: string, githubRepo: string, opts: { labels?: string; exclude: Set<number> }): Promise<IssueDetail | null> {
	const issues = await listIssues(env, userId, githubRepo, { state: "open", labels: opts.labels });
	const next = pickNextIssue(issues, opts.exclude);
	return next ? readIssue(env, userId, githubRepo, next.number) : null;
}

// ── Repos ────────────────────────────────────────────────────────────────

codingRoutes.get("/:instanceId/coding/repos", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json({ repos: await listRepos(c.env, instanceId, uid) });
});

codingRoutes.post("/:instanceId/coding/repos", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const name = String(body.name ?? "").trim();
	let githubRepo = typeof body.githubRepo === "string" ? body.githubRepo : undefined;
	const cloneUrl = typeof body.cloneUrl === "string" ? body.cloneUrl : undefined;
	// A local checkout the user already has on the runner machine — run there, no clone.
	const localPath = typeof body.localPath === "string" ? body.localPath.trim() : "";
	if (localPath) {
		const repo = await createRepo(c.env, instanceId, uid, {
			// A bare folder name ("platform") is ambiguous — default to the last two
			// path segments ("pags/platform"). Editable later either way.
			name: name || lastTwoSegments(localPath) || "repo",
			workdir: localPath,
			defaultClient: asClient(body.defaultClient),
		});
		return c.json({ repo }, 201);
	}
	// A clone URL alone is enough: derive owner/repo (for private-repo token
	// resolution) and a display name from it. Accept name OR github repo OR URL.
	if (!githubRepo && cloneUrl) {
		const m = cloneUrl.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
		if (m) githubRepo = m[1];
	}
	// Default to the full "owner/repo" — a bare repo name ("platform") is too
	// generic to tell projects apart. The user can rename it afterwards.
	const derivedName =
		name ||
		githubRepo ||
		(cloneUrl ? cloneUrl.replace(/\.git$/, "").replace(/\/$/, "").split("/").pop() : "");
	if (!derivedName && !cloneUrl) return c.json({ error: "a repo name or URL is required" }, 400);
	const repo = await createRepo(c.env, instanceId, uid, {
		name: derivedName || "repo",
		githubRepo,
		cloneUrl,
		branch: typeof body.branch === "string" ? body.branch : undefined,
		defaultClient: asClient(body.defaultClient),
	});
	return c.json({ repo }, 201);
});

/**
 * Auto-associate a LOCAL-PATH repo with its GitHub owner/repo by reading the local
 * checkout's `origin` remote via the runner — so build status can query Actions for a
 * repo you run from a local checkout (which otherwise has no githubRepo). Idempotent:
 * returns the existing githubRepo if already set; { githubRepo: null } (never a 500) when
 * there's no runner, no origin, or the origin isn't a GitHub URL.
 */
codingRoutes.post("/:instanceId/coding/repos/:repoId/detect-github", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	if (repo.githubRepo) return c.json({ githubRepo: repo.githubRepo, detected: false });
	if (!repo.workdir) return c.json({ githubRepo: null, reason: "not a local repo" });
	const conn = await getBoundRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ githubRepo: null, reason: "runner offline" });
	let remote: string | null = null;
	try {
		const r = await callRunner<{ remote?: string | null }>(conn, "/coding/git-remote", { workDir: repo.workdir }, { timeoutMs: READ_TIMEOUT_MS });
		remote = r.remote ?? null;
	} catch {
		return c.json({ githubRepo: null, reason: "could not read remote" });
	}
	// Parse owner/repo from an https or ssh GitHub remote (same shape as the clone-URL path).
	const m = remote?.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
	const githubRepo = m ? m[1] : null;
	if (githubRepo) {
		await c.env.DB.prepare("UPDATE coding_repos SET github_repo = ?1, updated_at = datetime('now') WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4")
			.bind(githubRepo, repo.id, instanceId, uid)
			.run();
	}
	return c.json({ githubRepo, detected: !!githubRepo });
});

codingRoutes.delete("/:instanceId/coding/repos/:repoId", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repoId = c.req.param("repoId");
	// End any active sessions on the runner before deleting from DB
	const sessions = await listSessions(c.env, instanceId, uid);
	for (const s of sessions.filter((s) => s.repoId === repoId && s.status === "active")) {
		const conn = await getSessionRunnerConn(c.env, instanceId, uid, s);
		if (conn) await callRunner(conn, "/coding/end", { sessionId: s.id }).catch(() => undefined);
	}
	const ok = await deleteRepo(c.env, instanceId, uid, repoId);
	if (!ok) throw new HttpError(404, "Repo not found");
	return c.json({ ok: true });
});

/** Get/set per-repo instructions (injected into the co-pilot + Overseer prompts). */
codingRoutes.get("/:instanceId/coding/repos/:repoId/instructions", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	return c.json({ instructions: repo.instructions || "" });
});

codingRoutes.put("/:instanceId/coding/repos/:repoId/instructions", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repoId = c.req.param("repoId");
	const body = await c.req.json<{ instructions?: string }>();
	const instructions = String(body.instructions || "").slice(0, 5000);
	await c.env.DB.prepare(
		"UPDATE coding_repos SET instructions = ?1, updated_at = datetime('now') WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
	)
		.bind(instructions, repoId, instanceId, uid)
		.run();
	return c.json({ instructions });
});

/**
 * Latest GitHub Actions run for an `owner/repo`, for a verified installation. Returns
 * `{ available:false }` (never throws) for a non-GitHub repo, a missing/failed installation
 * token, or a GitHub error — so the aggregate below can degrade per-repo. Shared by /builds.
 */
async function latestRunFor(env: Env, uid: string, full: string | undefined): Promise<{ available: boolean; run: BuildRun | null }> {
	if (!full?.includes("/") || !githubAppConfigured(env)) return { available: false, run: null };
	const owner = full.split("/")[0];
	const token = await installationTokenForOwner(env, uid, owner).catch(() => null);
	if (!token) return { available: false, run: null };
	const res = await fetchWorkflowRuns(full, token, { perPage: 1 });
	if ("status" in res) return { available: false, run: null };
	return { available: true, run: res.runs[0] ? mapWorkflowRun(res.runs[0]) : null };
}

/**
 * Latest GitHub Actions run for a repo — so the console can show build/deploy
 * status (running / failed / live) independently of the agent. OPTIONAL: returns
 * { available:false } for local repos, non-GitHub repos, or when the GitHub App
 * isn't installed — so it never breaks anything.
 */
codingRoutes.get("/:instanceId/coding/repos/:repoId/deployment", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	const full = repo.githubRepo;
	if (!full?.includes("/") || !githubAppConfigured(c.env)) return c.json({ available: false });
	const owner = full.split("/")[0];
	const token = await installationTokenForOwner(c.env, uid, owner).catch(() => null);
	if (!token) return c.json({ available: false });
	const res = await fetchWorkflowRuns(full, token, { perPage: 1 });
	if ("status" in res) return c.json({ available: false });
	return c.json({ available: true, run: res.runs[0] ? mapWorkflowRun(res.runs[0]) : null });
});

/**
 * Paginated list of recent GitHub Actions runs for a repo — the Build Status panel's
 * data source (build history). Plural sibling of `/deployment` (which returns only the
 * latest). Same graceful-degradation contract: `{ available:false }` (never a 500) for
 * local repos, non-GitHub repos, or when the GitHub App isn't installed. Auth is the
 * GitHub App installation token (server-side, never exposed to the browser).
 * `?page` (≥1, default 1) + `?perPage` (1..50, default 20). (CODER-001, #77)
 *
 * Page 1 also merges a durable KV build-history log (survives GitHub retention / transient
 * failures), persists best-effort, and supports conditional requests via a weak ETag —
 * `If-None-Match` on an unchanged latest build returns 304. (CODER-002, #78)
 */
codingRoutes.get("/:instanceId/coding/repos/:repoId/deployments", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	const full = repo.githubRepo;
	if (!full?.includes("/")) return c.json({ available: false });
	const owner = full.split("/")[0];
	// Prefer the GitHub App installation token; if the App isn't configured/installed, fall back
	// to an UNAUTHENTICATED request — public repos' Actions runs are readable without auth
	// (~60/hr shared IP; private repos will 404 → available:false). This makes builds show for
	// public repos with no App installed. Only the per-repo /deployments path uses this fallback;
	// the aggregate /builds does NOT (its fan-out would burn the unauth budget). (CODER-010, #121)
	const token = githubAppConfigured(c.env) ? await installationTokenForOwner(c.env, uid, owner).catch(() => null) : null;
	const page = Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1);
	const perPage = Math.min(50, Math.max(1, Number.parseInt(c.req.query("perPage") || "20", 10) || 20));
	try {
		const res = await fetchWorkflowRuns(full, token ?? undefined, { perPage, page });
		if ("status" in res) return c.json({ available: false });
		const runs: BuildRun[] = res.runs.map(mapWorkflowRun);
		// "There may be more" signal without parsing the Link header: a full live page implies a next.
		const nextPage = runs.length === perPage ? page + 1 : undefined;

		// Page 1 is the panel's freshness poll: merge live runs with the durable KV history
		// (so history survives GitHub retention + transient failures), persist best-effort, and
		// support conditional requests — an unchanged latest build short-circuits to 304. Deeper
		// pages are live GitHub only (immutable deep history), no merge/ETag. (CODER-002, #78)
		if (page === 1) {
			const stored = await readBuildHistory(c.env, instanceId, repo.id);
			const merged = mergeRuns(stored, runs);
			await persistBuildHistory(c.env, instanceId, repo.id, merged); // best-effort, never throws
			const etag = computeETag(merged);
			if (c.req.header("If-None-Match") === etag) return c.body(null, 304, { ETag: etag });
			return c.json(nextPage ? { available: true, runs: merged, nextPage } : { available: true, runs: merged }, 200, {
				ETag: etag,
			});
		}
		return c.json(nextPage ? { available: true, runs, nextPage } : { available: true, runs });
	} catch {
		return c.json({ available: false });
	}
});

/**
 * Aggregate latest build per repo for an instance — ONE call for the Build Status panel
 * instead of N per-repo /deployments requests. Fans out to GitHub with bounded concurrency;
 * a repo that fails degrades to `{ available:false }` for that repo only, never failing the
 * whole response. Non-GitHub / local repos are listed as `available:false` (not hidden) so
 * the panel can still show them. Drill-down to full history stays on /deployments. (CODER-003, #79)
 */
codingRoutes.get("/:instanceId/coding/builds", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repos = await listRepos(c.env, instanceId, uid);
	const ghRepos = repos.filter((r) => r.githubRepo?.includes("/"));

	// Bounded concurrency keeps us well under GitHub's rate limit even with many repos.
	const CONCURRENCY = 6;
	const byRepo = new Map<string, { available: boolean; run: BuildRun | null }>();
	for (let i = 0; i < ghRepos.length; i += CONCURRENCY) {
		const batch = ghRepos.slice(i, i + CONCURRENCY);
		const settled = await Promise.allSettled(batch.map((r) => latestRunFor(c.env, uid, r.githubRepo)));
		settled.forEach((s, j) => {
			byRepo.set(batch[j].id, s.status === "fulfilled" ? s.value : { available: false, run: null });
		});
	}

	// Preserve the instance's repo order; non-GitHub repos fall through to available:false.
	const builds = repos.map((r) => {
		const res = byRepo.get(r.id);
		return { repoId: r.id, repoName: r.name, available: res?.available ?? false, run: res?.run ?? null };
	});
	return c.json({ builds });
});

/**
 * GitHub issues for a repo (read-only, cloud→GitHub — works on any runner). Public
 * repos work unauthenticated; private repos need the GitHub App installed for the owner.
 * 400 for local-only repos (no `github_repo`); the Issues panel hides in that case.
 */
codingRoutes.get("/:instanceId/coding/repos/:repoId/issues", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	if (!repo.githubRepo?.includes("/")) {
		return c.json({ error: "This repo isn't connected to GitHub — add it by owner/repo or a GitHub URL to use issues." }, 400);
	}
	const state = c.req.query("state");
	const labels = c.req.query("labels") || undefined;
	const issues = await listIssues(c.env, uid, repo.githubRepo, {
		state: state === "closed" || state === "all" ? state : "open",
		labels,
	});
	return c.json({ repo: repo.githubRepo, issues });
});

codingRoutes.get("/:instanceId/coding/repos/:repoId/issues/:number", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	if (!repo.githubRepo?.includes("/")) {
		return c.json({ error: "This repo isn't connected to GitHub." }, 400);
	}
	const number = Number.parseInt(c.req.param("number"), 10);
	if (!Number.isFinite(number)) return c.json({ error: "Invalid issue number" }, 400);
	const issue = await readIssue(c.env, uid, repo.githubRepo, number);
	if (!issue) throw new HttpError(404, "Issue not found");
	return c.json({ issue });
});

/**
 * Work mode (instance-wide): `direct` = you type each Loop objective; `issues` = the Loop
 * sources its objective from the next open GitHub issue (approve-per-issue). Read-merge-write
 * on the instance config JSON — no migration.
 */
codingRoutes.get("/:instanceId/coding/work-mode", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json({ workMode: await readWorkMode(c.env, instanceId, uid) });
});

codingRoutes.put("/:instanceId/coding/work-mode", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as { workMode?: unknown };
	const workMode: WorkMode = body.workMode === "issues" ? "issues" : "direct";
	const row = await c.env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, uid).first<{ config: string }>();
	let cfg: Record<string, unknown> = {};
	try {
		cfg = JSON.parse(row?.config || "{}");
	} catch {
		/* overwrite a corrupt config */
	}
	cfg.workMode = workMode;
	await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
		.bind(JSON.stringify(cfg), instanceId, uid)
		.run();
	return c.json({ workMode });
});

/**
 * The next open issue to work on this repo (issues-mode Loop sources its objective from
 * here). Lowest-numbered open issue, skipping `?exclude=1,2` (declined this run) and the one
 * already in an active session. `?labels=` narrows/orders by label. Returns `{ issue: null }`
 * when the backlog is empty. 400 for local-only repos (no GitHub connection).
 */
codingRoutes.get("/:instanceId/coding/repos/:repoId/next-issue", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
	if (!repo) throw new HttpError(404, "Repo not found");
	if (!repo.githubRepo?.includes("/")) {
		return c.json({ error: "This repo isn't connected to GitHub — add it by owner/repo or a GitHub URL to use issues." }, 400);
	}
	const exclude = new Set<number>();
	for (const n of (c.req.query("exclude") || "").split(",")) {
		const v = Number.parseInt(n, 10);
		if (Number.isFinite(v)) exclude.add(v);
	}
	// Don't re-propose the issue already being worked in an active session on this repo.
	const active = await getActiveSessionForRepo(c.env, instanceId, uid, repo.id);
	if (active?.issueNumber) exclude.add(active.issueNumber);
	const issue = await nextOpenIssue(c.env, uid, repo.githubRepo, { labels: c.req.query("labels") || undefined, exclude });
	return c.json({ issue });
});

/** Update a repo/project: rename and/or set its launch URLs (dev/staging/prod). */
codingRoutes.put("/:instanceId/coding/repos/:repoId", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as {
		name?: string;
		urls?: { dev?: string; staging?: string; prod?: string };
	};
	const name = typeof body.name === "string" ? body.name.trim() : undefined;
	const hasUrls = body.urls !== undefined && typeof body.urls === "object";
	if (!name && !hasUrls) return c.json({ error: "name or urls is required" }, 400);
	const ok = await updateRepo(c.env, instanceId, uid, c.req.param("repoId"), {
		name: name || undefined,
		urls: hasUrls ? body.urls : undefined,
	});
	if (!ok) throw new HttpError(404, "Repo not found");
	return c.json({ ok: true });
});

// ── Sessions ─────────────────────────────────────────────────────────────

codingRoutes.get("/:instanceId/coding/sessions", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json({ sessions: await listSessions(c.env, instanceId, uid) });
});

/** The engine presets (CLI launch commands) the user can start sessions with. */
codingRoutes.get("/:instanceId/coding/engines", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json(await readEngines(c.env, instanceId, uid));
});

/** Save the engine presets + default. Each = { id, label, command, auth? }. */
codingRoutes.put("/:instanceId/coding/engines", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as { engines?: unknown; defaultEngineId?: unknown };
	const raw = Array.isArray(body.engines) ? body.engines : [];
	// Sanitize: id (slug), label, command are all required; cap the count + lengths.
	const seen = new Set<string>();
	const engines: CodingEngine[] = [];
	for (const e of raw.slice(0, 12) as Array<Record<string, unknown>>) {
		const label = String(e.label ?? "").trim().slice(0, 60);
		const command = String(e.command ?? "").trim().slice(0, 400);
		if (!label || !command) continue;
		let id = String(e.id ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
		if (!id) id = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "engine";
		while (seen.has(id)) id = `${id}-2`;
		seen.add(id);
		const auth = ENGINE_AUTHS.has(e.auth as EngineAuth) ? (e.auth as EngineAuth) : undefined;
		engines.push(auth && auth !== "auto" ? { id, label, command, auth } : { id, label, command });
	}
	if (!engines.length) throw new HttpError(400, "At least one engine with a label and command is required.");
	const defaultEngineId = engines.some((e) => e.id === body.defaultEngineId) ? String(body.defaultEngineId) : engines[0].id;
	const row = await c.env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, uid).first<{ config: string }>();
	let cfg: Record<string, unknown> = {};
	try {
		cfg = JSON.parse(row?.config || "{}");
	} catch {
		/* overwrite a corrupt config */
	}
	cfg.codingEngines = engines;
	cfg.defaultEngineId = defaultEngineId;
	await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
		.bind(JSON.stringify(cfg), instanceId, uid)
		.run();
	return c.json({ engines, defaultEngineId });
});

/** Create a coding session against a repo and start it on the runner (best-effort). */
codingRoutes.post("/:instanceId/coding/sessions", async (c) => {
	const { uid, instanceId, session: authSession } = await requireOwned(c);
	// Coding sessions run on the local runner — a Pro feature. Gate creation so the
	// console gets a clear 402 instead of a confusing runner-offline error.
	await requirePro(c.env, authSession);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const repoId = String(body.repoId ?? "");
	const repo = await getRepo(c.env, instanceId, uid, repoId);
	if (!repo) throw new HttpError(404, "Repo not found");

	// One active session per repo — a second would share the repo's single working
	// directory and conflict (concurrent edits, git index races). Reuse the live one.
	const existing = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
	if (existing) {
		const runnerConnected = (await startSessionOnRunner(c.env, instanceId, uid, existing, repo)) != null;
		return c.json({ session: existing, runnerConnected, reused: true }, 200);
	}

	// Resolve which engine to launch: the chosen preset (engineId), else the repo's
	// remembered default, else the instance default engine.
	const { command, clientType } = await resolveEngine(c.env, instanceId, uid, body.engineId ?? body.clientType ?? repo.defaultClient);
	// Which machine runs this session: an explicit request wins, else the instance's
	// node PIN (config.runnerNode) so the Coding tab honors "Runs on" exactly like chat/
	// apply do, else the legacy default runtime. A pinned/requested node that's offline is
	// a hard 409 (don't silently run on a different machine than the user chose).
	const requestedRunnerNode = normalizeRunnerNode(body.runnerNode) || await readInstanceRunnerNode(c.env, instanceId, uid).catch(() => "");
	const runtimeNow = requestedRunnerNode
		? await getRuntimeForNode(c.env, instanceId, uid, requestedRunnerNode)
		: await getRuntime(c.env, instanceId, uid);
	// Live check, not the DB `status` — that column isn't cleared when a runner drops, so a
	// pinned machine that closed its laptop still reads "registered" and the old guard passed,
	// stamping a session onto a dead node (silent `runnerConnected:false` instead of a clear 409).
	if (requestedRunnerNode) {
		const live = await relayConnected(c.env, instanceId, requestedRunnerNode).catch(() => false);
		if (!runtimeNow || !live) throw new HttpError(409, `Runner node is not connected: ${requestedRunnerNode}`);
	}
	// Stamp the owning machine so later commands route back to the same runner.
	let session: CodingSessionRecord;
	try {
		session = await createSession(c.env, instanceId, uid, {
			repoId,
			clientType,
			launchCommand: command,
			issueNumber: typeof body.issueNumber === "number" ? body.issueNumber : undefined,
			issueTitle: typeof body.issueTitle === "string" ? body.issueTitle : undefined,
			runnerNode: runtimeNow?.runner_node ?? null,
		});
	} catch {
		// Lost a create race against the one-active-session-per-repo index — reuse
		// whoever won instead of erroring.
		const winner = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
		if (!winner) throw new HttpError(409, "Could not start a session — try again.");
		const runnerConnected = (await startSessionOnRunner(c.env, instanceId, uid, winner, repo)) != null;
		return c.json({ session: winner, runnerConnected, reused: true }, 200);
	}

	const runnerConnected = (await startSessionOnRunner(c.env, instanceId, uid, session, repo)) != null;
	return c.json({ session, runnerConnected }, 201);
});

/**
 * Re-attach an existing session to the runner — fixes an orphaned session
 * (created while the runner was offline) and lets the terminal reconnect after a
 * runner restart. Idempotent: the runner's start no-ops if the session is live.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/start", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	if (session.status !== "active") return c.json({ ok: false, error: "session has ended" }, 409);
	const repo = await getRepo(c.env, instanceId, uid, session.repoId);
	if (!repo) throw new HttpError(404, "Repo not found");
	const runnerConnected = (await startSessionOnRunner(c.env, instanceId, uid, session, repo)) != null;
	return c.json({ ok: runnerConnected, runnerConnected });
});

/** The pane the console renders (polling fallback for the live terminal). */
codingRoutes.get("/:instanceId/coding/sessions/:sessionId/capture", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) return c.json({ pane: "", runState: "idle", alive: false, ready: false, runnerConnected: false });
	const snap = await callRunner(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
	if (!snap) return c.json({ pane: "", runState: "idle", alive: false, ready: false, runnerConnected: true });
	// An engine blocked on sign-in looks EXACTLY like a hung session: idle runState, a pane that
	// stops changing, no error anywhere. Surfacing it here means the console can say "sign in"
	// instead of the owner watching a dead terminal and concluding the platform is broken.
	const authPrompt = detectAuthPrompt(String((snap as { pane?: unknown }).pane ?? ""));

	// Persist the transcript at the END of a turn. Until now the ONLY writer was /explain (the
	// Co-pilot), so anyone working in the Terminal view had nothing saved at all: the pane lived
	// in the runner's memory and died with `pags up`. Worse, the stale snapshot from a previous
	// session kept rendering, which is how a fixed error message went on being displayed.
	//
	// Gated on idle + changed rather than written on every poll: /capture runs every 3s per open
	// session, and a read+write on each would be a lot of D1 for a pane that is not moving.
	const pane = String((snap as { pane?: unknown }).pane ?? "");
	const runState = String((snap as { runState?: unknown }).runState ?? "");
	if (pane.trim() && runState === "idle") {
		const last = await lastTerminal(c.env, sessionId);
		if (pane.trim() !== (last ?? "").trim()) {
			await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "terminal", content: pane.slice(-8000) }).catch(() => undefined);
		}
	}

	return c.json({
		...(snap as object),
		runnerConnected: true,
		...(authPrompt ? { authPrompt: { ...authPrompt, guidance: authPromptGuidance(authPrompt) } } : {}),
	});
});

/**
 * Relay an engine's sign-in into the RUNNER's browser (#coding-auth).
 *
 * Engine CLIs authenticate with a loopback redirect: a server on 127.0.0.1:PORT expecting a
 * browser on that machine. Mailing the URL to the owner's laptop cannot work — the redirect would
 * hit THEIR localhost, where nothing listens, and the same IP does not help because it is
 * literally 127.0.0.1 on the runner.
 *
 * So the page is opened in the browser that already runs on the runner, and handed to the human
 * through the takeover relay that solves reCAPTCHAs in the apply flow. The redirect then lands
 * exactly where the CLI is listening. No new runner capability: navigate + handoff + input all
 * exist already.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/signin", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) throw new HttpError(409, "No runner connected — start it with: pags up");

	// Re-read the pane rather than trusting a client-supplied URL: this navigates a real browser
	// on the owner's machine, so the destination must come from what the ENGINE actually printed.
	const snap = await callRunner<{ pane?: string }>(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
	const prompt = detectAuthPrompt(String(snap?.pane ?? ""));
	if (!prompt) throw new HttpError(409, "This engine isn't waiting for a sign-in right now.");
	if (!prompt.url) {
		// A menu with no URL cannot be relayed by opening a link — the human has to drive the CLI
		// itself. Saying so beats a button that appears to do nothing.
		return c.json({ ok: false, kind: prompt.kind, guidance: authPromptGuidance(prompt), evidence: prompt.evidence }, 200);
	}

	const taskId = `signin-${sessionId}`;
	// Flat body with `action` as a STRING — the shape lib/connectors/browser.ts uses. A nested
	// {action:{kind,url}} silently does nothing, which is the worst possible failure here: the
	// button reports success and no page ever opens.
	const nav = await callRunner<{ ok?: boolean }>(conn, "/browser/act", { action: "navigate", url: prompt.url }).catch(() => null);
	if (!nav) throw new HttpError(502, "Couldn't open the sign-in page in the runner's browser.");
	// The board card MUST exist before the handoff. The runner's /browser/handoff registers the
	// takeover in memory and then does `const task = this.store.getTask(taskId); if (task) {…}` —
	// the whole `needs_human` status flip and the human_handoff_required event live inside that
	// `if`. With an invented taskId no such task existed, so none of it ran: the button reported
	// success, the console said "take over the browser to finish signing in", and the Board (which
	// surfaces takeovers from `needs_human` tasks) showed nothing at all. The sign-in page sat open
	// on a machine the user may not be at, with no surface to drive it — while `authPromptGuidance`
	// told them to "open the takeover view".
	await mirrorRuntimeTask(c.env, instanceId, uid, {
		id: taskId,
		type: "engine.signin",
		status: "needs_human",
		title: "Sign in to the coding engine",
		subtitle: (() => { try { return new URL(prompt.url as string).host; } catch { return null; } })(),
		reasoning: authPromptGuidance(prompt),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}).catch(() => undefined);
	await callRunner<{ ok: boolean }>(conn, "/browser/handoff", {
		taskId,
		label: "Engine sign-in",
		reason: "challenge",
	}).catch(() => undefined);

	await logEvent(c.env, {
		source: "coding",
		event: "signin_relay",
		message: `Opened engine sign-in for ${session.id} in the runner's browser`,
		userId: uid,
		instanceId,
		traceId: sessionId,
		context: { taskId, host: (() => { try { return new URL(prompt.url as string).host; } catch { return null; } })() },
	}).catch(() => undefined);

	return c.json({ ok: true, kind: prompt.kind, taskId, url: prompt.url, guidance: authPromptGuidance(prompt) }, 200);
});

/**
 * Aggregate live status for ALL of this instance's active coding sessions in ONE call —
 * status only (runState), no terminal panes — so the console can poll once instead of N
 * per-session /capture calls. Owner-scoped; bounded fan-out to the runner. (CODER-006, #82)
 */
codingRoutes.get("/:instanceId/coding/status", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessions = (await listSessions(c.env, instanceId, uid)).filter((s) => s.status === "active");
	// Resolve the runner the way every other route does. `relayConnected(…, null)` names the
	// RelayDO `instanceId` with no node suffix, but every runner since the relay handshake
	// connects with `?node=<hostname>` — so its DO is `${instanceId}:node:${hostname}` and the
	// bare-name DO has never had a socket. This field was therefore ALWAYS false, contradicting
	// the per-session `runnerConnected` values computed correctly just below it.
	const runnerConnected = !!(await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null));
	const CONCURRENCY = 6;
	const out: Array<{ sessionId: string; repoId: string; runState: string; runnerConnected: boolean }> = [];
	for (let i = 0; i < sessions.length; i += CONCURRENCY) {
		const batch = sessions.slice(i, i + CONCURRENCY);
		const settled = await Promise.allSettled(
			batch.map(async (s) => {
				const conn = await getSessionRunnerConn(c.env, instanceId, uid, s);
				if (!conn) return { sessionId: s.id, repoId: s.repoId, runState: "idle", runnerConnected: false };
				const snap = await callRunner<{ runState?: string }>(conn, "/coding/capture", { sessionId: s.id }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
				return { sessionId: s.id, repoId: s.repoId, runState: snap?.runState || "idle", runnerConnected: true };
			}),
		);
		for (const r of settled) if (r.status === "fulfilled") out.push(r.value);
	}
	return c.json({ runnerConnected, sessions: out });
});

/** Persist a system/status message to the coding timeline (loop events, errors). */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/system-message", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const { content } = await c.req.json<{ content: string }>();
	if (!content || typeof content !== "string") return c.json({ error: "content required" }, 400);
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: content.slice(0, 2000) });
	return c.json({ ok: true });
});

/**
 * Co-pilot: read the live terminal and give the user a SHORT summary of what's
 * happening + what's needed from them, or answer a follow-up question. Uses the
 * user's BYOK Claude. The user reads this instead of the raw terminal.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/explain", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	// Verify the session belongs to this instance/user BEFORE touching its timeline —
	// the timeline helpers are scoped by sessionId alone.
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const body = (await c.req.json().catch(() => ({}))) as { question?: string; finished?: boolean; persist?: boolean };
	const question = typeof body.question === "string" ? body.question.trim() : "";
	const finished = body.finished === true;
	// The client's finish-watcher passes persist:false — the durable server watch
	// workflow already persists the finish summary, so persisting here too would
	// show a DUPLICATE bubble in the thread.
	const persist = body.persist !== false;

	// Capture the current terminal.
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	let pane = "";
	if (conn) {
		const snap = (await callRunner(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null)) as { pane?: string } | null;
		pane = snap?.pane ?? "";
	}

	// Persist the user's question and a terminal snapshot (if it changed) so the
	// session has a durable, continuous history.
	if (question) await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_user", content: question });
	if (pane.trim()) {
		const last = await lastTerminal(c.env, sessionId);
		if (pane.trim() !== (last ?? "").trim()) {
			await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "terminal", content: pane.slice(-8000) });
		}
	}

	// Continuity: feed the recent persisted timeline (prior chat, what the agent
	// did, outcomes) so the co-pilot remembers the session, not just this moment.
	const memory = await contextForCopilot(c.env, sessionId);
	// Inject instance + repo instructions into the co-pilot prompt.
	const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
	const instanceInstructions = await readSpecialInstructions(c.env, instanceId, uid);
	const repoInstructions = repo?.instructions;
	const combined = [instanceInstructions, repoInstructions].filter(Boolean).join("\n\n") || undefined;
	// Pass the runner connection + workDir so a substantive question can READ the real code
	// (read_file/git_diff/…) to ground its answer. Omitted for the auto-summary path (no
	// question) and when the runner is offline (conn null) → cheap terminal-only single shot.
	const reply = (await copilotSummary(c.env, uid, {
		question,
		memory,
		pane,
		finished,
		specialInstructions: combined,
		conn: conn ?? undefined,
		sessionId,
		workDir: repo?.workdir ?? undefined,
		githubRepo: repo?.githubRepo ?? undefined,
		instanceId,
	})) || "(no response)";
	// Don't persist a transient "runner offline / session hasn't started" auto-summary
	// — it's only true at this moment, and once the runner attaches it lingers at the
	// top of the thread as stale, confusing history. Show it live, but only save real
	// replies (an answer to a question, or a summary of an actual live terminal).
	const offlineAutoSummary = !question && !pane.trim();
	if (!offlineAutoSummary && persist) {
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply });
	}
	return c.json({ reply });
});

/**
 * Send an instruction to the repo's Claude (drive the CLI) + spin up the finish
 * watcher (deduped). Shared by the Agent endpoint's delegate path. Returns an ack.
 */
async function driveClaude(
	c: Context<{ Bindings: Env }>,
	instanceId: string,
	uid: string,
	sessionId: string,
	instruction: string,
	summary?: string,
): Promise<{ delegated: boolean; reply: string }> {
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) return { delegated: false, reply: "Coding session not found." };
	const conn0 = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn0) return { delegated: false, reply: "No coding runner connected — start it with: pags up" };
	let conn: RunnerConn = conn0;
	// NOTE: don't log a `command` turn here — the chat_assistant "On it — I asked
	// Claude to: …" already records it; a command entry would show a 3rd duplicate
	// bubble in the thread (loadChat surfaces commands as your turns).
	const act = () => callRunner(conn, "/coding/act", { sessionId, action: { kind: "message", text: instruction } }).catch(() => null);
	let snap = await act();
	const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
	if (snap === null && session && repo) {
		// Reattach a session lost to a runner restart — and on a machine SWITCH this relocates
		// the session to the live machine and returns THAT connection, so retry there (the
		// captured `conn` still points at the old, now-dead machine).
		const relocated = await startSessionOnRunner(c.env, instanceId, uid, session, repo);
		if (relocated) conn = relocated;
		snap = await act();
	}
	// Finish watcher (one per send: stamp the session so only the latest notifies).
	const watchId = `cw-${sessionId}-${Date.now()}`;
	await c.env.DB.prepare("UPDATE coding_sessions SET watch_workflow_id = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4")
		.bind(watchId, sessionId, instanceId, uid)
		.run()
		.catch(() => undefined);
	await c.env.CODING_SESSION.create({
		id: watchId,
		params: { instanceId, userId: uid, sessionId, repoId: repo?.id ?? "", runnerNode: session.runnerNode ?? null, mode: "watch", watchId, goal: { objective: instruction, repo: repo?.name ?? "your repo", clientType: session?.clientType ?? "claude" } },
	}).catch(async () => {
		// The finish-watcher failed to start — tell the user so the missing completion
		// summary isn't a silent "did it even work?".
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: "(Couldn't start the progress watcher — I won't auto-report when this finishes; ask me for an update.)" }).catch(() => undefined);
	});
	// Show the user a plain-language summary, NOT the raw (often long/technical)
	// instruction we sent to the CLI.
	const reply = summary ? `On it — ${summary}` : "On it — working on that now.";
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply }).catch(() => undefined);
	return { delegated: true, reply };
}

/**
 * Delegate a GOAL to the durable Pilot (#155). Unlike `driveClaude` (a one-shot instruction +
 * a finish-watcher), this hands the objective to the autonomous CodingSessionWorkflow — which
 * owns the snapshot→decide→act loop and stuck/needs_input escalation — and records an
 * OBSERVABLE board task so the delegation is trackable (board card + trace + session thread),
 * not a line buried in one repo's thread. Attributed as an agent action on the user's behalf,
 * never as a user turn. The Pilot flips the task to completed/failed at its terminal state.
 */
type DelegationOutcome =
	| { ok: true; taskId: string; reply: string; label: string }
	| { ok: false; reply: string };

async function delegateToTarget(
	c: Context<{ Bindings: Env }>,
	instanceId: string,
	uid: string,
	target: DelegationTarget,
	objective: string,
): Promise<DelegationOutcome> {
	// Refuse a parsed-but-not-runnable target explicitly (#156). Silently doing nothing would
	// leave a board card that looks delegated and never moves.
	if (!isExecutableTarget(target)) return { ok: false, reply: unsupportedTargetReason(target) };
	// Only `repo` is executable today (guarded above). Resolving the target HERE rather than in
	// the caller is the point of the change: a second target kind slots in without the route
	// learning anything about it.
	const repoId = targetId(target);
	const repo = await getRepo(c.env, instanceId, uid, repoId);
	const session = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
	const targetLabel = repo?.name ?? "that repo";
	if (!repo || !session) {
		return { ok: false, reply: `${targetLabel} has no live session — open it (or tap Start) first, then I can drive it.` };
	}

	const taskId = `deleg-${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	const label = objective.length > 120 ? `${objective.slice(0, 117)}…` : objective;
	// 1) Observable board task (running), attributed to the Overseer on the user's behalf.
	await mirrorRuntimeTask(c.env, instanceId, uid, delegationTaskRecord({ id: taskId, targetLabel: repo.name, objective, status: "running", now })).catch(() => undefined);
	// 2) Unified trace + the target session thread (visible, as an agent action).
	await logEvent(c.env, { source: "coding", event: "delegate", message: `Overseer → ${repo.name}: ${label}`, userId: uid, instanceId, traceId: taskId }).catch(() => undefined);
	await appendTimeline(c.env, { sessionId: session.id, instanceId, userId: uid, type: "chat_assistant", content: `On it — delegated to ${repo.name}: ${label} (tracking on the board)` }).catch(() => undefined);
	// 3) Hand the GOAL to the durable Pilot (objective mode owns the loop + escalation).
	const instanceInstructions = await readSpecialInstructions(c.env, instanceId, uid);
	const combined = [instanceInstructions, repo.instructions].filter(Boolean).join("\n\n");
	const goal: CodingGoal = { objective, repo: repo.name, clientType: session.clientType, specialInstructions: combined || undefined };
	const owner = repo.githubRepo ? repo.githubRepo.split("/")[0] : "";
	const token = owner ? await installationTokenForOwner(c.env, uid, owner).catch(() => null) : null;
	await c.env.CODING_SESSION.create({
		params: {
			instanceId, userId: uid, sessionId: session.id, repoId: repo.id,
			runnerNode: session.runnerNode ?? null, cloneUrl: repo.cloneUrl ?? undefined,
			branch: repo.branch || undefined, token: token ?? undefined, goal, boardTaskId: taskId,
		},
	});
	return { ok: true, taskId, label: targetLabel, reply: `On it — delegated to ${repo.name}; track it on the board.` };
}

/**
 * The Agent chat (Step 1 of #3): ONE input that either answers from the terminal +
 * history, or DELEGATES to Claude Code via the `drive_claude` tool — the LLM
 * decides. `@claude`/`/run` forces delegation. This tool-loop is the reusable core
 * the cross-repo Overseer (#9) will lift to global scope.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/agent", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	// Verify the session belongs to this instance/user before touching its timeline.
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const body = (await c.req.json().catch(() => ({}))) as { message?: string; audioKey?: string };
	const raw = String(body.message ?? "").trim();
	if (!raw) return c.json({ error: "message is required" }, 400);
	// A voice-dictated turn carries the R2 id of its saved recording so it can be
	// replayed (double-tap). Persisted with the turn.
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_user", content: raw, audioKey: body.audioKey }).catch(() => undefined);

	// Explicit force-delegate.
	if (/^(@claude|\/run)\b/i.test(raw)) {
		const cleaned = raw.replace(/^(@claude|\/run)\s*/i, "").trim() || raw;
		return c.json(await driveClaude(c, instanceId, uid, sessionId, cleaned));
	}

	// Otherwise: one tool-enabled call — answer from context OR call drive_claude.
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	let pane = "";
	if (conn) {
		const snap = (await callRunner(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null)) as { pane?: string } | null;
		pane = snap?.pane ?? "";
	}
	const memory = await contextForCopilot(c.env, sessionId);
	const system =
		"You are the co-pilot for an AI coding agent working in the user's repo. TWO rules:\n" +
		"1. If the user wants something DONE → call the `drive_claude` tool with ONE clear instruction. Don't do the work yourself.\n" +
		"2. If the user is ASKING (status, what happened, is it done) → answer FROM the terminal + session memory below.\n\n" +
		"STYLE: Talk to a NON-TECHNICAL user by default. Say WHAT was done and WHETHER it worked — never list filenames, commands, or code unless the user explicitly asks for details. " +
		"Wrong: 'Fixed overflow in PuzzleSets.tsx line 99'. Right: 'Fixed the horizontal scroll on the puzzle page.' " +
		"Only get technical when the user asks to elaborate, show code, or be more detailed.\n" +
		"Keep it to 1-2 sentences. Never pad. After delegating, say 'On it' + what you asked the agent to do in plain English.";
	const userMsg = `User: ${raw}\n\nSESSION MEMORY (recent):\n${memory || "(none)"}\n\nTERMINAL (recent):\n${pane.slice(-6000) || "(no live terminal)"}`;
	const tools = [
		{
			type: "function",
			function: {
				name: "drive_claude",
				description: "Delegate an action to Claude Code running in the repo (it edits files, runs commands). Use for any request to DO work.",
				parameters: { type: "object", properties: {
					instruction: { type: "string", description: "A single clear instruction for Claude Code — technical detail (file names, commands) is fine HERE; the CLI needs it." },
					summary: { type: "string", description: "A plain, NON-TECHNICAL one-line summary of what you asked, for the user. No file names, commands, or code. e.g. 'swapping the food field for a milk-type picker'." },
				}, required: ["instruction", "summary"] },
			},
		},
	];
	const res = (await runUserWorkersAi(c.env, uid, "claude-sonnet-4-6", {
		messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
		tools,
		maxTokens: 700,
	}, { kind: "overseer", instanceId }).catch(() => ({ response: "" }))) as { response?: string; tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> }> };
	const call = res.tool_calls?.find((t) => t.name === "drive_claude");
	const instruction = call && typeof call.arguments?.instruction === "string" ? (call.arguments.instruction as string).trim() : "";
	const summary = call && typeof call.arguments?.summary === "string" ? (call.arguments.summary as string).trim() : "";
	if (instruction) return c.json(await driveClaude(c, instanceId, uid, sessionId, instruction, summary || undefined));
	const reply = res.response || "(no response)";
	await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "chat_assistant", content: reply }).catch(() => undefined);
	return c.json({ delegated: false, reply });
});

/**
 * The cross-repo Overseer (#9, Step 2): ONE agent across ALL the user's repos. It
 * reads each repo's recent activity (global context) and either answers about
 * everything, or delegates an action to a SPECIFIC repo's Claude via
 * drive_claude(repoId, instruction). Same tool-loop as /agent, lifted to global
 * scope. Text-first; the continuous-voice layer comes later.
 */
codingRoutes.post("/:instanceId/coding/overseer", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as { message?: string };
	const raw = String(body.message ?? "").trim();
	if (!raw) return c.json({ error: "message is required" }, 400);

	// Global context: every repo, whether it has a live session, and its recent activity.
	const repos = await listRepos(c.env, instanceId, uid);
	const repoById = new Map(repos.map((r) => [r.id, r] as const));
	const blocks: string[] = [];
	for (const r of repos) {
		const active = await getActiveSessionForRepo(c.env, instanceId, uid, r.id);
		let recent = "(no live session)";
		if (active) {
			const term = await lastTerminal(c.env, active.id).catch(() => null);
			recent = term ? term.slice(-700) : "(session live, nothing captured yet)";
		}
		const repoRules = r.instructions ? `\nRepo instructions: ${r.instructions}` : "";
		blocks.push(`### REPO "${r.name}" (id: ${r.id})${active ? " — LIVE" : ""}${repoRules}\n${recent}`);
	}
	const context = blocks.join("\n\n").slice(0, 16000) || "(no repos yet)";

	// Inject the user's Special Instructions (if any) into the Overseer prompt
	const userInstructions = await readSpecialInstructions(c.env, instanceId, uid);
	const system =
		"You are the Overseer — ONE agent across ALL of the user's coding repos. You hold the global picture below (each repo + its recent activity). Decide:\n" +
		"- If the user ASKS about status / what's happening / what finished / which needs them → answer concisely from the context, comparing across repos when relevant.\n" +
		"- If the user wants something DONE in a specific repo → call drive_claude with that repo's id + ONE clear instruction. Infer the repo from their words; if genuinely ambiguous, ask which.\n" +
		"Plain language, tight. You can only drive repos that have a LIVE session." +
		(userInstructions ? `\n\nUSER SPECIAL INSTRUCTIONS (follow these):\n${userInstructions}` : "");
	const userMsg = `User: ${raw}\n\nALL REPOS (recent activity):\n${context}`;
	const tools = [
		{
			type: "function",
			function: {
				name: "drive_claude",
				description: "Delegate an action to a SPECIFIC repo's Claude Code (it edits files, runs commands). Only works for repos with a LIVE session.",
				parameters: { type: "object", properties: { repoId: { type: "string" }, instruction: { type: "string" } }, required: ["repoId", "instruction"] },
			},
		},
	];
	const res = (await runUserWorkersAi(c.env, uid, "claude-sonnet-4-6", {
		messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
		tools,
		maxTokens: 800,
	}, { kind: "overseer", instanceId }).catch(() => ({ response: "" }))) as { response?: string; tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> }> };

	const call = res.tool_calls?.find((t) => t.name === "drive_claude");
	// #156: the tool still speaks `repoId`, but the route no longer does — it hands an
	// addressable TARGET to the delegate path, which owns resolution and the refusal cases.
	const target = call ? parseDelegationTarget(call.arguments ?? {}) : null;
	const instruction = call && typeof call.arguments?.instruction === "string" ? (call.arguments.instruction as string).trim() : "";
	if (target && instruction) {
		// #155: delegate the GOAL to the durable Pilot + record an observable board task,
		// instead of a fire-and-forget one-shot with no follow-through.
		const r = await delegateToTarget(c, instanceId, uid, target, instruction);
		if (!r.ok) return c.json({ delegated: false, reply: r.reply });
		return c.json({ delegated: true, repoId: targetId(target), taskId: r.taskId, reply: `${r.label}: ${r.reply}` });
	}
	return c.json({ delegated: false, reply: res.response || "(no response)" });
});

/** Load a session's persisted conversation (so the console restores it on open). */
codingRoutes.get("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	// ?full=1 → include the full typed timeline (chat + terminal snapshots + brain
	// decisions + commands + outcomes) so the whole session can be copied as JSON.
	if (c.req.query("full") === "1") {
		return c.json({ chat: await loadChat(c.env, session.id), timeline: await loadTimeline(c.env, session.id) });
	}
	return c.json({ chat: await loadChat(c.env, session.id) });
});

/** Clear a session's conversation thread (keeps the activity log). */
codingRoutes.delete("/:instanceId/coding/sessions/:sessionId/timeline", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	await clearChat(c.env, session.id, uid, instanceId);
	return c.json({ ok: true });
});

/** Send a message / keys straight to the CLI (manual drive, no brain). */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/message", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const action: CodingActionKind =
		typeof body.keys === "string"
			? { kind: "keys", keys: body.keys }
			: { kind: "message", text: String(body.text ?? "") };
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	// `chat:true` = sent from the Agent chat (relay my words to Claude on my behalf),
	// so persist it as a chat turn (survives reload) — not just the raw command log.
	const fromChat = body.chat === true;
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) throw new HttpError(409, "No coding runner connected. Start it with: pags up");
	if (action.kind === "message" && action.text) {
		// Log the user's clean text first…
		await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: fromChat ? "chat_user" : "command", content: action.text }).catch(() => undefined);
		// …then prepend the combined rules (instance Special Instructions + per-repo
		// Rules) before sending to the CLI. Manual sends bypass the autonomous brain
		// (which injects rules into its own prompt), so without this the CLI never sees
		// them. This makes the rules bind the CLI no matter how it's driven.
		const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
		const combined = [await readSpecialInstructions(c.env, instanceId, uid), repo?.instructions].filter(Boolean).join("\n\n");
		if (combined) action.text = `[Project rules — follow these for everything you do:\n${combined}\n]\n\n${action.text}`;
	}
	let snap = await callRunner(conn, "/coding/act", { sessionId, action }).catch(() => null);
	if (snap === null) {
		// The runner is online but lost the in-memory session (it restarted) — its
		// tmux pane usually survives, so reattach (CodingSession.start reconnects to
		// the live tmux, no new CLI) and retry once. On a machine SWITCH, startSessionOnRunner
		// relocates the session and returns the LIVE machine's connection — retry on that, not
		// the captured `conn` (which points at the old, now-dead machine → 409).
		const fresh = await getSession(c.env, instanceId, uid, sessionId);
		const repo = fresh ? await getRepo(c.env, instanceId, uid, fresh.repoId) : null;
		const relocated = fresh && repo ? await startSessionOnRunner(c.env, instanceId, uid, fresh, repo) : null;
		snap = await callRunner(relocated ?? conn, "/coding/act", { sessionId, action }).catch(() => null);
	}
	if (snap === null) throw new HttpError(409, "This session isn't live on the runner — open it again (or run pags up).");

	// Drove the CLI with a real instruction → spin up a durable watcher that waits
	// for it to finish, then summarizes + notifies (reaches the user even if they
	// close the console). Each send supersedes the prior watcher: we stamp the
	// session with this watcher's id, and a watcher only notifies if it's still the
	// stamped one — so several sends can't fire several push notifications for one
	// completion.
	if (action.kind === "message" && action.text) {
		const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
		const watchId = `cw-${sessionId}-${Date.now()}`;
		await c.env.DB.prepare(
			"UPDATE coding_sessions SET watch_workflow_id = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
		)
			.bind(watchId, sessionId, instanceId, uid)
			.run()
			.catch(() => undefined);
		await c.env.CODING_SESSION.create({
			id: watchId,
			params: {
				instanceId,
				userId: uid,
				sessionId,
				repoId: repo?.id ?? "",
				runnerNode: session.runnerNode ?? null,
				mode: "watch",
				watchId,
				goal: { objective: action.text, repo: repo?.name ?? "your repo", clientType: session?.clientType ?? "claude" },
			},
		}).catch(async () => {
			await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: "(Couldn't start the progress watcher — I won't auto-report when this finishes; ask me for an update.)" }).catch(() => undefined);
		});
	}
	return c.json(snap as object);
});

/** Hand the session to the autonomous brain (the durable Workflow) with an objective. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/run", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const repo = await getRepo(c.env, instanceId, uid, session.repoId);
	if (!repo) throw new HttpError(404, "Repo not found");
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const objective = String(body.objective ?? "").trim();
	if (!objective) return c.json({ error: "objective is required" }, 400);

	const instanceInstructions = await readSpecialInstructions(c.env, instanceId, uid);
	const repoInstructions = repo.instructions;
	const combined = [instanceInstructions, repoInstructions].filter(Boolean).join("\n\n");
	const goal: CodingGoal = {
		objective,
		repo: repo.name,
		clientType: session.clientType,
		specialInstructions: combined || undefined,
		dryRun: body.dryRun === true,
	};
	const owner = repo.githubRepo ? repo.githubRepo.split("/")[0] : "";
	const token = owner ? await installationTokenForOwner(c.env, uid, owner) : null;
	const wf = await c.env.CODING_SESSION.create({
		params: {
			instanceId,
			userId: uid,
			sessionId,
			repoId: repo.id,
			runnerNode: session.runnerNode ?? null,
			cloneUrl: repo.cloneUrl,
			branch: repo.branch || undefined,
			token: token ?? undefined,
			goal,
		},
	});
	return c.json({ workflowId: wf.id, sessionId });
});

/** Resolve a brain handoff: the human finished, so the workflow may resume. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/resume", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const session = await getSession(c.env, instanceId, uid, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) throw new HttpError(409, "No coding runner connected");
	await callRunner(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/resolve`, {
		value: typeof body.value === "string" ? body.value : undefined,
	}).catch(() => undefined);
	return c.json({ ok: true });
});

/** End a session: stop the runner's tmux + close the D1 record. */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/end", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const sessionId = c.req.param("sessionId");
	const session = await getSession(c.env, instanceId, uid, sessionId);
	const conn = session ? await getSessionRunnerConn(c.env, instanceId, uid, session) : null;
	if (conn) await callRunner(conn, "/coding/end", { sessionId }).catch(() => undefined);
	const ok = await endSession(c.env, instanceId, uid, sessionId);
	return c.json({ ok });
});

/**
 * Diagnostics: restart a session's CLI process on the runner (kill + relaunch
 * with the SAME session id, keeping the D1 row). For recovering a wedged engine
 * without losing the session/timeline.
 */
codingRoutes.post("/:instanceId/coding/sessions/:sessionId/restart", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
	if (!session) throw new HttpError(404, "Session not found");
	if (session.status !== "active") return c.json({ ok: false, error: "session has ended" }, 409);
	const repo = await getRepo(c.env, instanceId, uid, session.repoId);
	if (!repo) throw new HttpError(404, "Repo not found");
	const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
	if (!conn) return c.json({ ok: false, runnerConnected: false });
	await callRunner(conn, "/coding/end", { sessionId: session.id }).catch(() => undefined);
	const started = await startSessionOnRunner(c.env, instanceId, uid, session, repo);
	if (!started) {
		// Re-read the repo to get the clone error
		const freshRepo = await getRepo(c.env, instanceId, uid, session.repoId);
		return c.json({ ok: false, runnerConnected: true, error: freshRepo?.cloneError || "Failed to start session on runner" });
	}
	return c.json({ ok: true, runnerConnected: true });
});

/** Kill tmux sessions on the runner (orphaned, specific, or all pags-*). */
codingRoutes.post("/:instanceId/coding/kill-tmux", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ error: "Runner not connected", runnerConnected: false }, 502);
	const body = await c.req.json<{ sessions?: string[]; orphansOnly?: boolean }>();
	const result = await callRunner(conn, "/coding/kill-tmux", body, { timeoutMs: READ_TIMEOUT_MS });
	return c.json(result);
});

/** List directories on the runner (for remote browsing). */
codingRoutes.get("/:instanceId/coding/browse", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ error: "Runner not connected" }, 502);
	const dir = c.req.query("dir") || "~";
	const result = await callRunner(conn, "/coding/browse", { dir }, { timeoutMs: READ_TIMEOUT_MS });
	return c.json(result);
});

/**
 * Full diagnostics: runner, tmux, sessions, repos, GitHub, detected issues.
 * The console's transparency view — everything the user needs to self-diagnose.
 */
codingRoutes.get("/:instanceId/coding/diagnostics", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const env = c.env;

	// 1. Runner connection (D1 row)
	const runtimeRow = await env.DB.prepare(
		"SELECT endpoint_url, capabilities, runner_version, runner_node, status, last_seen_at, placement, created_at, updated_at FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2",
	).bind(instanceId, uid).first<{
		endpoint_url: string | null; capabilities: string | null; runner_version: string | null;
		runner_node: string | null; status: string | null; last_seen_at: string | null;
		placement: string | null; created_at: string | null; updated_at: string | null;
	}>();

	const runner: Record<string, unknown> = {
		registered: !!runtimeRow,
		status: runtimeRow?.status ?? "unregistered",
		endpointUrl: runtimeRow?.endpoint_url ?? null,
		placement: runtimeRow?.placement ?? null,
		capabilities: parseJsonOr(runtimeRow?.capabilities, [] as unknown),
		runnerVersion: runtimeRow?.runner_version ?? null,
		runnerNode: runtimeRow?.runner_node ?? null,
		lastSeenAt: runtimeRow?.last_seen_at ?? null,
		registeredAt: runtimeRow?.created_at ?? null,
	};

	// 2. Live runner probe
	const conn = await getRunnerConn(env, instanceId, uid, runtimeRow?.runner_node ?? null);
	let runnerHealth: unknown = null;
	let runnerDiag: unknown = null;
	let runnerReachable = false;
	const relayName = conn?.relayName ?? null;
	if (conn) {
		try {
			runnerHealth = await callRunner<unknown>(conn, "/health", undefined, { timeoutMs: READ_TIMEOUT_MS });
			runnerReachable = true;
		} catch (e) {
			runnerHealth = { error: e instanceof Error ? e.message : String(e) };
		}
		try {
			runnerDiag = await callRunner<unknown>(conn, "/coding/diagnostics", undefined, { timeoutMs: READ_TIMEOUT_MS });
		} catch (e) {
			runnerDiag = { error: e instanceof Error ? e.message : String(e) };
		}
	}
	const relayIsConnected = await relayConnected(env, instanceId, runtimeRow?.runner_node ?? null);
	const effectivelyReachable = runnerReachable;

	(runner as Record<string, unknown>).reachable = effectivelyReachable;
	(runner as Record<string, unknown>).health = runnerHealth;

	// 3. D1 sessions + repos
	const [dbSessions, dbRepos] = await Promise.all([
		listSessions(env, instanceId, uid),
		listRepos(env, instanceId, uid),
	]);

	// 4. Cross-reference D1 active sessions vs runner's tracked sessions
	const trackedIds = new Set<string>();
	const diagData = runnerDiag as { tracked?: Array<{ sessionId: string; alive: boolean; runState: string; paneLines: number; clientType: string; workDir: string; tmuxSession: string; takeover: boolean }>; orphanedTmux?: string[]; tmuxTotal?: number; pagsTmuxTotal?: number } | null;
	if (diagData?.tracked) {
		for (const t of diagData.tracked) trackedIds.add(t.sessionId);
	}

	// Self-heal (#139): the runner is confirmed reachable, so any D1-`active` session it
	// isn't tracking is a genuine orphan (runner restart / machine reboot left the tmux
	// gone). Mark those ended so they stop showing as active forever and can't be reused
	// as dead sessions — instead of only detecting them and telling the user to kill each
	// by hand. Grace-windowed inside the store so a just-spawned session isn't reaped.
	let reconciled = new Set<string>();
	if (effectivelyReachable) {
		reconciled = new Set(await reconcileOrphanedSessions(env, instanceId, uid, trackedIds).catch(() => []));
	}

	const sessions = dbSessions.map((s) => {
		// Reflect a just-reconciled orphan as ended (D1 was updated above).
		if (reconciled.has(s.id)) {
			const repo = dbRepos.find((r) => r.id === s.repoId);
			return {
				id: s.id, repoId: s.repoId, repoName: repo?.name ?? s.repoId,
				status: "ended" as const, clientType: s.clientType,
				launchCommand: s.launchCommand ?? null, tmuxSession: s.tmuxSession ?? null,
				startedAt: s.startedAt, endedAt: new Date().toISOString(), live: null,
				issue: null, reconciled: true,
			};
		}
		return mapDiagSession(s);
	});

	function mapDiagSession(s: (typeof dbSessions)[number]) {
		const tracked = diagData?.tracked?.find((t) => t.sessionId === s.id);
		const repo = dbRepos.find((r) => r.id === s.repoId);
		return {
			id: s.id,
			repoId: s.repoId,
			repoName: repo?.name ?? s.repoId,
			status: s.status,
			clientType: s.clientType,
			launchCommand: s.launchCommand ?? null,
			tmuxSession: s.tmuxSession ?? null,
			startedAt: s.startedAt,
			endedAt: s.endedAt ?? null,
			// Live state from the runner (null if runner is offline or session not tracked)
			live: tracked ? {
				alive: tracked.alive,
				runState: tracked.runState,
				paneLines: tracked.paneLines,
				workDir: tracked.workDir,
				underTakeover: tracked.takeover,
			} : null,
			// Issue detection
			issue: s.status === "active" && !tracked
				? (effectivelyReachable ? "orphaned: D1 says active but runner has no tmux for it" : "unknown: runner offline")
				: s.status === "active" && tracked && !tracked.alive
					? "dead: tracked but CLI process exited"
					: null,
		};
	}

	const repos = dbRepos.map((r) => {
		const activeSessions = sessions.filter((s) => s.repoId === r.id && s.status === "active");
		return {
			id: r.id,
			name: r.name,
			githubRepo: r.githubRepo ?? null,
			cloneUrl: r.cloneUrl ?? null,
			branch: r.branch,
			workdir: r.workdir ?? null,
			cloneStatus: r.cloneStatus,
			cloneError: r.cloneError ?? null,
			defaultClient: r.defaultClient,
			urls: r.urls ?? null,
			activeSessions: activeSessions.length,
			issue: r.cloneStatus === "error" ? `clone failed: ${r.cloneError || "unknown error"}`
				: r.cloneStatus === "missing_url" ? "no clone URL and no local path"
				: null,
		};
	});

	// 5. GitHub App status
	const githubApp = {
		configured: githubAppConfigured(env),
	};

	// 6. Auto-detected issues
	const issues: Array<{ severity: "error" | "warn" | "info"; message: string; fix?: string }> = [];

	if (!runtimeRow) {
		issues.push({ severity: "error", message: "No runner registered for this instance", fix: "Run `pags up` to connect your machine" });
	} else if (runtimeRow.status === "offline" && !relayIsConnected) {
		issues.push({ severity: "error", message: "Runner status is offline", fix: "Restart `pags up` to reconnect" });
	} else if (!effectivelyReachable) {
		issues.push({ severity: "error", message: "Runner registered but not reachable", fix: "Restart `pags up` to reconnect" });
	}

	for (const s of sessions) {
		if (s.issue) issues.push({ severity: "warn", message: `Session ${s.id.slice(-8)} (${s.repoName}): ${s.issue}`, fix: s.issue.startsWith("orphaned") ? "Kill the session and start a new one" : "Restart the session from ⚙" });
	}
	for (const r of repos) {
		if (r.issue) issues.push({ severity: "warn", message: `Repo "${r.name}": ${r.issue}`, fix: r.cloneStatus === "error" ? "Delete and re-add the repo, or fix the clone URL" : undefined });
	}

	if (diagData?.orphanedTmux?.length) {
		issues.push({ severity: "info", message: `${diagData.orphanedTmux.length} orphaned tmux session(s): ${diagData.orphanedTmux.join(", ")}`, fix: "Use the 'Kill orphaned' button in the tmux section above" });
	}

	const activeSessions = sessions.filter((s) => s.status === "active");
	const healthySessions = activeSessions.filter((s) => s.live?.alive);

	return c.json({
		summary: {
			runnerOnline: effectivelyReachable,
			runnerStatus: runner.status,
			relayConnected: relayIsConnected,
			relayName,
			totalRepos: repos.length,
			totalSessions: sessions.length,
			activeSessions: activeSessions.length,
			healthySessions: healthySessions.length,
			issueCount: issues.filter((i) => i.severity === "error" || i.severity === "warn").length,
		},
		runner,
		relay: { connected: relayIsConnected, relayName, runnerNode: runtimeRow?.runner_node ?? null },
		tmux: diagData ? {
			trackedSessions: diagData.tracked?.length ?? 0,
			orphanedSessions: diagData.orphanedTmux ?? [],
			tmuxTotal: diagData.tmuxTotal ?? 0,
			pagsTmuxTotal: diagData.pagsTmuxTotal ?? 0,
		} : null,
		sessions,
		repos,
		githubApp,
		issues,
	});
});
