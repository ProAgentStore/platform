import { closeCodingSessionCards, upsertCodingSessionCard } from "./coding-board.js";
import { parseMergePolicy } from "./coding-authority.js";
import { gitProviderFor, type GitProviderId } from "./git-providers.js";
import { parseRepoPolicies, type DeclaredRepoPolicies } from "./repo-policies.js";
import type { Env } from "../types.js";
import type {
	CloneStatus,
	CodingClientType,
	CodingRepo,
	CodingSessionRecord,
	CodingSessionStatus,
} from "./coding-types.js";

/**
 * D1 access for the coding-workspace registry (repos + sessions).
 *
 * The durable record of what repos a workspace has and what sessions exist —
 * the console, MCP, and audit read this even when the local runner is offline.
 * Live pane/output state lives in the AgentDO, not here. Mirrors the
 * `credentials.ts` lib shape: typed row → camelCase mappers, owner-scoped queries.
 */

const CLIENTS: CodingClientType[] = ["claude", "gemini", "codex", "grok"];
function client(v: unknown): CodingClientType {
	return CLIENTS.includes(v as CodingClientType) ? (v as CodingClientType) : "claude";
}

interface RepoRow {
	id: string;
	instance_id: string;
	user_id: string;
	name: string;
	github_repo: string | null;
	provider: string | null;
	repo_slug: string | null;
	web_url: string | null;
	clone_url: string | null;
	branch: string;
	workdir: string | null;
	clone_status: string;
	clone_error: string | null;
	clone_checked_at: string | null;
	default_client: string;
	urls: string | null;
	instructions: string | null;
	merge_policy: string | null;
	policies: string | null;
	created_at: string;
	updated_at: string;
}

function parseRepoUrls(raw: string | null): CodingRepo["urls"] {
	if (!raw) return undefined;
	try {
		const o = JSON.parse(raw) as Record<string, unknown>;
		const pick = (k: string) => (typeof o[k] === "string" && o[k] ? (o[k] as string) : undefined);
		const urls = { dev: pick("dev"), staging: pick("staging"), prod: pick("prod") };
		return urls.dev || urls.staging || urls.prod ? urls : undefined;
	} catch {
		return undefined;
	}
}

function toRepo(r: RepoRow): CodingRepo {
	return {
		id: r.id,
		instanceId: r.instance_id,
		userId: r.user_id,
		name: r.name,
		githubRepo: r.github_repo ?? undefined,
		// `gitProviderFor` rather than a cast: a row written before migration 0097 (or by a test
		// fixture) has no `provider` at all, and the answer for one carrying `github_repo` is
		// GitHub, not the 'local' the column would default to.
		provider: gitProviderFor(r.provider ?? (r.github_repo ? "github" : "local")).id,
		repoSlug: r.repo_slug ?? r.github_repo ?? undefined,
		webUrl: r.web_url ?? undefined,
		cloneUrl: r.clone_url ?? undefined,
		branch: r.branch,
		workdir: r.workdir ?? undefined,
		cloneStatus: r.clone_status as CloneStatus,
		cloneError: r.clone_error ?? undefined,
		// Undefined on every row written before migration 0110, and on every row no machine has
		// looked at since. Both mean the same thing — nobody has checked — which is why there is no
		// backfill and no default (#440).
		cloneCheckedAt: r.clone_checked_at ?? undefined,
		defaultClient: client(r.default_client),
		urls: parseRepoUrls(r.urls),
		instructions: r.instructions || undefined,
		// '' means "inherit" — resolved by `resolveMergePolicy`, never defaulted here, so there is
		// exactly one place that decides what an unset policy means (#314).
		mergePolicy: parseMergePolicy(r.merge_policy) ?? undefined,
		// Same treatment as `mergePolicy`: undefined means "declared nothing", and what that
		// resolves to is decided in one place (`resolveRepoPolicyMode`), never defaulted here.
		policies: parseRepoPolicies(r.policies),
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export interface NewRepoInput {
	name: string;
	githubRepo?: string;
	/** #221. Absent = infer: `githubRepo` means GitHub, a bare local path means local. */
	provider?: GitProviderId;
	repoSlug?: string;
	webUrl?: string;
	cloneUrl?: string;
	branch?: string;
	defaultClient?: CodingClientType;
	/** Absolute path to an existing local checkout on the runner machine (no clone). */
	workdir?: string;
}

export async function listRepos(env: Env, instanceId: string, userId: string): Promise<CodingRepo[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM coding_repos WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC",
	)
		.bind(instanceId, userId)
		.all<RepoRow>();
	return (results ?? []).map(toRepo);
}

/** Just the columns the repo-local connector needs to resolve (or refuse) a checkout. */
export interface RepoWorkdirRow {
	name: string;
	workdir: string | null;
	/**
	 * The row's `clone_status`. Carried because `needs_attention` is the ONE status that is a
	 * MEASUREMENT rather than a default: `cloneStatusForVerdict` (lib/coding-workdir.ts) returns it
	 * only from a definite runner verdict, and returns `null` for `unverified` so an offline or
	 * old runner never overwrites a good status. That is what makes it safe to route on.
	 */
	cloneStatus: string;
}

/**
 * The repo rows' names and folders for one instance, most-recently-updated first (#520).
 *
 * `repoPathForInstance` runs in front of six tools, so it reads two columns rather than going
 * through `listRepos`' `SELECT *` + `toRepo` mapping — it needs the address, not the record.
 * The ORDER BY is deliberately the same one `listRepos` uses: "which repo" must not depend on
 * which function asked.
 *
 * `workdir` is returned as stored, including when the row's `clone_status` says the checkout is
 * broken. Filtering here would turn "the folder you configured does not exist on this machine"
 * back into "no repository is configured" — the exact distinction #405 exists to make. The status
 * rides along so the CALLER can order its candidates by it without losing that distinction.
 */
export async function listRepoWorkdirs(env: Env, instanceId: string, userId: string): Promise<RepoWorkdirRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT name, workdir, clone_status FROM coding_repos WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC",
	)
		.bind(instanceId, userId)
		.all<{ name: string | null; workdir: string | null; clone_status: string | null }>();
	return (results ?? []).map((r) => ({ name: r.name ?? "", workdir: r.workdir, cloneStatus: r.clone_status ?? "" }));
}

export async function getRepo(env: Env, instanceId: string, userId: string, repoId: string): Promise<CodingRepo | null> {
	const row = await env.DB.prepare(
		"SELECT * FROM coding_repos WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(repoId, instanceId, userId)
		.first<RepoRow>();
	return row ? toRepo(row) : null;
}

export async function createRepo(env: Env, instanceId: string, userId: string, input: NewRepoInput): Promise<CodingRepo> {
	const id = `repo_${crypto.randomUUID()}`;
	// A local checkout is already on disk → "ready". Otherwise it clones on first
	// session start, or is missing a source entirely.
	const cloneStatus: CloneStatus = input.workdir ? "ready" : input.cloneUrl || input.githubRepo ? "cloning" : "missing_url";
	// Inferred, not defaulted, so a caller that predates #221 (the settings-repo attach in
	// routes/instances.ts, an MCP tool) still stores the truth rather than 'local'.
	const provider = input.provider ?? (input.githubRepo ? "github" : input.workdir ? "local" : input.cloneUrl ? "other" : "local");
	await env.DB.prepare(
		`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider, repo_slug, web_url, clone_url, branch, workdir, clone_status, default_client)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
	)
		.bind(
			id,
			instanceId,
			userId,
			input.name,
			input.githubRepo ?? null,
			provider,
			input.repoSlug ?? input.githubRepo ?? null,
			input.webUrl ?? null,
			input.cloneUrl ?? null,
			input.branch ?? "",
			input.workdir ?? null,
			cloneStatus,
			input.defaultClient ?? "claude",
		)
		.run();
	const repo = await getRepo(env, instanceId, userId, id);
	if (!repo) throw new Error("repo insert failed");
	return repo;
}

export async function updateRepoClone(
	env: Env,
	repoId: string,
	patch: {
		cloneStatus?: CloneStatus;
		cloneError?: string | null;
		workdir?: string;
		branch?: string;
		/**
		 * A machine gave a DEFINITE verdict on this path just now — stamp `clone_checked_at`
		 * (#440, migration 0110).
		 *
		 * Opt-IN, and only `verifyLocalWorkdir` passes it. Every other writer here is recording
		 * something OTHER than a look at the directory (a clone that failed, a branch, a move), and
		 * stamping those would make the column mean "last touched", which is the thing `updated_at`
		 * already means and the reason a new column was needed at all.
		 */
		checkedNow?: boolean;
	},
): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_repos
		 SET clone_status     = COALESCE(?2, clone_status),
		     clone_error      = ?3,
		     workdir          = COALESCE(?4, workdir),
		     branch           = COALESCE(?5, branch),
		     clone_checked_at = CASE WHEN ?6 = 1 THEN datetime('now') ELSE clone_checked_at END,
		     updated_at       = datetime('now')
		 WHERE id = ?1`,
	)
		.bind(repoId, patch.cloneStatus ?? null, patch.cloneError ?? null, patch.workdir ?? null, patch.branch ?? null, patch.checkedNow ? 1 : 0)
		.run();
}

/**
 * Update a repo's editable fields (name, launch URLs, merge policy and/or workdir). Owner-scoped.
 *
 * `workdir` is here rather than on `updateRepoClone` (which can also write it) so that the ONE
 * owner-scoped write covers every field the settings sheet can change: `updateRepoClone` is keyed
 * on `id` alone because its callers have already resolved ownership, and routing an owner-supplied
 * value through it would put a user-controlled id on a statement with no tenant clause (#410/#411).
 */
export async function updateRepo(
	env: Env,
	instanceId: string,
	userId: string,
	repoId: string,
	patch: {
		name?: string;
		urls?: { dev?: string; staging?: string; prod?: string };
		/** #314. A validated policy sets the override; `""` clears it back to "inherit". */
		mergePolicy?: string;
		/**
		 * #410/#411 — where this repo's working copy lives. IDENTITY is immutable (sessions and
		 * the timeline hang off the row); the ADDRESS is a fact about the world and changes.
		 * `undefined` leaves it; `""` is refused by the caller, because blanking the address of a
		 * repo every tool addresses BY it is not an intent anyone has — deleting the repo is.
		 */
		workdir?: string;
		/**
		 * #322 — which standing invariants this repo claims. Whole-object replace, not a patch:
		 * the set of policies a repo claims is one declaration, and a per-key merge would make
		 * "turn this one off" indistinguishable from "leave it alone" over the wire.
		 */
		policies?: DeclaredRepoPolicies;
	},
): Promise<boolean> {
	const urlsJson =
		patch.urls === undefined
			? null
			: JSON.stringify({
					dev: (patch.urls.dev || "").trim() || undefined,
					staging: (patch.urls.staging || "").trim() || undefined,
					prod: (patch.urls.prod || "").trim() || undefined,
				});
	const res = await env.DB.prepare(
		`UPDATE coding_repos
		 SET name = COALESCE(?4, name),
		     urls = CASE WHEN ?6 = 1 THEN ?5 ELSE urls END,
		     merge_policy = COALESCE(?7, merge_policy),
		     workdir = COALESCE(?8, workdir),
		     policies = CASE WHEN ?10 = 1 THEN ?9 ELSE policies END,
		     updated_at = datetime('now')
		 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(
			repoId,
			instanceId,
			userId,
			patch.name ? patch.name.slice(0, 120) : null,
			urlsJson,
			patch.urls === undefined ? 0 : 1,
			patch.mergePolicy === undefined ? null : patch.mergePolicy,
			patch.workdir === undefined ? null : patch.workdir.slice(0, 400),
			// `{}` stores as NULL, not as "{}": clearing every claim is the same state as never
			// having declared one, and two spellings of it would make the column's own default
			// unreachable once anyone had touched it. The `?10` flag is what keeps an omitted
			// `policies` from clearing the column — COALESCE cannot express "write NULL on purpose".
			patch.policies === undefined || !Object.keys(patch.policies).length ? null : JSON.stringify(patch.policies),
			patch.policies === undefined ? 0 : 1,
		)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

export async function deleteRepo(env: Env, instanceId: string, userId: string, repoId: string): Promise<boolean> {
	// Cascade: timeline → sessions → repo (FK constraints). Run as ONE atomic batch so a
	// failure partway can't orphan coding_sessions/coding_timeline rows (repo gone, children
	// stranded). D1 batch() wraps the statements in a single implicit transaction.
	const sessionIds = await env.DB.prepare(
		"SELECT id FROM coding_sessions WHERE repo_id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(repoId, instanceId, userId)
		.all<{ id: string }>();
	const stmts = [
		...sessionIds.results.map((row) => env.DB.prepare("DELETE FROM coding_timeline WHERE session_id = ?1").bind(row.id)),
		env.DB.prepare("DELETE FROM coding_sessions WHERE repo_id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(repoId, instanceId, userId),
		env.DB.prepare("DELETE FROM coding_repos WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(repoId, instanceId, userId),
	];
	const results = await env.DB.batch(stmts);
	const repoDelete = results[results.length - 1];
	return (repoDelete.meta.changes ?? 0) > 0;
}

// ── Sessions ───────────────────────────────────────────────────────────────

interface SessionRow {
	id: string;
	instance_id: string;
	repo_id: string;
	user_id: string;
	client_type: string;
	status: string;
	/** Legacy column name (#247): holds the engine LABEL, not a tmux target — the coding
	 *  engine spawns a child process. Kept as-is because renaming a D1 column is a table
	 *  rewrite for a cosmetic gain; surfaced through the API as `engineLabel`. */
	tmux_session: string | null;
	runner_node: string | null;
	launch_command: string | null;
	issue_number: number | null;
	issue_title: string | null;
	started_at: string;
	ended_at: string | null;
	updated_at: string;
}

function toSession(r: SessionRow): CodingSessionRecord {
	return {
		id: r.id,
		instanceId: r.instance_id,
		repoId: r.repo_id,
		userId: r.user_id,
		clientType: client(r.client_type),
		status: r.status as CodingSessionStatus,
		tmuxSession: r.tmux_session ?? undefined,
		runnerNode: r.runner_node ?? null,
		launchCommand: r.launch_command ?? undefined,
		issueNumber: r.issue_number ?? undefined,
		issueTitle: r.issue_title ?? undefined,
		startedAt: r.started_at,
		endedAt: r.ended_at ?? undefined,
		updatedAt: r.updated_at,
	};
}

export interface NewSessionInput {
	repoId: string;
	clientType?: CodingClientType;
	/** Exact launch command for the chosen engine (from the instance's engine presets). */
	launchCommand?: string;
	issueNumber?: number;
	issueTitle?: string;
	/** The machine that owns this session (instance_runtimes.runner_node), so a machine
	 *  switch can suspend/resume by ownership. Null when no runner is registered. */
	runnerNode?: string | null;
}

export async function listSessions(env: Env, instanceId: string, userId: string): Promise<CodingSessionRecord[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM coding_sessions WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC",
	)
		.bind(instanceId, userId)
		.all<SessionRow>();
	return (results ?? []).map(toSession);
}

/**
 * The active session for a repo, if any. There can be at most one — multiple
 * sessions would share the repo's single working directory and conflict.
 */
export async function getActiveSessionForRepo(env: Env, instanceId: string, userId: string, repoId: string): Promise<CodingSessionRecord | null> {
	const row = await env.DB.prepare(
		"SELECT * FROM coding_sessions WHERE repo_id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
	)
		.bind(repoId, instanceId, userId)
		.first<SessionRow>();
	return row ? toSession(row) : null;
}

/**
 * The repo's most recently-USED finished session — the one whose engine conversation a new session
 * would continue (#408).
 *
 * Ordered by `last_activity_at`, not by `ended_at`, and the difference is the point: `ended_at` is
 * when the platform closed the row (the reaper closes a batch in one tick, so several rows can
 * share a second), while `last_activity_at` is when a human or a Pilot last touched it — which is
 * the clock {@link resolveSessionContinuity} judges staleness by and the clock the idle reaper
 * already measures. Selecting by one and judging by the other would let a session that was closed
 * later, but used earlier, decide the answer.
 *
 * Returns the raw fields rather than a `CodingSessionRecord` because `last_activity_at` is not on
 * that type, and putting it there would invite the rest of the surface to start reading it.
 */
export async function getLastFinishedSessionForRepo(
	env: Env,
	instanceId: string,
	userId: string,
	repoId: string,
): Promise<{ id: string; clientType: string; status: string; lastActivityAt: number | null } | null> {
	const row = await env.DB.prepare(
		`SELECT id, client_type, status, last_activity_at
		   FROM coding_sessions
		  WHERE repo_id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status IN ('ended', 'error')
		  ORDER BY COALESCE(last_activity_at, 0) DESC, updated_at DESC LIMIT 1`,
	)
		.bind(repoId, instanceId, userId)
		.first<{ id: string; client_type: string; status: string; last_activity_at: number | null }>();
	if (!row) return null;
	return {
		id: row.id,
		clientType: client(row.client_type),
		status: row.status,
		lastActivityAt: typeof row.last_activity_at === "number" ? row.last_activity_at : null,
	};
}

export async function getSession(env: Env, instanceId: string, userId: string, sessionId: string): Promise<CodingSessionRecord | null> {
	const row = await env.DB.prepare(
		"SELECT * FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(sessionId, instanceId, userId)
		.first<SessionRow>();
	return row ? toSession(row) : null;
}

export async function createSession(env: Env, instanceId: string, userId: string, input: NewSessionInput): Promise<CodingSessionRecord> {
	const id = `csess_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, tmux_session, launch_command, issue_number, issue_title, runner_node, last_activity_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?11)`,
	)
		.bind(
			id,
			instanceId,
			input.repoId,
			userId,
			input.clientType ?? "claude",
			`pags-${input.clientType ?? "claude"}-${id}`,
			input.launchCommand ?? null,
			input.issueNumber ?? null,
			input.issueTitle ?? null,
			input.runnerNode ?? null,
			// Stamped at creation, not left NULL: the idle sweep compares against this column, and a
			// session that is brand new is the one thing it must never reap.
			Date.now(),
		)
		.run();
	const session = await getSession(env, instanceId, userId, id);
	if (!session) throw new Error("session insert failed");
	// A live session belongs on the work board — that is what makes it visible to a supervisor
	// (and to the human) without anything having to read `coding_sessions` (#206).
	const repo = await getRepo(env, instanceId, userId, input.repoId).catch(() => null);
	await upsertCodingSessionCard(env, {
		instanceId,
		userId,
		sessionId: id,
		repoName: repo?.name ?? input.repoId,
		engine: input.clientType ?? "claude",
		status: "running",
	});
	return session;
}

/**
 * Suspend all active sessions for an instance — called when a different machine
 * takes over. The sessions aren't deleted (timeline/history preserved), just
 * marked suspended so the UI shows them as belonging to the old machine.
 */
export async function suspendSessionsFromOtherNodes(env: Env, instanceId: string, userId: string, runnerNode: string): Promise<number> {
	// Suspend active sessions that DON'T belong to the machine now registering — they're
	// the old machine's (or legacy NULL-owner) sessions, kept as history until their owner
	// returns. The registering node's own active sessions are left untouched (a heartbeat /
	// reconnect from the same machine must not suspend its live work).
	// Which ones, BEFORE the update — afterwards they no longer match the predicate, and a card
	// left "running" for a session this machine no longer owns is exactly the stranded state.
	const { results } = await env.DB.prepare(
		`SELECT id FROM coding_sessions
		  WHERE instance_id = ?1 AND user_id = ?2 AND status = 'active'
		    AND (runner_node IS NULL OR runner_node != ?3)`,
	)
		.bind(instanceId, userId, runnerNode)
		.all<{ id: string }>();
	const res = await env.DB.prepare(
		`UPDATE coding_sessions
		 SET status = 'suspended', updated_at = datetime('now')
		 WHERE instance_id = ?1 AND user_id = ?2 AND status = 'active'
		   AND (runner_node IS NULL OR runner_node != ?3)`,
	)
		.bind(instanceId, userId, runnerNode)
		.run();
	// "cancelled", not "failed": a takeover on another machine is a relocation, not an error.
	await closeCodingSessionCards(env, instanceId, userId, (results ?? []).map((r) => r.id), "cancelled");
	return res.meta.changes ?? 0;
}

/**
 * Reactivate the reconnecting machine's OWN suspended sessions. The runner reattaches to the
 * engine sessions on the next /start. Index-safe: resumes at most the newest suspended session
 * per repo, and ONLY for repos with no active session already, so it can never violate
 * idx_coding_sessions_one_active (which an unconditional bulk resume would).
 */
export async function resumeSessionsForNode(env: Env, instanceId: string, userId: string, runnerNode: string): Promise<number> {
	const res = await env.DB.prepare(
		`UPDATE coding_sessions
		 SET status = 'active', ended_at = NULL, updated_at = datetime('now')
		 WHERE rowid IN (
		   SELECT MAX(rowid) FROM coding_sessions
		   WHERE instance_id = ?1 AND user_id = ?2 AND status = 'suspended' AND runner_node = ?3
		   GROUP BY repo_id
		 )
		 AND repo_id NOT IN (
		   SELECT repo_id FROM coding_sessions
		   WHERE instance_id = ?1 AND user_id = ?2 AND status = 'active'
		 )`,
	)
		.bind(instanceId, userId, runnerNode)
		.run();
	return res.meta.changes ?? 0;
}

/**
 * Move a session to a different machine (`runner_node`). Used by the machine-switch reclaim:
 * when a session's owning machine goes offline and the user runs the agent on another machine,
 * point the session at the machine that's connected now so it resumes there instead of
 * dead-ending on the offline one. No status change — the session stays active, just relocates.
 */
export async function reassignSessionNode(env: Env, instanceId: string, userId: string, sessionId: string, runnerNode: string | null): Promise<void> {
	const node = (runnerNode || "").trim().slice(0, 120) || null;
	await env.DB.prepare(
		"UPDATE coding_sessions SET runner_node = ?4, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(sessionId, instanceId, userId, node)
		.run();
}

/**
 * End a session. Also acts on a SUSPENDED one: `pags up --force` on another machine suspends
 * this node's sessions, and with the Pilot no longer cancelling on `suspended` (that would kill a
 * legitimately relocated run) an `active`-only filter left no way to stop it at all — Kill returned
 * 0 changes while the Pilot kept spending BYOK decisions.
 */
export async function endSession(env: Env, instanceId: string, userId: string, sessionId: string, status: CodingSessionStatus = "ended"): Promise<boolean> {
	const res = await env.DB.prepare(
		// driver_id cleared here too: an ended session cannot be "being driven", and this is the
		// ONE place a session leaves `active` (#206), so every terminal path — the end route, the
		// orphan reaper, a takeover, the Pilot's own close — frees the claim without knowing it
		// exists. A claim outliving its session would lock the repo out of all future runs.
		`UPDATE coding_sessions
		 SET status = ?4, ended_at = datetime('now'), updated_at = datetime('now'),
		     driver_id = NULL, driver_at = NULL
		 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status IN ('active', 'suspended')`,
	)
		.bind(sessionId, instanceId, userId, status)
		.run();
	const changed = (res.meta.changes ?? 0) > 0;
	// Only when the row actually moved: a no-op end (already ended) must not resurrect a card.
	if (changed) await closeCodingSessionCards(env, instanceId, userId, [sessionId], status === "error" ? "failed" : "completed");
	return changed;
}

/**
 * Reconcile stale "active" sessions against the runner's live tracked set (#139). When the
 * runner is reachable but is NOT tracking a D1-`active` session, that session was
 * orphaned by a runner restart / machine reboot — mark it `ended` so it stops showing as
 * active forever and can't be handed back by getActiveSessionForRepo as a dead session.
 * A short grace window (updated_at older than 3 minutes) protects a just-created session
 * whose pane hasn't spawned yet. ONLY call when the runner is confirmed reachable —
 * otherwise "not tracked" just means the runner is offline, not that the session died.
 * Returns the ids that were reaped.
 */
export async function reconcileOrphanedSessions(
	env: Env,
	instanceId: string,
	userId: string,
	liveSessionIds: Iterable<string>,
): Promise<string[]> {
	const live = new Set(liveSessionIds);
	const { results } = await env.DB.prepare(
		`SELECT id FROM coding_sessions
		 WHERE instance_id = ?1 AND user_id = ?2 AND status = 'active'
		   AND updated_at < datetime('now', '-3 minutes')`,
	)
		.bind(instanceId, userId)
		.all<{ id: string }>();
	const orphaned = (results ?? []).map((r) => r.id).filter((id) => !live.has(id));
	for (const id of orphaned) {
		await endSession(env, instanceId, userId, id, "ended");
	}
	return orphaned;
}

/**
 * How often a session's activity stamp is allowed to be rewritten (#275).
 *
 * `/capture` polls every 3 seconds per open session and the Pilot polls every 2 seconds inside
 * `waitIdle`, so an unconditional write would be tens of thousands of rows a day per session to
 * record a fact the sweeper reads at a SIX-HOUR resolution. The predicate lives in the UPDATE, so
 * a throttled call is a statement that writes zero rows rather than a read followed by a write.
 */
export const ACTIVITY_TOUCH_MS = 60_000;

/**
 * "Somebody is engaged with this session." The signal the idle reaper measures against.
 *
 * Deliberately separate from `touchSessionDriver`: that one is scoped to the holder of the
 * single-flight claim and answers "is the WORKFLOW alive". This one answers "is anyone — a human
 * watching the terminal, a Co-pilot summarising, a Pilot driving — still using this engine", which
 * is the only question that licenses killing a child process on someone's laptop.
 *
 * Only touches `active` sessions: resurrecting the stamp on an ended one would be a lie, and
 * nothing reads it there.
 */
export async function touchSessionActivity(
	env: Env,
	instanceId: string,
	userId: string,
	sessionId: string,
	now: number = Date.now(),
): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_sessions SET last_activity_at = ?4
		  WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'active'
		    AND (last_activity_at IS NULL OR last_activity_at < ?5)`,
	)
		.bind(sessionId, instanceId, userId, now, now - ACTIVITY_TOUCH_MS)
		.run()
		.catch(() => undefined);
}

/** One `active` session row, as the cross-tenant sweeper needs it (owner included). */
export interface IdleSessionRow {
	id: string;
	instanceId: string;
	userId: string;
	repoId: string;
	runnerNode: string | null;
}

/**
 * Active sessions nobody has touched since `cutoff`, across all owners — the sweeper's input.
 *
 * `driver_at` is in the predicate as well as `last_activity_at`, and against the SAME cutoff: the
 * claim has to be as stale as the session before either is reaped. That is far stricter than
 * `STALE_DRIVER_MS` needs (15 minutes vs six hours) and deliberately so — reaping a session out
 * from under a live run is the one outcome strictly worse than the leak, so the cheap over-caution
 * is bought at the price of a few extra idle hours in a case that should not arise at all.
 * `COALESCE(..., updated_at)` covers a row whose column predates the backfill (a session created by
 * an in-flight isolate mid-deploy).
 */
export async function listIdleSessions(env: Env, cutoff: number, limit: number): Promise<IdleSessionRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, instance_id, user_id, repo_id, runner_node FROM coding_sessions
		  WHERE status = 'active'
		    AND COALESCE(last_activity_at, CAST(strftime('%s', updated_at) AS INTEGER) * 1000) < ?1
		    AND (driver_at IS NULL OR driver_at < ?2)
		  ORDER BY COALESCE(last_activity_at, 0) ASC
		  LIMIT ?3`,
	)
		.bind(cutoff, cutoff, limit)
		.all<{ id: string; instance_id: string; user_id: string; repo_id: string; runner_node: string | null }>();
	return (results ?? []).map((r) => ({
		id: r.id,
		instanceId: r.instance_id,
		userId: r.user_id,
		repoId: r.repo_id,
		runnerNode: r.runner_node,
	}));
}

/**
 * Instances holding an `active` session that has been quiet for a while — the orphan reconcile's
 * input.
 *
 * Quiet-gated on purpose. Reconciling asks the RUNNER what it is tracking, which is a relay round
 * trip per instance per cron tick; a session being captured every 3 seconds is self-evidently not
 * orphaned, so the common case (somebody actually working) costs nothing.
 */
export async function listInstancesWithQuietSessions(
	env: Env,
	quietBefore: number,
	limit: number,
): Promise<Array<{ instanceId: string; userId: string }>> {
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT instance_id, user_id FROM coding_sessions
		  WHERE status = 'active'
		    AND COALESCE(last_activity_at, CAST(strftime('%s', updated_at) AS INTEGER) * 1000) < ?1
		  LIMIT ?2`,
	)
		.bind(quietBefore, limit)
		.all<{ instance_id: string; user_id: string }>();
	return (results ?? []).map((r) => ({ instanceId: r.instance_id, userId: r.user_id }));
}

/**
 * How long a claim survives without a heartbeat before another driver may take it.
 *
 * A claim with no expiry was a permanent lockout. Release happens in `endSession`, and the
 * reasoning was that a dead workflow would be cleaned up by `reconcileOrphanedSessions` — but that
 * only fires when the RUNNER stops tracking the session. A workflow that dies while its engine
 * process is perfectly healthy leaves the session `active` forever, and every later run gets "already being worked on"
 * with nothing to stop and no way back. That happened in production within hours.
 *
 * Fifteen minutes because a live Pilot heartbeats on every action (`touchSessionDriver`), so the
 * only way to go quiet this long is to be dead — except across a human handoff, which is itself
 * bounded at 15 minutes, so the window is deliberately not shorter.
 */
export const STALE_DRIVER_MS = 15 * 60_000;

/**
 * Keep a live claim fresh. Cheap enough to call per action: it rides the same hook that already
 * records progress, and without it a long run would expire its own claim mid-flight.
 */
export async function touchSessionDriver(
	env: Env,
	instanceId: string,
	userId: string,
	sessionId: string,
	driverId: string,
): Promise<void> {
	await env.DB.prepare(
		// `last_activity_at` rides along (#275): a Pilot heartbeating its claim IS the session being
		// used, and writing both here means the idle sweep needs no special knowledge of workflows.
		"UPDATE coding_sessions SET driver_at = ?5, last_activity_at = ?5 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND driver_id = ?4",
	)
		.bind(sessionId, instanceId, userId, driverId, Date.now())
		.run()
		.catch(() => undefined);
}

/**
 * Claim the right to DRIVE a session, atomically. Returns false when someone already holds it.
 *
 * The condition is in the UPDATE, not in a preceding SELECT: a check-then-act would let two
 * concurrent `/run` calls both read "free" and both proceed, which is precisely the race being
 * closed. `status = 'active'` is part of the predicate so an ended session cannot be claimed.
 *
 * A claim that has gone quiet for {@link STALE_DRIVER_MS} is takeable. `driver_at IS NULL` is
 * takeable too — a row claimed before the heartbeat existed must not lock the session forever.
 */
export async function claimSessionDriver(
	env: Env,
	instanceId: string,
	userId: string,
	sessionId: string,
	driverId: string,
): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE coding_sessions
		    SET driver_id = ?5, driver_at = ?4, last_activity_at = ?4, updated_at = datetime('now')
		  WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3
		    AND status = 'active'
		    AND (driver_id IS NULL OR driver_id = ?5 OR driver_at IS NULL OR driver_at < ?6)`,
	)
		.bind(sessionId, instanceId, userId, Date.now(), driverId, Date.now() - STALE_DRIVER_MS)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** Give the session back. Scoped to the holder, so a late release can't free someone else's claim. */
export async function releaseSessionDriver(
	env: Env,
	instanceId: string,
	userId: string,
	sessionId: string,
	driverId: string,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_sessions
		    SET driver_id = NULL, driver_at = NULL, updated_at = datetime('now')
		  WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND driver_id = ?4`,
	)
		.bind(sessionId, instanceId, userId, driverId)
		.run()
		.catch(() => undefined);
}
