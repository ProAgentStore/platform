/**
 * The issue layer of a board read (#895): which cards ARE GitHub issues, the run working each one,
 * the commit that closed it, and every card's lane. Two reads for the whole board — it polls every 2.5s.
 *
 * The issue comes from the ticket's cache (`tickets.issue_cache`, kept by `issue-sync.ts`), never from
 * GitHub. The run is the newest `agent_loop_runs` row linked to the ticket (`ticket_id`, written at run
 * start by `linkRunToIssue`); a coding session's card shows the issue its newest linked run works on.
 */
import type { Env } from "../types.js";
import { type BoardLane, issuePriority, laneFor, statusForIssueCard } from "./board-lanes.js";
import { type IssueCache, parseIssueCache } from "./issue-tickets.js";
import type { Ticket } from "./tickets.js";

/** The run behind an issue card. */
export interface IssueRunView {
	runId: string;
	sessionId: string | null;
	status: string;
	waitingReason: string | null;
}

/** The fields this layer sets on a board card — a subset of `BoardItemView`. */
export interface IssueLayerCard {
	ticketId?: string;
	codingSessionId?: string;
	attempts: Array<{ id: string }>;
	userStatus: string | null;
	runStatus: string;
	status: string;
	githubIssue?: { number: number; title: string; state: string; labels: string[]; url: string; repo?: string; assignees?: string[]; closedAt?: string | null; stateReason?: string | null; summary?: string };
	lane?: BoardLane | null;
	issueRun?: IssueRunView;
	closingCommit?: { sha: string; url: string };
	priority?: number;
}

const projection = (c: IssueCache) => ({
	number: c.number,
	title: c.title,
	state: c.state,
	labels: c.labels,
	url: c.url,
	repo: c.repo,
	assignees: c.assignees,
	closedAt: c.closedAt,
	stateReason: c.stateReason,
	summary: c.summary,
});

export async function applyIssueLayer(env: Env, instanceId: string, userId: string, items: IssueLayerCard[], tickets: readonly Ticket[]): Promise<void> {
	const issueTickets = new Map<string, { ticket: Ticket; cache: IssueCache | null }>();
	for (const t of tickets) if (t.issueNumber != null) issueTickets.set(t.id, { ticket: t, cache: parseIssueCache(t.issueCache) });

	const [runRows, closureRows] = issueTickets.size
		? await Promise.all([
				env.DB.prepare(
					`SELECT ticket_id, run_id, session_id, status, waiting_reason FROM agent_loop_runs
					  WHERE instance_id = ?1 AND user_id = ?2 AND ticket_id IS NOT NULL ORDER BY started_at DESC LIMIT 500`,
				)
					.bind(instanceId, userId)
					.all<{ ticket_id: string; run_id: string; session_id: string | null; status: string; waiting_reason: string | null }>()
					.catch(() => ({ results: [] })),
				env.DB.prepare(
					`SELECT t.id AS ticket_id, c.sha FROM issue_closures c
					   JOIN tickets t ON t.repo_id = c.repo_id AND t.issue_number = c.issue_number
					  WHERE t.instance_id = ?1 AND t.user_id = ?2 ORDER BY c.committed_at DESC`,
				)
					.bind(instanceId, userId)
					.all<{ ticket_id: string; sha: string }>()
					.catch(() => ({ results: [] })),
			])
		: [{ results: [] }, { results: [] }];

	const runByTicket = new Map<string, IssueRunView>();
	const ticketBySession = new Map<string, string>();
	for (const r of runRows.results ?? []) {
		if (!runByTicket.has(r.ticket_id)) runByTicket.set(r.ticket_id, { runId: r.run_id, sessionId: r.session_id, status: r.status, waitingReason: r.waiting_reason });
		if (r.session_id && !ticketBySession.has(r.session_id)) ticketBySession.set(r.session_id, r.ticket_id);
	}
	const closingByTicket = new Map<string, string>();
	for (const c of closureRows.results ?? []) if (!closingByTicket.has(c.ticket_id)) closingByTicket.set(c.ticket_id, c.sha);

	for (const item of items) {
		const ticketId = item.ticketId && issueTickets.has(item.ticketId) ? item.ticketId : item.codingSessionId ? ticketBySession.get(item.codingSessionId) : undefined;
		const issue = ticketId ? issueTickets.get(ticketId) : undefined;
		const run = ticketId ? (runByTicket.get(ticketId) ?? null) : null;
		if (issue?.cache) {
			item.githubIssue = projection(issue.cache);
			item.priority = issuePriority(issue.cache.labels);
			const sha = closingByTicket.get(issue.ticket.id);
			if (sha && issue.cache.repo) item.closingCommit = { sha, url: `https://github.com/${issue.cache.repo}/commit/${sha}` };
		}
		if (run) item.issueRun = run;
		// A person's move outranks the derivation, exactly as `userStatus` outranks the run status.
		if (item.userStatus) {
			item.lane = laneFor({ status: item.userStatus });
			continue;
		}
		if (issue && item.ticketId === issue.ticket.id) {
			// The issue's own card. No runtime task is ever keyed `issue:…`, so any attempt it carries is
			// a stored snapshot nothing refreshes — its status comes from the linked RUN and the issue,
			// and is written back so the agent's ordinary columns (`columnForStatus`) still place it.
			const derived = laneFor({ issue: issue.cache ?? { state: "open", labels: [] }, run, status: "" });
			// Released to the ticket queue (#864) and not yet started: queued, not just backlog.
			const lane = derived === "backlog" && issue.ticket.pickupAuthority === "agent" ? "queued" : derived;
			item.lane = lane;
			item.runStatus = item.status = statusForIssueCard(lane, run);
			continue;
		}
		// Any other card — a coding session's included — stands where its own status puts it; an issue
		// it shows is what it is working ON, not where it is.
		item.lane = laneFor({ status: item.status });
	}
}
