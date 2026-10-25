/** A question's issue is provided by the server or by the board's cached issue card. */
export interface QuestionIssue {
	repo?: string;
	number: number;
	title: string;
	url: string;
	summary?: string;
}

/** Never turn an agent-written URL or a bare issue number into an arbitrary outbound link. */
export function verifiedQuestionIssue(value: unknown): QuestionIssue | null {
	if (!value || typeof value !== "object") return null;
	const issue = value as Record<string, unknown>;
	if (!Number.isSafeInteger(issue.number) || Number(issue.number) <= 0 || typeof issue.title !== "string" || !issue.title.trim() || typeof issue.url !== "string") return null;
	try {
		const url = new URL(issue.url);
		const path = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/);
		if (url.origin !== "https://github.com" || url.username || url.password || !path || Number(path[3]) !== issue.number) return null;
		const repo = `${path[1]}/${path[2]}`;
		if (typeof issue.repo === "string" && issue.repo && issue.repo.toLowerCase() !== repo.toLowerCase()) return null;
		return {
			repo,
			number: Number(issue.number),
			title: issue.title.trim(),
			url: url.href,
			...(typeof issue.summary === "string" && issue.summary.trim() ? { summary: issue.summary.trim() } : {}),
		};
	} catch { return null; }
}

export function resolveQuestionIssue(eventIssue: unknown, boardIssue: unknown): QuestionIssue | null {
	return verifiedQuestionIssue(eventIssue) ?? verifiedQuestionIssue(boardIssue);
}

export default function QuestionIssueContext({ issue, codingQuestion = false, objective }: { issue: QuestionIssue | null; codingQuestion?: boolean; objective?: string }) {
	if (!issue) return codingQuestion ? (
		<div className="mb-3 rounded-lg border border-line bg-panel/70 p-3" data-testid="question-source-unavailable">
			<div className="text-xs font-bold uppercase tracking-wide text-muted-soft mb-1">Source issue unavailable</div>
			<p className="text-sm text-muted">No linked source issue is available for this coding run. Review the run and the agent’s reason below before answering.</p>
			{objective?.trim() && <p className="text-sm text-ink mt-2 break-words line-clamp-4">Run: {objective.trim()}</p>}
		</div>
	) : null;
	return (
		<div className="mb-3 rounded-lg border border-line bg-panel/70 p-3" data-testid="question-issue-context">
			<div className="text-xs font-bold uppercase tracking-wide text-muted-soft mb-1">Question about this issue</div>
			<a href={issue.url} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline break-words" title="Read the full issue and comments on GitHub">
				{issue.repo}#{issue.number}: {issue.title} ↗
			</a>
			{issue.summary && <p className="text-sm text-muted mt-1 break-words line-clamp-3">{issue.summary}</p>}
			<p className="text-xs text-muted-soft mt-1">Open the issue to read its requirements and discussion before answering.</p>
		</div>
	);
}
