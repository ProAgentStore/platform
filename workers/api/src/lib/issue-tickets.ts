/**
 * A GitHub issue as a board card (#895): the ticket that IS the issue, and the runs linked to it.
 *
 * The issue's identity lives on the ticket (migration 0183), keyed `issue:<repo_id>#<number>`, unique
 * per (instance, repo, issue). Every path that learns of an issue goes through {@link upsertIssueTicket}:
 * the sync finding an open issue (`sync` — the backlog), a run whose objective is about one
 * (`objective`), a caller naming one (`explicit`), a person linking one (`manual`). Runs join it through
 * `agent_loop_runs.ticket_id`, written by {@link linkRunToIssue} when a coding run starts.
 *
 * Backlog tickets keep the ticket default `pickup_authority = 'human'`: an issue showing up on the board
 * is never, by itself, permission for the ticket queue to start work on it.
 */
import type { Env } from "../types.js";
import { referencedIssue } from "./objective-dedupe.js";
import { readIssue, issueSummary, type IssueSyncRecord } from "./github-issues.js";
import { recordTicket } from "./tickets.js";

export type IssueLinkedBy = "explicit" | "objective" | "manual" | "sync";

/** The issue as a card shows it — `tickets.issue_cache`. */
export interface IssueCache {
	number: number;
	/** `owner/repo`. */
	repo: string;
	title: string;
	state: string;
	stateReason: string | null;
	labels: string[];
	assignees: string[];
	url: string;
	updatedAt: string;
	closedAt: string | null;
	summary: string;
}

export const issueJobKey = (repoId: string, issueNumber: number): string => `issue:${repoId}#${issueNumber}`;

export function issueCacheFrom(repo: string, r: IssueSyncRecord): IssueCache {
	return { number: r.number, repo, title: r.title, state: r.state, stateReason: r.stateReason, labels: r.labels, assignees: r.assignees, url: r.url, updatedAt: r.updatedAt, closedAt: r.closedAt, summary: r.summary };
}

export function parseIssueCache(raw: string | null | undefined): IssueCache | null {
	if (!raw) return null;
	try {
		const o = JSON.parse(raw) as Partial<IssueCache>;
		if (typeof o.number !== "number" || typeof o.title !== "string") return null;
		const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
		return {
			number: o.number,
			repo: typeof o.repo === "string" ? o.repo : "",
			title: o.title,
			state: typeof o.state === "string" ? o.state : "open",
			stateReason: typeof o.stateReason === "string" ? o.stateReason : null,
			labels: strs(o.labels),
			assignees: strs(o.assignees),
			url: typeof o.url === "string" ? o.url : "",
			updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
			closedAt: typeof o.closedAt === "string" ? o.closedAt : null,
			summary: typeof o.summary === "string" ? o.summary : "",
		};
	} catch {
		return null;
	}
}

/** How strongly a link was made: a person or a named argument outranks a parsed one, which outranks the sync. */
const LINK_RANK: Record<IssueLinkedBy, number> = { sync: 0, objective: 1, explicit: 2, manual: 3 };

/**
 * The ticket for (repo, issue) on this instance, created if there is none, with its cache refreshed
 * when one is given. Idempotent: the job key and the partial unique index both decide. A weaker
 * `linked_by` never overwrites a stronger one — the sync re-finding an issue a person linked leaves it
 * linked by that person.
 */
export async function upsertIssueTicket(
	env: Env,
	instanceId: string,
	userId: string,
	input: { repoId: string; issueNumber: number; cache: IssueCache | null; linkedBy: IssueLinkedBy },
): Promise<{ ticketId: string; created: boolean }> {
	const { ticket, created } = await recordTicket(env, instanceId, userId, {
		jobKey: issueJobKey(input.repoId, input.issueNumber),
		title: input.cache ? `#${input.issueNumber} ${input.cache.title}` : `Issue #${input.issueNumber}`,
		description: input.cache?.summary ?? "",
		createdBy: input.linkedBy === "manual" ? "human" : "agent",
	});
	const ranks = Object.entries(LINK_RANK);
	await env.DB.prepare(
		`UPDATE tickets
		    SET repo_id = ?4, issue_number = ?5,
		        issue_cache = COALESCE(?6, issue_cache),
		        title = CASE WHEN ?6 IS NULL THEN title ELSE ?7 END,
		        linked_by = CASE
		          WHEN linked_by IS NULL THEN ?8
		          WHEN (CASE linked_by ${ranks.map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(" ")} END) < ?9 THEN ?8
		          ELSE linked_by END,
		        updated_at = datetime('now')
		  WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(
			ticket.id,
			instanceId,
			userId,
			input.repoId,
			input.issueNumber,
			input.cache ? JSON.stringify(input.cache) : null,
			input.cache ? `#${input.issueNumber} ${input.cache.title}` : null,
			input.linkedBy,
			LINK_RANK[input.linkedBy],
		)
		.run();
	return { ticketId: ticket.id, created };
}

/** `owner/repo#N` in an objective names a repo; a reference to ANOTHER repo is not this run's issue. */
function namesOtherRepo(objective: string, githubRepo: string | null): boolean {
	const m = /\b([\w.-]+\/[\w.-]+)#\d+\b/.exec(objective);
	return !!m && !!githubRepo && m[1].toLowerCase() !== githubRepo.toLowerCase();
}

/**
 * Link a coding run that just started to the issue it works on (#895), and record that on its session.
 *
 * `issue` is the caller's explicit choice; without one the objective's own subject is used
 * (`referencedIssue` — the same reading the queue's duplicate check makes), recorded as `objective` so a
 * wrong guess is visibly a guess. Nothing is linked when neither names an issue, or when the objective
 * names one in a different repository. Best-effort by contract: a run must never fail to start because
 * its board card could not be drawn — the caller swallows a throw.
 */
export async function linkRunToIssue(
	env: Env,
	input: { instanceId: string; userId: string; runId: string; sessionId: string; repoId: string; githubRepo: string | null; objective: string; issue?: number | null },
): Promise<{ ticketId: string; issueNumber: number; linkedBy: IssueLinkedBy } | null> {
	const explicit = typeof input.issue === "number" && Number.isInteger(input.issue) && input.issue > 0 ? input.issue : null;
	const parsed = explicit == null && !namesOtherRepo(input.objective, input.githubRepo) ? referencedIssue(input.objective) : null;
	const issueNumber = explicit ?? parsed;
	if (issueNumber == null) return null;
	const linkedBy: IssueLinkedBy = explicit != null ? "explicit" : "objective";

	// The cache the board already holds, else one read of the issue (conditional, usually a 304).
	const existing = await env.DB.prepare("SELECT issue_cache FROM tickets WHERE instance_id = ?1 AND user_id = ?2 AND repo_id = ?3 AND issue_number = ?4")
		.bind(input.instanceId, input.userId, input.repoId, issueNumber)
		.first<{ issue_cache: string | null }>();
	let cache = parseIssueCache(existing?.issue_cache);
	if (!cache && input.githubRepo) {
		const read = await readIssue(env, input.userId, input.githubRepo, issueNumber).catch(() => null);
		if (read) {
			cache = { number: read.number, repo: input.githubRepo, title: read.title, state: read.state, stateReason: null, labels: read.labels, assignees: [], url: read.url, updatedAt: read.updatedAt, closedAt: null, summary: issueSummary(read.body) };
		}
	}
	const { ticketId } = await upsertIssueTicket(env, input.instanceId, input.userId, { repoId: input.repoId, issueNumber, cache, linkedBy });
	await env.DB.batch([
		env.DB.prepare("UPDATE agent_loop_runs SET ticket_id = ?2 WHERE run_id = ?1 AND user_id = ?3").bind(input.runId, ticketId, input.userId),
		// The column has existed since 0020 and was never written on the run path: a session now names
		// the issue it is working on, for the Terminals page and the "next issue" exclusion alike.
		env.DB.prepare("UPDATE coding_sessions SET issue_number = ?2, issue_title = ?3 WHERE id = ?1 AND instance_id = ?4 AND user_id = ?5").bind(
			input.sessionId,
			issueNumber,
			cache?.title ?? null,
			input.instanceId,
			input.userId,
		),
	]);
	return { ticketId, issueNumber, linkedBy };
}
