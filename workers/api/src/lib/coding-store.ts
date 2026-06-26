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
	created_at: string;
	updated_at: string;
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

/** Rename a repo/project (the editable display name). Scoped to the owner. */
export async function renameRepo(
	env: Env,
	instanceId: string,
	userId: string,
	repoId: string,
	name: string,
): Promise<boolean> {
	const res = await env.DB.prepare(
		"UPDATE coding_repos SET name = ?4, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(repoId, instanceId, userId, name.slice(0, 120))
		.run();
	return (res.meta.changes ?? 0) > 0;
}

export async function deleteRepo(env: Env, instanceId: string, userId: string, repoId: string): Promise<boolean> {
	const res = await env.DB.prepare(
		"DELETE FROM coding_repos WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(repoId, instanceId, userId)
		.run();
	return (res.meta.changes ?? 0) > 0;
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
	issueNumber?: number;
	issueTitle?: string;
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
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status, tmux_session, issue_number, issue_title)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8)`,
	)
		.bind(
			id,
			instanceId,
			input.repoId,
			userId,
			input.clientType ?? "claude",
			`pags-${input.clientType ?? "claude"}-${id}`,
			input.issueNumber ?? null,
			input.issueTitle ?? null,
		)
		.run();
	const session = await getSession(env, instanceId, userId, id);
	if (!session) throw new Error("session insert failed");
	return session;
}

export async function endSession(env: Env, instanceId: string, userId: string, sessionId: string, status: CodingSessionStatus = "ended"): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE coding_sessions
		 SET status = ?4, ended_at = datetime('now'), updated_at = datetime('now')
		 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'active'`,
	)
		.bind(sessionId, instanceId, userId, status)
		.run();
	return (res.meta.changes ?? 0) > 0;
}
