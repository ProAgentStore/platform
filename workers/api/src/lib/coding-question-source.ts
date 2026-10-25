/** The issue a coding question is about, read from the run's bound session/ticket. */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { parseIssueCache } from "./issue-tickets.js";

export interface CodingQuestionIssue {
	repo: string;
	number: number;
	title: string;
	url: string;
	summary?: string;
}

/** A URL is made only from a registered GitHub repository and an issue number, never question prose. */
export function codingQuestionIssueUrl(repo: unknown, number: unknown): string | null {
	if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
	return `https://github.com/${repo}/issues/${number}`;
}

export async function codingQuestionIssue(
	env: Pick<Env, "DB">,
	input: { instanceId: string; userId: string; sessionId: string; runId?: string | null },
): Promise<CodingQuestionIssue | null> {
	const row = await env.DB.prepare(
		`SELECT r.github_repo AS repo, COALESCE(s.issue_number, t.issue_number) AS issue_number, t.issue_cache
		   FROM coding_sessions s
		   JOIN coding_repos r ON r.id = s.repo_id AND r.instance_id = s.instance_id
		   LEFT JOIN agent_loop_runs l ON l.run_id = ?4 AND l.session_id = s.id AND l.instance_id = s.instance_id AND l.user_id = s.user_id
		   LEFT JOIN tickets t ON t.id = l.ticket_id AND t.instance_id = s.instance_id AND t.user_id = s.user_id
		  WHERE s.id = ?1 AND s.instance_id = ?2 AND s.user_id = ?3`,
	)
		.bind(input.sessionId, input.instanceId, input.userId, input.runId ?? "")
		.first<{ repo: string | null; issue_number: number | null; issue_cache: string | null }>();
	const number = Number(row?.issue_number);
	const url = codingQuestionIssueUrl(row?.repo, number);
	if (!url || !row?.repo) return null;
	const cache = parseIssueCache(row.issue_cache);
	const trusted = cache?.number === number && cache.repo.toLowerCase() === row.repo.toLowerCase() ? cache : null;
	const summary = trusted?.summary?.trim();
	return {
		repo: row.repo,
		number,
		title: trusted?.title?.trim() || `Issue #${number}`,
		url,
		...(summary ? { summary: clipMarked(summary, 320, { within: true }) } : {}),
	};
}
