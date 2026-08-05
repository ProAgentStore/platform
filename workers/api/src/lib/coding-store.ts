import { closeCodingSessionCards, upsertCodingSessionCard } from "./coding-board.js";
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
	clone_url: string | null;
	branch: string;
	workdir: string | null;
	clone_status: string;
	clone_error: string | null;
	default_client: string;
	urls: string | null;
	instructions: string | null;
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
		cloneUrl: r.clone_url ?? undefined,
		branch: r.branch,
		workdir: r.workdir ?? undefined,
		cloneStatus: r.clone_status as CloneStatus,
		cloneError: r.clone_error ?? undefined,
		defaultClient: client(r.default_client),
		urls: parseRepoUrls(r.urls),
		instructions: r.instructions || undefined,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export interface NewRepoInput {
	name: string;
	githubRepo?: string;
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
	await env.DB.prepare(
		`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, clone_url, branch, workdir, clone_status, default_client)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	)
		.bind(
			id,
			instanceId,
			userId,
			input.name,
			input.githubRepo ?? null,
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
	patch: { cloneStatus?: CloneStatus; cloneError?: string | null; workdir?: string; branch?: string },
): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_repos
		 SET clone_status = COALESCE(?2, clone_status),
		     clone_error  = ?3,
		     workdir      = COALESCE(?4, workdir),
		     branch       = COALESCE(?5, branch),
		     updated_at   = datetime('now')
		 WHERE id = ?1`,
	)
		.bind(repoId, patch.cloneStatus ?? null, patch.cloneError ?? null, patch.workdir ?? null, patch.branch ?? null)
		.run();
}

/** Update a repo's editable fields (name and/or launch URLs). Scoped to the owner. */
export async function updateRepo(
	env: Env,
	instanceId: string,
	userId: string,
	repoId: string,
	patch: { name?: string; urls?: { dev?: string; staging?: string; prod?: string } },
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
		     updated_at = datetime('now')
		 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(repoId, instanceId, userId, patch.name ? patch.name.slice(0, 120) : null, urlsJson, patch.urls === undefined ? 0 : 1)
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
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, tmux_session, launch_command, issue_number, issue_title, runner_node)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10)`,
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
 * tmux sessions on the next /start. Index-safe: resumes at most the newest suspended session
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
		`UPDATE coding_sessions
		 SET status = ?4, ended_at = datetime('now'), updated_at = datetime('now')
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
 * Reconcile stale "active" sessions against the runner's live tmux set (#139). When the
 * runner is reachable but reports NO live tmux for a D1-`active` session, that session was
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
