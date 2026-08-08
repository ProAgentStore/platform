/**
 * The Coder's REPO surface: what the agent is pointed at, and what GitHub says about it (#305).
 *
 * Fifteen routes, split out of `routes/coding.ts` along the boundary the registrations already
 * had — everything here answers a question about a REPOSITORY (add/remove it, name it, its
 * rules, its builds, its issues, which issue is next), and nothing here touches a live engine.
 * That is why the whole module reaches the runner exactly once, in `detect-github`, and only
 * to read a git remote.
 *
 * Registered from the position the block occupied in `coding.ts` — Hono matches in
 * registration ORDER, so moving a block past a sibling pattern is a behaviour change even when
 * the route set is unchanged. `coding.contract.test.ts` pins the order for that reason.
 */
import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../lib/runner-client.js";
import { githubAppConfigured, installationTokenForOwner } from "../lib/github-app.js";
import { resolveGithubRead } from "../lib/github-cache.js";
import { computeETag, mergeRuns, persistBuildHistory, readBuildHistory, type BuildRun } from "../lib/build-history.js";
import { fetchWorkflowRuns, mapWorkflowRun } from "../lib/github-actions.js";
import { listIssues, readIssue, type IssueDetail } from "../lib/github-issues.js";
import { logError } from "../lib/error-log.js";
import { asClient } from "../lib/coding-engines.js";
import { createRepo, deleteRepo, getActiveSessionForRepo, getRepo, listRepos, listSessions, updateRepo, updateRepoClone } from "../lib/coding-store.js";
import { checkWorkdirVia, cloneStatusForVerdict, isWorkdirBroken, type WorkdirVerdict } from "../lib/coding-workdir.js";
import type { CloneStatus, CodingRepo } from "../lib/coding-types.js";
import { mergePolicyPatch } from "../lib/coding-authority.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import { gitProviderFor, hostedFeatureUnavailable, parseRepoRef } from "../lib/git-providers.js";
import { getSessionRunnerConn, ownerOf, pickNextIssue, requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/** "~/dev/stores/pags/platform" → "pags/platform" — a less generic default name. */
function lastTwoSegments(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
	return parts.slice(-2).join("/");
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
async function nextOpenIssue(env: Env, userId: string, githubRepo: string, opts: { labels?: string; exclude: Set<number> }): Promise<IssueDetail | null> {
	const issues = await listIssues(env, userId, githubRepo, { state: "open", labels: opts.labels });
	const next = pickNextIssue(issues, opts.exclude);
	return next ? readIssue(env, userId, githubRepo, next.number) : null;
}

/**
 * Latest GitHub Actions run for an `owner/repo`, for a verified installation. Returns
 * `{ available:false }` (never throws) for a non-GitHub repo, a missing/failed installation
 * token, or a GitHub error — so the aggregate below can degrade per-repo. Shared by /builds
 * and by /deployment, which used to repeat this body verbatim (#304).
 *
 * The single highest-frequency GitHub read on the platform: /builds fans this out once per repo,
 * and the repos page polls every ~25s. `resolveGithubRead` replaces the bare
 * `installationTokenForOwner` so the conditional cache (#401) gets its identity from the SAME
 * resolution that produced the token — the tenancy rule #418 names, and the reason this is not a
 * `uid` handed in from the surrounding request. An unnameable installation resolves to
 * `authContext: null`, which means "do not cache", so the read falls back to exactly the plain
 * fetch it did before rather than to someone else's entry.
 */
async function latestRunFor(env: Env, uid: string, full: string | undefined): Promise<{ available: boolean; run: BuildRun | null }> {
	if (!full?.includes("/") || !githubAppConfigured(env)) return { available: false, run: null };
	const { token, authContext } = await resolveGithubRead(env, uid, ownerOf(full));
	if (!token) return { available: false, run: null };
	const res = await fetchWorkflowRuns(full, token, { perPage: 1 }, { env, identity: { userId: uid, authContext } });
	if ("status" in res) return { available: false, run: null };
	return { available: true, run: res.runs[0] ? mapWorkflowRun(res.runs[0]) : null };
}

/** No runner to ask — a fact about the CONNECTION, never about the path (see coding-workdir). */
function unverified(workDir: string): WorkdirVerdict {
	return {
		state: "unverified",
		path: workDir,
		detail: `\`${workDir}\` has not been checked — no machine is connected. Run \`pags up\` on the machine that has this checkout.`,
	};
}

/**
 * Ask the machine what is at a local repo's path, and store what we learned (#405).
 *
 * `onUnverified` is the whole difference between the two callers, and it is deliberate:
 *
 *   - ADD time passes `"unknown"`. A path nobody has looked at must not be called `ready` —
 *     `ready` is the same word a successful clone gets, and writing it about an unseen path is
 *     what let an empty directory look usable for two days.
 *   - LIST time passes `null` (leave it). A machine that has gone offline says nothing new about
 *     a path it verified yesterday, and downgrading on its absence would flip every repo in the
 *     list every time a laptop closed — while the offline banner already says the true thing.
 *
 * Never throws, and never writes when nothing changed.
 */
async function verifyLocalWorkdir(
	env: Env,
	repo: CodingRepo,
	conn: RunnerConn | null,
	opts: { onUnverified: CloneStatus | null },
): Promise<{ repo: CodingRepo; verdict: WorkdirVerdict }> {
	const workdir = repo.workdir;
	if (!workdir) return { repo, verdict: { state: "ok", path: "", detail: "" } };
	const verdict = conn ? await checkWorkdirVia(conn, workdir) : unverified(workdir);
	const status = verdict.state === "unverified" ? opts.onUnverified : cloneStatusForVerdict(verdict);
	if (!status) return { repo, verdict };
	const cloneError = verdict.detail || null;
	if (repo.cloneStatus === status && (repo.cloneError ?? null) === cloneError) return { repo, verdict };
	await updateRepoClone(env, repo.id, { cloneStatus: status, cloneError });
	return { repo: { ...repo, cloneStatus: status, cloneError: cloneError ?? undefined }, verdict };
}

/**
 * How many local repos one list request will verify. A checkout can be moved or deleted long
 * after it was added — the same state arriving later — so the list is where it has to be caught.
 * The cap (and the short per-call timeout in coding-workdir) is what keeps the Coding tab's first
 * paint bounded when a machine is connected but slow.
 */
const MAX_VERIFY_PER_LIST = 12;

export function registerRepoRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	codingRoutes.get("/:instanceId/coding/repos", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repos = await listRepos(c.env, instanceId, uid);
		const local = repos.filter((r) => r.workdir).slice(0, MAX_VERIFY_PER_LIST);
		if (!local.length) return c.json({ repos });
		const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
		if (!conn) return c.json({ repos });
		// One relay command each, in parallel on the one socket — the worst case is a single
		// WORKDIR_CHECK_TIMEOUT_MS, not one per repo.
		const settled = await Promise.allSettled(local.map((r) => verifyLocalWorkdir(c.env, r, conn, { onUnverified: null })));
		const fresh = new Map<string, CodingRepo>();
		for (const s of settled) if (s.status === "fulfilled") fresh.set(s.value.repo.id, s.value.repo);
		return c.json({ repos: repos.map((r) => fresh.get(r.id) ?? r) });
	});

	codingRoutes.post("/:instanceId/coding/repos", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const name = String(body.name ?? "").trim();
		const githubRepoIn = typeof body.githubRepo === "string" ? body.githubRepo : undefined;
		const cloneUrlIn = typeof body.cloneUrl === "string" ? body.cloneUrl : undefined;
		// A local checkout the user already has on the runner machine — run there, no clone.
		const localPath = typeof body.localPath === "string" ? body.localPath.trim() : "";
		if (localPath) {
			const created = await createRepo(c.env, instanceId, uid, {
				// A bare folder name ("platform") is ambiguous — default to the last two
				// path segments ("pags/platform"). Editable later either way.
				name: name || lastTwoSegments(localPath) || "repo",
				workdir: localPath,
				provider: "local",
				defaultClient: asClient(body.defaultClient),
			});
			// `createRepo` optimistically calls any local path `ready`. Ask the machine that will
			// run in it BEFORE letting that stand (#405): the runner is connected at this moment
			// and can answer all three questions — does it exist, does it hold anything, is it a
			// checkout — and it was simply never asked.
			//
			// Still a 201, not a 400. The row is the handle the owner needs to fix or delete the
			// repo, and refusing to create it would leave them with a typo and no way to see it;
			// what changes is that the row says what is wrong instead of saying `ready`.
			const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
			const { repo, verdict } = await verifyLocalWorkdir(c.env, created, conn, { onUnverified: "unknown" });
			return c.json(isWorkdirBroken(verdict) ? { repo, warning: verdict.detail } : { repo }, 201);
		}
		// A clone URL alone is enough: it carries the provider, the slug and the web URL (#221).
		// The URL is the AUTHORITY when both arrive — `githubRepo` and `cloneUrl` are independent
		// body fields, so a GitLab URL paired with a GitHub coordinate must not be stored as a
		// GitHub repo. (It is also what stops that pair minting an installation token; the
		// credential seam re-checks the host, so this is defence in depth rather than the fix.)
		const ref = parseRepoRef(cloneUrlIn);
		// No URL and no coordinate is a placeholder the owner will point at a source later —
		// `local`, not `other`: it has no remote to be honest or dishonest about.
		const provider = ref ? ref.provider : githubRepoIn ? "github" : cloneUrlIn ? "other" : "local";
		const slug = ref ? ref.slug : (githubRepoIn ?? "");
		// `github_repo` stays populated for GitHub ONLY — every GitHub reader (issues, Actions,
		// deploy watch, the supervisor's coordinates) still keys off it, and writing a GitLab
		// path into it is precisely the "pretending they are GitHub" this issue is about.
		const githubRepo = provider === "github" ? slug || undefined : undefined;
		// An https URL is canonicalised (a pasted browser path is not cloneable); ssh is kept
		// verbatim so the machine's own keys still do the work.
		const cloneUrl = ref?.cloneUrl || cloneUrlIn;
		// Default to the full slug — a bare repo name ("platform") is too generic to tell
		// projects apart. The user can rename it afterwards.
		const derivedName =
			name || slug || (cloneUrl ? cloneUrl.replace(/\.git$/, "").replace(/\/$/, "").split("/").pop() : "");
		if (!derivedName && !cloneUrl) return c.json({ error: "a repo name or URL is required" }, 400);
		const repo = await createRepo(c.env, instanceId, uid, {
			name: derivedName || "repo",
			githubRepo,
			provider,
			repoSlug: slug || undefined,
			webUrl: ref?.webUrl || undefined,
			cloneUrl,
			branch: typeof body.branch === "string" ? body.branch : undefined,
			defaultClient: asClient(body.defaultClient),
		});
		return c.json({ repo }, 201);
	});

	/**
	 * Auto-associate a LOCAL-PATH repo with its hosted identity by reading the local checkout's
	 * `origin` remote via the runner — so build status can query Actions for a repo you run from
	 * a local checkout (which otherwise has no githubRepo). Idempotent: returns the existing
	 * githubRepo if already set; { githubRepo: null } (never a 500) when there's no runner or no
	 * origin.
	 *
	 * Since #221 it also records a NON-GitHub origin (provider + slug + web URL) rather than
	 * discarding it — a GitLab checkout used to come back `{githubRepo:null}` and stay badged
	 * "local" forever. The route KEEPS its name and its `githubRepo` field: the console polls it
	 * on every load, so renaming it would break every deployed client for a cosmetic gain.
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
		// The same parser the clone-URL path uses — https, ssh, or scp-like, any known host.
		const ref = parseRepoRef(remote);
		if (!ref?.slug) return c.json({ githubRepo: null, detected: false });
		const githubRepo = ref.provider === "github" ? ref.slug : null;
		await c.env.DB.prepare(
			"UPDATE coding_repos SET github_repo = COALESCE(?1, github_repo), provider = ?5, repo_slug = ?6, web_url = ?7, updated_at = datetime('now') WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
		)
			.bind(githubRepo, repo.id, instanceId, uid, ref.provider, ref.slug, ref.webUrl || null)
			.run();
		return c.json({ githubRepo, provider: ref.provider, repoSlug: ref.slug, detected: true });
	});

	codingRoutes.delete("/:instanceId/coding/repos/:repoId", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repoId = c.req.param("repoId");
		// End any active sessions on the runner before deleting from DB. Deleting the repo removes the
		// last handle to those sessions, so a stop that quietly failed left a CLI process writing to a
		// checkout that no API could reach any more — no repo id, no session id, only `ps`. The delete
		// still proceeds (the user asked for it, and blocking on a flaky runner traps them with a repo
		// they cannot remove), but a failure is recorded and reported instead of vanishing.
		const sessions = await listSessions(c.env, instanceId, uid);
		const orphaned: string[] = [];
		for (const s of sessions.filter((s) => s.repoId === repoId && s.status === "active")) {
			const conn = await getSessionRunnerConn(c.env, instanceId, uid, s);
			if (!conn) continue; // machine is offline — there is no process left to stop
			const err = await callRunner(conn, "/coding/end", { sessionId: s.id }).then(
				() => null,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			);
			if (err) {
				orphaned.push(s.id);
				await logError(c.env, {
					source: "coding",
					userId: uid,
					message: `Engine for session ${s.id} did not stop while deleting its repo: ${err}`,
					context: { instanceId, sessionId: s.id, repoId },
				});
			}
		}
		const ok = await deleteRepo(c.env, instanceId, uid, repoId);
		if (!ok) throw new HttpError(404, "Repo not found");
		return c.json(
			orphaned.length
				? {
						ok: true,
						enginesStopped: false,
						warning: `The repo was removed, but ${orphaned.length} engine process(es) did not confirm they stopped and may still be running on your machine.`,
					}
				: { ok: true },
		);
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
	 * Latest GitHub Actions run for a repo — so the console can show build/deploy
	 * status (running / failed / live) independently of the agent. OPTIONAL: returns
	 * { available:false } for local repos, non-GitHub repos, or when the GitHub App
	 * isn't installed — so it never breaks anything.
	 */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/deployment", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		const latest = await latestRunFor(c.env, uid, repo.githubRepo);
		// The unavailable body stays `{available:false}` with NO `run` key, which is what this route
		// has always put on the wire — `latestRunFor` carries `run:null` alongside it for its other
		// caller. De-duplicating the lookup must not change the response shape (#304).
		return c.json(latest.available ? latest : { available: false });
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
		const owner = ownerOf(full);
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
			// `githubRepo` travels too: the console applies ONE naming rule (repo-title.ts) — the GitHub
			// coordinate when there is one, else the folder name — and cannot without it.
			return { repoId: r.id, repoName: r.name, githubRepo: r.githubRepo ?? null, available: res?.available ?? false, run: res?.run ?? null };
		});
		return c.json({ builds });
	});

	/**
	 * GitHub issues for a repo (read-only, cloud→GitHub — works on any runner). Public
	 * repos work unauthenticated; private repos need the GitHub App installed for the owner.
	 * 400 for anything else; the Issues panel hides in that case.
	 *
	 * DEFERRED (#221): GitLab and Bitbucket issues. This route FAILS CLEANLY for them — it says
	 * "not supported for GitLab yet", not "isn't connected to GitHub", which is what a
	 * provider-blind `!githubRepo` check used to tell a perfectly well-connected GitLab repo.
	 */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/issues", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		if (!repo.githubRepo?.includes("/")) {
			return c.json({ error: hostedFeatureUnavailable(gitProviderFor(repo.provider), "issues") }, 400);
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
			return c.json({ error: hostedFeatureUnavailable(gitProviderFor(repo.provider), "issues") }, 400);
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
		// Patch just this key (#231). The read-parse-catch dance is gone with it: a corrupt config
		// no longer has to be "overwritten", because json_set coerces it in SQL and only this key
		// is touched — so a malformed blob can't cost the owner their other settings either.
		await patchInstanceConfig(c.env, instanceId, uid, "workMode", workMode);
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
			return c.json({ error: hostedFeatureUnavailable(gitProviderFor(repo.provider), "issues") }, 400);
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
			mergePolicy?: string;
		};
		const name = typeof body.name === "string" ? body.name.trim() : undefined;
		const hasUrls = body.urls !== undefined && typeof body.urls === "object";
		const policy = mergePolicyPatch(body.mergePolicy); // #314 — merge authority for THIS repo
		if (!policy.ok) return c.json({ error: policy.error }, 400);
		if (!name && !hasUrls && policy.value === undefined) return c.json({ error: "name, urls or mergePolicy is required" }, 400);
		const ok = await updateRepo(c.env, instanceId, uid, c.req.param("repoId"), {
			name: name || undefined,
			urls: hasUrls ? body.urls : undefined,
			mergePolicy: policy.value,
		});
		if (!ok) throw new HttpError(404, "Repo not found");
		return c.json({ ok: true });
	});
}
