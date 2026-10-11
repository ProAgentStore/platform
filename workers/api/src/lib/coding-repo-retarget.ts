/**
 * Retarget a coding repo binding IN PLACE after its GitHub repository was renamed or moved (#1012).
 *
 * Removing and re-adding a binding is destructive — `deleteRepo` takes the sessions, the timeline
 * and the row's instructions with it. This primitive updates the one row instead, so every child
 * keeps the same `repo_id`.
 *
 * It is deliberately narrow:
 *
 *   - SAME repository only. The destination's numeric GitHub id must equal the binding's. A
 *     different repository that took over the old name is a NEW binding (`coding_repo_add`), never
 *     a retarget: moving history onto it would relabel past work as work on another repository.
 *   - Idle bindings only. Active/suspended sessions, driver locks, running or parked runs, pending
 *     queue entries and in-flight starts are blockers. Nothing is killed, drained or redirected.
 *   - Metadata only. It never runs git, clones, pushes, or starts work. The route proves the
 *     machine's checkout already points at the destination before it calls in here.
 *
 * Callers must canonicalise the identities with GitHub first (the route does). This module still
 * treats every supplied value as untrusted for concurrency: its conditional UPDATE repeats every
 * guard, and is the final compare-and-set.
 */
import type { Env } from "../types.js";
import type { CodingRepo } from "./coding-types.js";
import { type RepoRow, toRepo } from "./coding-store.js";
import { IN_FLIGHT_MS } from "./loop-busy.js";

export interface RetargetCoordinate {
	owner: string;
	name: string;
}

export interface RetargetRequest {
	instanceId: string;
	userId: string;
	repoId: string;
	/** What the caller saw. `githubId` is required once the binding has one recorded. */
	expectedCurrent: RetargetCoordinate & { githubId?: number; version: number };
	/** The canonical destination, as GitHub reports it for this exact numeric id. */
	destination: RetargetCoordinate & { githubId: number };
	dryRun?: boolean;
	/** Refusals the route established before calling in (local origin, runner reachability). */
	routeBlockers?: string[];
	now?: number;
}

export interface RetargetChanges {
	githubRepo: { from: string; to: string };
	githubRepositoryId: { from: number | null; to: number };
	bindingVersion: { from: number; to: number };
	webUrl: { from: string | null; to: string };
	cloneUrl: { from: string | null; to: string | null };
}

export interface RetargetAudit {
	id: string;
	state: "prepared" | "applied" | "conflicted";
	from: string;
	to: string;
	githubRepositoryId: number;
	expectedBindingVersion: number;
	resultingBindingVersion: number;
	createdAt: number;
	appliedAt: number | null;
}

/** The exact input of the reverse retarget; it is another guarded retarget, never a blind undo. */
export interface RetargetRollback {
	expectedCurrent: RetargetCoordinate & { githubId: number; version: number };
	destination: RetargetCoordinate & { githubId: number };
}

export type RetargetResult =
	| { kind: "not-found" }
	| { kind: "not-github" }
	| { kind: "stale"; actual: { githubRepo: string; githubRepositoryId: number | null; version: number } }
	| { kind: "different-repository"; bindingGithubId: number }
	| { kind: "conflict"; conflictingRepoId: string }
	| { kind: "busy"; blockers: string[] }
	| { kind: "preview"; repo: CodingRepo; changes: RetargetChanges; blockers: string[] }
	| { kind: "idempotent"; repo: CodingRepo; audit: RetargetAudit | null }
	| { kind: "applied"; repo: CodingRepo; audit: RetargetAudit; rollback: RetargetRollback };

const slugOf = (c: RetargetCoordinate) => `${c.owner}/${c.name}`;
const sameSlug = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

/**
 * The stored clone URL with its repository path moved, in whatever protocol it already used.
 * Anything that does not end in the old coordinate is cleared rather than guessed at — a stale
 * clone URL is the one field that would quietly restore the old remote (`cloneSourceFor`), and
 * clearing it falls back to the web URL this same update writes.
 */
export function retargetCloneUrl(cloneUrl: string | null | undefined, from: string, to: string): string | null {
	if (!cloneUrl) return null;
	const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`([/:])${escaped}(\\.git)?/?$`, "i");
	return pattern.test(cloneUrl) ? cloneUrl.replace(pattern, (_m, sep: string, git: string | undefined) => `${sep}${to}${git ?? ""}`) : null;
}

/**
 * What would refuse a retarget right now. The same predicates are repeated inside the guarded
 * UPDATE, so this read is the explanation, not the protection.
 */
const BLOCKER_SQL = {
	active_session: "EXISTS(SELECT 1 FROM coding_sessions s WHERE s.repo_id = ?3 AND s.instance_id = ?1 AND s.user_id = ?2 AND s.status IN ('active', 'suspended'))",
	session_lock: "EXISTS(SELECT 1 FROM coding_sessions s WHERE s.repo_id = ?3 AND s.instance_id = ?1 AND s.user_id = ?2 AND s.driver_id IS NOT NULL)",
	active_run:
		"EXISTS(SELECT 1 FROM agent_loop_runs r LEFT JOIN coding_sessions rs ON rs.id = r.session_id WHERE r.instance_id = ?1 AND r.user_id = ?2 AND r.status IN ('running', 'needs_human') AND (rs.repo_id = ?3 OR r.session_id IS NULL))",
	queued_work: "EXISTS(SELECT 1 FROM instance_objective_queue q WHERE q.instance_id = ?1 AND q.user_id = ?2 AND q.status IN ('pending', 'running') AND (q.repo_id = ?3 OR q.repo_id IS NULL))",
	pending_start:
		"EXISTS(SELECT 1 FROM loop_start_receipts l WHERE l.instance_id = ?1 AND l.user_id = ?2 AND l.state = 'provisioning' AND l.created_at >= ?4 AND (json_extract(l.input_json, '$.repoId') = ?3 OR json_extract(l.input_json, '$.repoId') IS NULL))",
} as const;

export async function retargetBlockers(env: Env, instanceId: string, userId: string, repoId: string, now: number): Promise<string[]> {
	const row = await env.DB.prepare(`SELECT ${Object.entries(BLOCKER_SQL).map(([k, sql]) => `${sql} AS ${k}`).join(", ")}`)
		.bind(instanceId, userId, repoId, now - IN_FLIGHT_MS)
		.first<Record<string, number | null>>();
	return Object.keys(BLOCKER_SQL).filter((k) => Boolean(row?.[k]));
}

interface AuditRow {
	id: string;
	state: RetargetAudit["state"];
	previous_owner: string;
	previous_name: string;
	destination_owner: string;
	destination_name: string;
	github_repository_id: number;
	expected_binding_version: number;
	resulting_binding_version: number;
	created_at: number;
	applied_at: number | null;
}

function toAudit(r: AuditRow): RetargetAudit {
	return {
		id: r.id,
		state: r.state,
		from: `${r.previous_owner}/${r.previous_name}`,
		to: `${r.destination_owner}/${r.destination_name}`,
		githubRepositoryId: r.github_repository_id,
		expectedBindingVersion: r.expected_binding_version,
		resultingBindingVersion: r.resulting_binding_version,
		createdAt: r.created_at,
		appliedAt: r.applied_at,
	};
}

/** Every retarget attempt on this binding, newest first, for the owner's own history views. */
export async function listRetargetAudits(env: Env, instanceId: string, userId: string, repoId: string): Promise<RetargetAudit[]> {
	const rows = await env.DB.prepare("SELECT * FROM coding_repo_retarget_audits WHERE repo_id = ?1 AND instance_id = ?2 AND user_id = ?3 ORDER BY created_at DESC, rowid DESC")
		.bind(repoId, instanceId, userId)
		.all<AuditRow>();
	return (rows.results ?? []).map(toAudit);
}

/**
 * Which coordinate each session actually worked on. A retarget changes the binding's CURRENT
 * coordinate; a session that started before an applied retarget is labelled with the coordinate
 * the binding had then, so history is never silently relabelled.
 */
export function labelSessions(
	current: string,
	audits: RetargetAudit[],
	sessions: Array<{ id: string; startedAt: string }>,
): Array<{ sessionId: string; startedAt: string; githubRepo: string }> {
	const applied = audits.filter((a) => a.state === "applied" && a.appliedAt != null).sort((a, b) => (a.appliedAt as number) - (b.appliedAt as number));
	return sessions.map((s) => {
		const started = Date.parse(`${s.startedAt.replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(s.startedAt) ? "" : "Z"}`);
		const next = applied.find((a) => (a.appliedAt as number) > started);
		return { sessionId: s.id, startedAt: s.startedAt, githubRepo: next ? next.from : current };
	});
}

/**
 * Resolve attempts a crash left `prepared`. The update and the audit's final state commit in one
 * batch, so a `prepared` row whose id the binding does not carry never took effect.
 */
async function settleDanglingAudits(env: Env, repoId: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_repo_retarget_audits
		    SET state = CASE WHEN EXISTS (SELECT 1 FROM coding_repos WHERE id = ?1 AND last_retarget_audit_id = coding_repo_retarget_audits.id) THEN 'applied' ELSE 'conflicted' END
		  WHERE repo_id = ?1 AND state = 'prepared'`,
	)
		.bind(repoId)
		.run();
}

/**
 * A retry whose response was lost: the binding already carries exactly this destination, written by
 * an applied attempt that started from the version the caller names. Nothing is written again.
 */
async function alreadyApplied(env: Env, row: RepoRow, input: RetargetRequest): Promise<RetargetResult | null> {
	const prior = row.last_retarget_audit_id
		? await env.DB.prepare("SELECT * FROM coding_repo_retarget_audits WHERE id = ?1 AND state = 'applied'").bind(row.last_retarget_audit_id).first<AuditRow>()
		: null;
	if (prior && prior.expected_binding_version === input.expectedCurrent.version) return { kind: "idempotent", repo: toRepo(row), audit: toAudit(prior) };
	if ((row.binding_version ?? 1) === input.expectedCurrent.version) return { kind: "idempotent", repo: toRepo(row), audit: null };
	return null;
}

const readRow = (env: Env, input: RetargetRequest) =>
	env.DB.prepare("SELECT * FROM coding_repos WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(input.repoId, input.instanceId, input.userId).first<RepoRow>();

export async function retargetRepositoryBinding(env: Env, input: RetargetRequest): Promise<RetargetResult> {
	const now = input.now ?? Date.now();
	const row = await readRow(env, input);
	if (!row) return { kind: "not-found" };
	if (!row.github_repo) return { kind: "not-github" };

	const storedId = row.github_repository_id ?? null;
	const version = row.binding_version ?? 1;
	const target = slugOf(input.destination);
	const actual = { githubRepo: row.github_repo, githubRepositoryId: storedId, version };

	if (sameSlug(row.github_repo, target) && storedId === input.destination.githubId) return (await alreadyApplied(env, row, input)) ?? { kind: "stale", actual };

	// Explicit expected-current: coordinate, version, and the numeric id once one is recorded.
	const expectedId = input.expectedCurrent.githubId;
	if (!sameSlug(row.github_repo, slugOf(input.expectedCurrent)) || version !== input.expectedCurrent.version || (storedId !== null && expectedId !== storedId)) {
		return { kind: "stale", actual };
	}
	// For a binding that predates the numeric id, the route has proved via GitHub that the stored
	// coordinate resolves to `expectedId`; with neither, there is no identity to preserve.
	const bindingGithubId = storedId ?? expectedId;
	if (!bindingGithubId) return { kind: "stale", actual };
	if (input.destination.githubId !== bindingGithubId) return { kind: "different-repository", bindingGithubId };

	const conflict = await env.DB.prepare(
		"SELECT id FROM coding_repos WHERE instance_id = ?1 AND id <> ?2 AND (lower(github_repo) = lower(?3) OR github_repository_id = ?4) LIMIT 1",
	)
		.bind(input.instanceId, input.repoId, target, bindingGithubId)
		.first<{ id: string }>();
	if (conflict) return { kind: "conflict", conflictingRepoId: conflict.id };

	const blockers = [...(input.routeBlockers ?? []), ...(await retargetBlockers(env, input.instanceId, input.userId, input.repoId, now))];
	const cloneUrl = retargetCloneUrl(row.clone_url, row.github_repo, target);
	const webUrl = `https://github.com/${target}`;
	if (input.dryRun) {
		const changes: RetargetChanges = {
			githubRepo: { from: row.github_repo, to: target },
			githubRepositoryId: { from: storedId, to: bindingGithubId },
			bindingVersion: { from: version, to: version + 1 },
			webUrl: { from: row.web_url ?? null, to: webUrl },
			cloneUrl: { from: row.clone_url ?? null, to: cloneUrl },
		};
		return { kind: "preview", repo: toRepo(row), changes, blockers };
	}
	if (blockers.length) return { kind: "busy", blockers };

	// Apply path only: a dry run must not write anything, including this bookkeeping.
	await settleDanglingAudits(env, row.id);
	const auditId = `repo-retarget-${crypto.randomUUID()}`;
	// Durable intent first. A crash between this and the batch leaves a `prepared` row the next
	// attempt settles; the batch itself either changes the binding AND marks the audit applied, or
	// changes nothing and marks it conflicted.
	await env.DB.prepare(
		`INSERT INTO coding_repo_retarget_audits
		 (id, repo_id, instance_id, user_id, expected_binding_version, previous_owner, previous_name, previous_clone_url,
		  destination_owner, destination_name, github_repository_id, resulting_binding_version, state, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'prepared', ?13)`,
	)
		.bind(auditId, row.id, input.instanceId, input.userId, version, input.expectedCurrent.owner, input.expectedCurrent.name, row.clone_url ?? null, input.destination.owner, input.destination.name, bindingGithubId, version + 1, now)
		.run();

	const guards = Object.values(BLOCKER_SQL).map((sql) => `AND NOT ${sql.replace(/\?4\b/g, "?11")}`).join("\n\t\t   ");
	const guardedUpdate = env.DB.prepare(
		`UPDATE coding_repos
		    SET github_repo = ?4, github_repository_id = ?5, binding_version = binding_version + 1, last_retarget_audit_id = ?6,
		        repo_slug = ?4, web_url = ?7, clone_url = ?8, updated_at = datetime('now')
		  WHERE id = ?3 AND instance_id = ?1 AND user_id = ?2
		    AND lower(github_repo) = lower(?9) AND binding_version = ?10
		    AND (github_repository_id IS NULL OR github_repository_id = ?5)
		    AND NOT EXISTS (SELECT 1 FROM coding_repos other WHERE other.instance_id = ?1 AND other.id <> ?3 AND (lower(other.github_repo) = lower(?4) OR other.github_repository_id = ?5))
		   ${guards}`,
	).bind(input.instanceId, input.userId, row.id, target, bindingGithubId, auditId, webUrl, cloneUrl, row.github_repo, version, now - IN_FLIGHT_MS);
	const finishAudit = env.DB.prepare(
		`UPDATE coding_repo_retarget_audits
		    SET state = CASE WHEN EXISTS (SELECT 1 FROM coding_repos WHERE id = ?2 AND last_retarget_audit_id = ?1) THEN 'applied' ELSE 'conflicted' END,
		        applied_at = CASE WHEN EXISTS (SELECT 1 FROM coding_repos WHERE id = ?2 AND last_retarget_audit_id = ?1) THEN ?3 ELSE NULL END
		  WHERE id = ?1`,
	).bind(auditId, row.id, now);
	await env.DB.batch([guardedUpdate, finishAudit]);

	// The audit's final state, keyed to this exact attempt, is the proof of who won a race.
	const done = await env.DB.prepare("SELECT * FROM coding_repo_retarget_audits WHERE id = ?1").bind(auditId).first<AuditRow>();
	const after = await readRow(env, input);
	if (done?.state !== "applied" || !after) {
		// Lost a race to an identical request: that write is this request's write.
		const same = after && sameSlug(after.github_repo, target) && after.github_repository_id === bindingGithubId ? await alreadyApplied(env, after, input) : null;
		if (same) return same;
		const racedBlockers = await retargetBlockers(env, input.instanceId, input.userId, input.repoId, now);
		if (racedBlockers.length) return { kind: "busy", blockers: racedBlockers };
		return { kind: "stale", actual: { githubRepo: after?.github_repo ?? row.github_repo, githubRepositoryId: after?.github_repository_id ?? null, version: after?.binding_version ?? version } };
	}
	return {
		kind: "applied",
		repo: toRepo(after),
		audit: toAudit(done),
		rollback: {
			expectedCurrent: { ...input.destination, githubId: bindingGithubId, version: version + 1 },
			destination: { owner: input.expectedCurrent.owner, name: input.expectedCurrent.name, githubId: bindingGithubId },
		},
	};
}
