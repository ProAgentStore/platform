/**
 * The Coder's self-diagnosis surface (#305): what the platform thinks is true, checked against
 * what the machine reports, with the disagreements named.
 *
 * Split out of `routes/coding.ts` because it is the one part of the file that READS the whole
 * control plane rather than acting on a piece of it — runtime row, live relay, sessions, repos,
 * engine presets — and then reconciles it (#139/#275: an active D1 row a reachable runner isn't
 * tracking is a genuine orphan and gets closed here).
 *
 * It is also the page a user opens when everything else is broken, which is why nothing in it may
 * throw on bad data: a corrupt JSON column degrades to a default rather than 500ing the only
 * screen that could explain why.
 *
 * Registered from the position the block occupied in `coding.ts` — Hono matches in
 * registration ORDER, which `coding.contract.test.ts` pins.
 */
import type { Context, Hono } from "hono";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { githubAppConfigured } from "../lib/github-app.js";
import { engineAuthFor, engineAuthReport, engineInvocationReport, readEngines, type EngineAuthResolved, type EngineInvocationMode } from "../lib/coding-engines.js";
import { type TrackedGhGuard, writeEnforcementReport } from "../lib/coding-write-enforcement.js";
import { codingRunsForSessions, type CodingRunFact } from "../lib/board-runs.js";
import { refusingEngineIssue } from "../lib/coding-run-state.js";
import { listRepos, listSessions, reconcileOrphanedSessions } from "../lib/coding-store.js";
import { relayNameForInstance } from "../lib/runtime-nodes.js";
import { getLiveRuntime } from "./instances-runtime.js";
import { getDefaultRunnerConn, requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/**
 * The shape returned by the runner's `/coding/git-identity` endpoint (#684).
 *
 * `checked: true` is the version marker — an older runner 404s and this field stays null, which
 * means unverified, NOT "no problem". All fields except `checked` and `host` may be absent on an
 * older runner, so every read must guard.
 */
interface GitIdentityResult {
	checked?: boolean;
	host?: string;
	identity?: string | null;
	isDeployKey?: boolean | null;
	raw?: string;
}

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

async function closeCodingSessions(c: Context<{ Bindings: Env }>) {
	const { uid, instanceId } = await requireOwned(c);
	const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
	if (!conn) return c.json({ error: "Runner not connected", runnerConnected: false }, 502);
	// Legacy runner path on purpose — an older runner has no /coding/close-sessions, and this
	// is the only endpoint that ever did the useful work.
	const result = await callRunner(conn, "/coding/kill-tmux", {}, { timeoutMs: READ_TIMEOUT_MS });
	return c.json(result);
}

/**
 * The parsed result of a `/coding/github-repos` runner call (#685).
 *
 * `checked: true` is the version marker — an older runner 404s and the route
 * returns 502 instead of an empty list, which is what "not supported" means.
 */
interface GithubRepoEntry {
	owner: string;
	name: string;
	full_name: string;
	visibility: "public" | "private" | "internal";
	default_branch: string;
	pushed_at: string | null;
	language: string | null;
}
interface GithubBrowseResult {
	checked?: boolean;
	repos?: GithubRepoEntry[];
	hasMore?: boolean;
	total?: number;
	error?: string;
}

/**
 * The parsed result of a `/coding/github-search` runner call (#686).
 *
 * `checked: true` is the version marker. `rateLimited: true` means the runner
 * hit GitHub's search rate limit (30 req/min); a stale cache entry may still
 * be present. An older runner 404s and the route returns 502.
 */
interface GithubSearchRepoEntry {
	full_name: string;
	owner: string;
	name: string;
	description: string | null;
	visibility: "public" | "private" | "internal";
	language: string | null;
	pushed_at: string | null;
	stars: number;
	forks: number;
	open_issues: number;
	topics: string[];
}
interface GithubSearchResult {
	checked?: boolean;
	repos?: GithubSearchRepoEntry[];
	totalCount?: number;
	fromCache?: boolean;
	cachedAt?: string;
	rateLimited?: boolean;
	canonicalQuery?: string;
	error?: string;
}

/**
 * The parsed result of a `/coding/github-repo-detail` runner call (#687).
 *
 * `checked: true` is the version marker. An older runner 404s and the route returns
 * 502. All arrays may be empty when the repo exists but has no issues/PRs/branches.
 */
interface GithubRepoDetailResult {
	checked?: boolean;
	repo?: string;
	issues?: Array<{
		number: number; title: string; state: string; author: string | null;
		created_at: string; updated_at: string; labels: string[]; assignee: string | null;
	}>;
	pulls?: Array<{
		number: number; title: string; state: string; author: string | null;
		created_at: string; updated_at: string; head_branch: string; base_branch: string;
		draft: boolean; labels: string[];
	}>;
	branches?: Array<{ name: string; sha: string; protected: boolean }>;
	fromCache?: boolean;
	cachedAt?: string;
	error?: string;
}

/**
 * The parsed result of a `/coding/github-credentials` runner call (#688).
 *
 * `checked: true` is the version marker. An older runner that does not support
 * this endpoint returns 502 (the relay returns 404 as a non-2xx), which is
 * distinct from a runner that successfully reported an empty scope.
 */
interface GithubCredentialScopeResult {
	checked?: boolean;
	login?: string;
	orgs?: string[];
	error?: string;
}

export function registerDiagnosticsRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	/**
	 * Close every tracked coding session on the runner.
	 *
	 * `close-sessions` is the real name; `kill-tmux` remains as a deprecated alias because
	 * renaming a route buys nothing when nothing calls it, and an older console might (#247). The
	 * runner endpoint keeps its legacy path for the same version-skew reason.
	 */
	codingRoutes.post("/:instanceId/coding/close-sessions", async (c) => closeCodingSessions(c));
	codingRoutes.post("/:instanceId/coding/kill-tmux", async (c) => closeCodingSessions(c));

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
	 * Report the credential scope of the runner's `gh` login (#688).
	 *
	 * Read-only: calls `gh api user` + `gh api user/orgs` — two GET requests that
	 * never mutate anything. Returns `{ checked: true, login, orgs }` — the GitHub
	 * account name and the organisations it belongs to. This tells the user exactly
	 * which account the runner is acting as and what it can reach.
	 *
	 * Returns 502 when the runner is offline. Returns `{ error }` when `gh` is
	 * unavailable or unauthenticated. An older runner that does not support this
	 * endpoint returns 502 (the relay 404s, which `callRunner` converts to a failure).
	 */
	codingRoutes.get("/:instanceId/coding/github-credentials", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
		if (!conn) return c.json({ error: "Runner not connected" }, 502);
		const result = await callRunner<GithubCredentialScopeResult>(conn, "/coding/github-credentials", undefined, { timeoutMs: READ_TIMEOUT_MS }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
		return c.json(result);
	});

	/**
	 * List GitHub organizations reachable by the runner's `gh` credentials (#685).
	 *
	 * Read-only: only calls `gh api GET /user/orgs`. Returns `{ orgs: string[] }` —
	 * the login names, suitable for use as the `owner` parameter of the repos route.
	 * Returns 502 when the runner is offline, 200 with `{ error }` when `gh` fails.
	 * An older runner that does not support this endpoint returns 502 with a suitable
	 * message (the relay returns 404 as a non-2xx, which `callRunner` converts).
	 */
	codingRoutes.get("/:instanceId/coding/github-orgs", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
		if (!conn) return c.json({ error: "Runner not connected" }, 502);
		const result = await callRunner<{ orgs?: string[]; error?: string }>(conn, "/coding/github-orgs", undefined, { timeoutMs: READ_TIMEOUT_MS }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
		return c.json(result);
	});

	/**
	 * List GitHub repositories reachable by the runner's `gh` credentials (#685).
	 *
	 * Read-only: only calls `gh api GET /user/repos` or `GET /orgs/{org}/repos`.
	 * Query parameters (all optional):
	 *   `owner`      — personal login or org name (omit for the user's own repos)
	 *   `limit`      — max repos to return (1–200; default 50)
	 *   `since`      — ISO timestamp; only repos pushed after this date
	 *   `visibility` — "all" | "public" | "private" (default "all")
	 *
	 * Returns `{ checked: true, repos: [], hasMore, total }` or `{ error }`.
	 * 502 when the runner is offline. An older runner that does not support this
	 * endpoint returns 502 (the relay returns 404 as a non-2xx).
	 */
	codingRoutes.get("/:instanceId/coding/github-repos", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
		if (!conn) return c.json({ error: "Runner not connected" }, 502);
		// Forward query params to the runner via POST body (the relay is POST-only).
		const body = {
			owner: c.req.query("owner") || undefined,
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
			since: c.req.query("since") || undefined,
			visibility: c.req.query("visibility") || undefined,
		};
		const result = await callRunner<GithubBrowseResult>(conn, "/coding/github-repos", body, { timeoutMs: READ_TIMEOUT_MS }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
		return c.json(result);
	});

	/**
	 * Search GitHub repositories reachable by the runner's `gh` credentials (#686).
	 *
	 * Read-only: only calls `gh api GET /search/repositories` (or `/search/issues`
	 * when `openPrs` is set). Uses GitHub's own search API — one request across all
	 * reachable repos, no per-repo fan-out. Results are cached on the runner for 5
	 * minutes; `fromCache: true` signals a cache hit, `rateLimited: true` signals the
	 * 30 req/min search quota was hit (stale data may still be present).
	 *
	 * Query parameters (all optional):
	 *   `query`       — free-text + GitHub search qualifiers (e.g. "topic:react")
	 *   `owner`       — restrict to one owner (appended as `user:<owner>`)
	 *   `language`    — filter by language (appended as `language:<lang>`)
	 *   `topic`       — filter by topic tag (appended as `topic:<topic>`)
	 *   `pushedAfter` — ISO date; only repos pushed at or after (appended as `pushed:>=date`)
	 *   `openPrs`     — "true" to pivot to the PR search and group by repo
	 *   `limit`       — max repos to return (1–100; default 30)
	 *   `sort`        — "updated" (default) | "stars" | "forks"
	 *
	 * Returns `{ checked: true, repos: [], totalCount, fromCache, cachedAt, canonicalQuery }`
	 * or `{ error }`. 502 when the runner is offline or predates this endpoint.
	 */
	codingRoutes.get("/:instanceId/coding/github-search", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
		if (!conn) return c.json({ error: "Runner not connected" }, 502);
		// Forward query params to the runner via POST body (the relay is POST-only).
		const qOpenPrs = c.req.query("openPrs");
		const body = {
			query: c.req.query("query") || undefined,
			owner: c.req.query("owner") || undefined,
			language: c.req.query("language") || undefined,
			topic: c.req.query("topic") || undefined,
			pushedAfter: c.req.query("pushedAfter") || undefined,
			openPrs: qOpenPrs !== undefined ? qOpenPrs === "true" : undefined,
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
			sort: c.req.query("sort") || undefined,
		};
		const result = await callRunner<GithubSearchResult>(conn, "/coding/github-search", body, { timeoutMs: READ_TIMEOUT_MS }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
		return c.json(result);
	});

	/**
	 * Fetch issues, pull requests, and branches for a given `owner/repo` (#687).
	 *
	 * Read-only: only calls `gh api GET /repos/{owner}/{repo}/{issues,pulls,branches}`.
	 * Results are cached on the runner for 2 minutes; `fromCache: true` signals a
	 * cache hit. An older runner 404s and this route returns 502.
	 *
	 * Query parameters:
	 *   `repo`   — required — `owner/repo` slug (e.g. `serge-ivo/my-app`)
	 *   `limit`  — max items per list (1–100; default 30)
	 *   `state`  — `"open"` (default) | `"all"` (for issues + PRs)
	 *
	 * Returns `{ checked: true, repo, issues: [], pulls: [], branches: [], fromCache, cachedAt }`
	 * or `{ error }`. 502 when the runner is offline or predates this endpoint.
	 */
	codingRoutes.get("/:instanceId/coding/github-repo-detail", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const conn = await getDefaultRunnerConn(c.env, instanceId, uid);
		if (!conn) return c.json({ error: "Runner not connected" }, 502);
		// Forward query params to the runner via POST body (the relay is POST-only).
		const body = {
			repo: c.req.query("repo") || undefined,
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
			state: c.req.query("state") || undefined,
		};
		const result = await callRunner<GithubRepoDetailResult>(conn, "/coding/github-repo-detail", body, { timeoutMs: READ_TIMEOUT_MS }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
		return c.json(result);
	});

	/**
	 * Full diagnostics: runner, tmux, sessions, repos, GitHub, detected issues.
	 * The console's transparency view — everything the user needs to self-diagnose.
	 */
	codingRoutes.get("/:instanceId/coding/diagnostics", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const env = c.env;

		// 1. Runner connection (D1 row — the shared default row, kept for registration metadata)
		const runtimeRow = await env.DB.prepare(
			"SELECT endpoint_url, capabilities, runner_version, runner_node, status, last_seen_at, placement, created_at, updated_at FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2",
		).bind(instanceId, uid).first<{
			endpoint_url: string | null; capabilities: string | null; runner_version: string | null;
			runner_node: string | null; status: string | null; last_seen_at: string | null;
			placement: string | null; created_at: string | null; updated_at: string | null;
		}>();

		// 2. Live runner probe
		//
		// `getBoundRunnerConn` (#691): the old code passed `runtimeRow?.runner_node` directly to
		// `getRunnerConn`, which caused diagnostics to probe the STALE node from the shared
		// `instance_runtimes` row instead of the instance's current pin.  After a `set_runner_node`
		// repin, that row still holds the OLD hostname, so the diagnostics tool reported the old
		// node as "not reachable" while `instance_runtime_status` (which uses the same
		// `getBoundRunnerConn` path) correctly showed the new node as online.
		//
		// `getBoundRunnerConn` is the one resolver that honours the instance's `config.runnerNode`
		// pin, walks machine-id aliases when the pinned hostname has changed, and live-checks the
		// RelayDO — so its answer is the live node, not the stale DB row.  We then pull the live
		// node's runtime row (for accurate version / last_seen_at), falling back to the shared row
		// for registration metadata when nothing is connected.
		const conn = await getBoundRunnerConn(env, instanceId, uid).catch(() => null);
		// The live node the connection was resolved to — null when offline.
		const liveNode = conn?.runnerNode ?? null;
		// Relay-connected is TRUE iff getBoundRunnerConn returned a connection (it already
		// live-checked the RelayDO internally — no second probe needed).
		const relayIsConnected = !!conn;
		// Use the live node's relay name when we have one; fall back to the stale row's for when
		// there is no live connection (it is the thing the user goes to look at when there is none).
		const relayName = relayNameForInstance(instanceId, liveNode ?? runtimeRow?.runner_node ?? null);

		// Fetch the live node's own row so we report its runner_version / last_seen_at, not the
		// stale shared row's.  `getLiveRuntime` returns the per-node row when the conn resolved to
		// a named node; falls back to the shared row otherwise (single-machine + old-client path).
		const liveRuntimeRow = conn ? await getLiveRuntime(env, instanceId, uid).catch(() => null) : null;
		// What we report in the `runner` section: prefer the live node's row over the stale default.
		const reportedRow = liveRuntimeRow ?? runtimeRow;

		const runner: Record<string, unknown> = {
			registered: !!runtimeRow,
			status: reportedRow?.status ?? "unregistered",
			endpointUrl: reportedRow?.endpoint_url ?? null,
			placement: reportedRow?.placement ?? null,
			capabilities: parseJsonOr(reportedRow?.capabilities, [] as unknown),
			runnerVersion: reportedRow?.runner_version ?? null,
			// Use the live-resolved node name, not the stale row's.
			runnerNode: liveNode ?? reportedRow?.runner_node ?? null,
			lastSeenAt: reportedRow?.last_seen_at ?? null,
			registeredAt: runtimeRow?.created_at ?? null,
		};

		let runnerHealth: unknown = null;
		let runnerDiag: unknown = null;
		let runnerGitIdentity: GitIdentityResult | null = null;
		let runnerReachable = false;
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
			// SSH identity probe (#684): run only when the runner is reachable, because a machine
			// without a connected runner cannot tell us what its SSH key resolves to. Capped at a short
			// timeout — the probe opens a real SSH connection to github.com, and a firewall that drops
			// packets must not stall the whole diagnostics response. An older runner 404s and the result
			// stays null, which is treated as unverified, not as "no problem".
			try {
				const raw = await callRunner<unknown>(conn, "/coding/git-identity", undefined, { timeoutMs: 15_000 });
				runnerGitIdentity = raw as GitIdentityResult;
			} catch {
				// Older runner without the endpoint, or network hiccup — treat as unverified.
			}
		}
		const effectivelyReachable = runnerReachable;

		(runner as Record<string, unknown>).reachable = effectivelyReachable;
		(runner as Record<string, unknown>).health = runnerHealth;

		// 3. D1 sessions + repos + the engine presets (needed to name each session's sign-in MODE,
		//    which is half of the auth report — the runner supplies the other half).
		const [dbSessions, dbRepos, { engines: diagEngines }] = await Promise.all([
			listSessions(env, instanceId, uid),
			listRepos(env, instanceId, uid),
			readEngines(env, instanceId, uid),
		]);

		// 3b. What the RUNS behind those sessions are doing (#593). The runner can only report that
		// a process is alive; whether it is WORKING is the run's own record, and `engine_limit` is
		// already a first-class park reason there (#541). Without this join the one failure mode
		// where the machine is healthy and the work is stopped is invisible to the tool named for
		// stuck sessions.
		const runsBySession = await codingRunsForSessions(
			env,
			instanceId,
			uid,
			dbSessions.filter((s) => s.status === "active").map((s) => s.id),
		).catch(() => new Map<string, CodingRunFact[]>());
		/** The newest run on a session, which is the one whose park is current. */
		const latestRunFor = (sessionId: string): CodingRunFact | undefined =>
			[...(runsBySession.get(sessionId) ?? [])].sort((a, b) => b.at - a.at)[0];

		// 4. Cross-reference D1 active sessions vs runner's tracked sessions
		const trackedIds = new Set<string>();
		// No tmux fields (#247): the coding engine spawns a child process, so the old
		// orphanedTmux/tmuxTotal/pagsTmuxTotal figures described something that could never exist
		// for these sessions. `engineLabel` replaces `tmuxSession`, which only ever looked like a
		// tmux target a user could attach to.
		const diagData = runnerDiag as { tracked?: Array<{ sessionId: string; alive: boolean; runState: string; paneLines: number; clientType: string; workDir: string; engineLabel: string; takeover: boolean; authResolved?: EngineAuthResolved; engineMode?: EngineInvocationMode; ghGuard?: TrackedGhGuard }> } | null;
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
					launchCommand: s.launchCommand ?? null, engineLabel: s.tmuxSession ?? null,
					// A reconciled orphan has no live process, so the outcome is genuinely unknown —
					// report the mode with resolved:null rather than omitting the field and making
					// the shape differ between branches.
					auth: engineAuthReport(engineAuthFor(diagEngines, s.launchCommand), null),
					invocation: engineInvocationReport({ clientType: s.clientType, launchCommand: s.launchCommand, runnerMode: null }),
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
				// Setting vs outcome, per session (#248) — the same pairing /capture reports, so the
				// diagnostics list answers "which of my sessions is billing per token?" at a glance.
				auth: engineAuthReport(engineAuthFor(diagEngines, s.launchCommand), tracked?.authResolved ?? null),
				invocation: engineInvocationReport({ clientType: s.clientType, launchCommand: s.launchCommand, runnerMode: tracked?.engineMode }),
				// The D1 column is still called tmux_session (renaming it is a table rewrite for a
				// cosmetic gain); what it holds is an engine label. Surfaced honestly.
				engineLabel: s.tmuxSession ?? null,
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
				urls: r.urls ?? null,
				activeSessions: activeSessions.length,
				issue: r.cloneStatus === "error" ? `clone failed: ${r.cloneError || "unknown error"}`
					: r.cloneStatus === "missing_url" ? "no clone URL and no local path"
					// #405 — the machine looked at this local path and it is not usable. Reported
					// here too: "the agent answers about a repo that isn't there" is exactly the
					// symptom someone opens this panel to explain.
					: r.cloneStatus === "needs_attention" ? r.cloneError || "the local path is not usable"
					: null,
			};
		});

		// 5. GitHub App status, and WHAT THIS INSTANCE MAY WRITE TO (#676 item 5)
		//
		// `configured` alone answered "can the platform talk to GitHub at all", which is not the
		// question an owner has before handing over autonomous work. That question is "what can this
		// thing change", and until #676 nothing on any surface answered it — the registered repo was
		// a working-directory default that read like a boundary.
		//
		// `enforcement` is DERIVED from what the machine reported, never from what the cloud sent
		// (#679). Until #679 this was the constant `"acts-observed-halt"` — detect-and-halt on the
		// acts the Engine reports, with the first wrong-repo write still landing. A runner carrying
		// the `gh` guard refuses that write before it runs; a runner published earlier does not, and
		// the cloud cannot tell which machine this is except by asking it. `writeEnforcementReport`
		// is where that judgement lives, with the vocabulary written out.
		const writeScope = dbRepos.map((r) => r.githubRepo).filter((s): s is string => !!s && s.includes("/"));
		const githubApp = {
			configured: githubAppConfigured(env),
			/** The repositories a write may name. Empty = no GitHub coordinates, so nothing is checked. */
			writeScope,
			/** Only a stream-json engine reports acts (#294), so on any other engine the halt half sees nothing. */
			...writeEnforcementReport(writeScope, diagData?.tracked ?? []),
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
			// An engine that is up and REFUSING (#593) — the case every rule above misses, because
			// every rule above is about the machine rather than the work.
			if (s.status === "active") {
				const refusal = refusingEngineIssue({
					sessionLabel: `${s.id.slice(-8)} (${s.repoName})`,
					alive: s.live?.alive === true,
					run: latestRunFor(s.id),
				});
				if (refusal) issues.push(refusal);
			}
		}
		for (const r of repos) {
			if (r.issue)
				issues.push({
					severity: "warn",
					message: `Repo "${r.name}": ${r.issue}`,
					fix:
						r.cloneStatus === "error"
							? "Delete and re-add the repo, or fix the clone URL"
							: r.cloneStatus === "needs_attention"
								? "Point the repo at the real checkout (⚙ Repo settings), or delete it — the agent cannot read code that isn't there"
								: undefined,
				});
		}

		// 6b. SSH identity issues (#684).
		//
		// A deploy key authenticates to exactly ONE repository. Any SSH clone for a DIFFERENT private
		// repo will silently fail with "Repository not found" — GitHub's generic message for "wrong
		// identity", which looks like the repo is missing when it is actually an auth problem. The
		// runner's `/coding/git-identity` probe makes the identity visible before a clone is attempted.
		//
		// Three distinct cases, treated differently:
		//   1. Deploy key detected + SSH repos → `warn` (the clone works for the keyed repo but fails
		//      for everything else; the owner needs to decide whether SSH is intentional).
		//   2. SSH repos + runner reachable + probe succeeded with a user account → `info` (everything
		//      fine; SSH is working and the identity is a real account).
		//   3. SSH repos + runner reachable + probe could not authenticate → `warn` (the SSH key may
		//      not be known to GitHub at all, which will break every private clone).
		//
		// Nothing is emitted when there are no SSH repos: a runner with a deploy key but no SSH clone
		// URLs is not broken for the repos registered here.
		const sshRepos = dbRepos.filter((r) => {
			const u = r.cloneUrl ?? "";
			return /^git@/i.test(u) || /^ssh:\/\//i.test(u);
		});
		if (sshRepos.length > 0 && runnerGitIdentity?.checked === true) {
			const { identity, isDeployKey } = runnerGitIdentity;
			if (isDeployKey) {
				// A deploy key is scoped to one repository. The clone URL in D1 may be for that exact
				// repo, in which case it works — but the owner cannot see that without this report, and
				// a second repo on the same machine will silently fail.
				const affectedNames = sshRepos.map((r) => `"${r.name}"`).join(", ");
				issues.push({
					severity: "warn",
					message: `SSH identity on this machine is a deploy key (${identity}) — not a user account. Repos cloning over SSH: ${affectedNames}. A deploy key authenticates to exactly one repository; private repos outside that one will fail with "Repository not found".`,
					fix: `Re-add the repo using an HTTPS URL (e.g. https://github.com/${identity}.git) so the platform can inject a token, or update ~/.ssh/config on this machine so github.com resolves to a user key rather than a deploy key.`,
				});
			} else if (identity === null) {
				// The probe could not authenticate at all. Could be a missing key, a firewall, or no
				// network — but if it is a key problem, every SSH private repo clone will break the
				// same way and the error will look like "Repository not found".
				issues.push({
					severity: "warn",
					message: `SSH handshake to github.com did not authenticate on this machine (probe returned no identity). Repos using SSH clone URLs: ${sshRepos.map((r) => `"${r.name}"`).join(", ")}. Private repo clones will fail until SSH is working.`,
					fix: "Confirm that a GitHub-authorised SSH key is registered on this machine (ssh -T git@github.com), or re-add these repos using HTTPS URLs.",
				});
			}
			// identity is non-null and isDeployKey is false → user account, SSH is fine, no issue.
		}

		const activeSessions = sessions.filter((s) => s.status === "active");
		// "Healthy" has to mean able to work, not merely running (#593). A session whose run is
		// parked on the engine's own usage limit was counted here, so the summary read
		// `healthySessions: 1, issueCount: 0` for an engine that had refused every instruction for
		// hours — the two numbers a reader checks first, both wrong in the same direction.
		const healthySessions = activeSessions.filter(
			(s) => s.live?.alive && !refusingEngineIssue({ sessionLabel: s.id, alive: true, run: latestRunFor(s.id) }),
		);

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
			relay: { connected: relayIsConnected, relayName, runnerNode: liveNode ?? runtimeRow?.runner_node ?? null },
			// `tmux: {...}` is gone (#247). Every figure in it described something that cannot exist
			// for a coding session: pagsTmuxTotal was structurally 0, and tmuxTotal counted the
			// user's own unrelated tmux sessions. `engine.trackedSessions` is the honest version —
			// how many engine processes the runner is actually tracking.
			engine: diagData ? { trackedSessions: diagData.tracked?.length ?? 0 } : null,
			sessions,
			repos,
			githubApp,
			// SSH identity transparency (#684). `null` when the runner is offline or predates the
			// `/coding/git-identity` endpoint — treat as unverified, not as "no problem".
			gitIdentity: runnerGitIdentity,
			issues,
		});
	});
}
