import MarkdownText from "./MarkdownText";

/** A question's issue is provided by the server or by the board's cached issue card (#1363). */
export type QuestionStaleReason = "issue_closed" | "issue_changed_since_asked" | "context_old";
export type QuestionSourceStatus = "linked" | "none" | "unavailable";

export interface QuestionIssue {
	repo?: string;
	number: number;
	title: string;
	url: string;
	summary?: string;
	issueState?: string;
	issueUpdatedAt?: string;
	stale?: boolean;
	staleReason?: QuestionStaleReason;
	staleDetail?: string;
}

const REASONS: readonly string[] = ["issue_closed", "issue_changed_since_asked", "context_old"];

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
		// The board card calls these `state` / `updatedAt`; a question's issue calls them `issueState` / `issueUpdatedAt`.
		const state = typeof issue.issueState === "string" ? issue.issueState : typeof issue.state === "string" ? issue.state : "";
		const updated = typeof issue.issueUpdatedAt === "string" ? issue.issueUpdatedAt : typeof issue.updatedAt === "string" ? issue.updatedAt : "";
		return {
			repo,
			number: Number(issue.number),
			title: issue.title.trim(),
			url: url.href,
			...(typeof issue.summary === "string" && issue.summary.trim() ? { summary: issue.summary.trim() } : {}),
			...(state ? { issueState: state } : {}),
			...(updated ? { issueUpdatedAt: updated } : {}),
			...(issue.stale === true && typeof issue.staleReason === "string" && REASONS.includes(issue.staleReason)
				? { stale: true, staleReason: issue.staleReason as QuestionStaleReason, ...(typeof issue.staleDetail === "string" && issue.staleDetail ? { staleDetail: issue.staleDetail } : {}) }
				: {}),
		};
	} catch { return null; }
}

/** What the owner is told when a question's issue context may no longer be a safe premise. */
export const STALE_COPY: Record<QuestionStaleReason, string> = {
	issue_closed: "The source issue is closed, so what this question assumes may no longer hold.",
	issue_changed_since_asked: "The source issue was updated after this question was asked.",
	context_old: "The issue context shown here was last refreshed a long time ago.",
};

/**
 * The issue to show, with its freshness judged again against the board's current card (#1363). The question's own issue
 * wins; a stored verdict is kept; otherwise the board's cached state decides, but only for the SAME issue number, and
 * only from the cache the board already serves. Nothing here reads the question's words or calls GitHub.
 */
export function resolveQuestionIssue(eventIssue: unknown, boardIssue: unknown, askedAt?: string | number | null): QuestionIssue | null {
	const own = verifiedQuestionIssue(eventIssue);
	const board = verifiedQuestionIssue(boardIssue);
	if (!own) return board ? withBoardFreshness(board, board, askedAt) : null;
	return withBoardFreshness(own, board && board.number === own.number && board.repo === own.repo ? board : null, askedAt);
}

function withBoardFreshness(issue: QuestionIssue, current: QuestionIssue | null, askedAt?: string | number | null): QuestionIssue {
	if (issue.stale || !current) return issue;
	if (current.issueState && current.issueState.toLowerCase() !== "open") return { ...issue, issueState: current.issueState, stale: true, staleReason: "issue_closed", staleDetail: STALE_COPY.issue_closed };
	const asked = askedAt === undefined || askedAt === null ? Number.NaN : typeof askedAt === "number" ? askedAt : Date.parse(askedAt);
	const updated = current.issueUpdatedAt ? Date.parse(current.issueUpdatedAt) : Number.NaN;
	if (Number.isFinite(asked) && Number.isFinite(updated) && updated > asked) return { ...issue, issueUpdatedAt: current.issueUpdatedAt, stale: true, staleReason: "issue_changed_since_asked", staleDetail: STALE_COPY.issue_changed_since_asked };
	return issue;
}

interface Props {
	issue: QuestionIssue | null;
	codingQuestion?: boolean;
	objective?: string;
	/** What the server knows about the source: a link, nothing bound, or a lookup that failed. */
	status?: QuestionSourceStatus;
}

export default function QuestionIssueContext({ issue, codingQuestion = false, objective, status }: Props) {
	if (!issue) {
		if (!codingQuestion) return null;
		const failed = status === "unavailable";
		return (
			<div className="mb-3 rounded-lg border border-line bg-panel/70 p-3" data-testid={failed ? "question-source-unavailable" : "question-source-none"}>
				<div className="text-xs font-bold uppercase tracking-wide text-muted-soft mb-1">{failed ? "Source issue could not be loaded" : "No source issue linked"}</div>
				<p className="text-sm text-muted">
					{failed
						? "The platform could not look up the issue this run is working on, so no link is shown. Review the run and the agent’s reason below before answering."
						: "This coding run is not linked to an issue, so there is nothing to open. Review the run and the agent’s reason below before answering."}
				</p>
				{objective?.trim() && <MarkdownText text={`Run: ${objective.trim()}`} className="text-sm text-ink mt-2 line-clamp-4" />}
			</div>
		);
	}
	return (
		<div className="mb-3 rounded-lg border border-line bg-panel/70 p-3" data-testid="question-issue-context">
			<div className="text-xs font-bold uppercase tracking-wide text-muted-soft mb-1">Question about this issue</div>
			<a href={issue.url} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline break-words" title="Read the full issue and comments on GitHub">
				{issue.repo}#{issue.number}: {issue.title} ↗
			</a>
			{issue.stale && issue.staleReason && (
				<div role="alert" className="mt-2 rounded-md border border-warning-line bg-warning-soft px-2.5 py-1.5 text-xs" data-testid="question-issue-stale" data-stale-reason={issue.staleReason}>
					<span className="font-semibold">Needs refresh.</span> {issue.staleDetail ? `${issue.staleDetail.charAt(0).toUpperCase()}${issue.staleDetail.slice(1)}.` : STALE_COPY[issue.staleReason]} Open the issue and check this question still applies before you answer. The question below is unchanged.
				</div>
			)}
			{issue.summary && <MarkdownText text={issue.summary} className="text-sm text-muted mt-1 line-clamp-3" />}
			<p className="text-xs text-muted-soft mt-1">Open the issue to read its requirements and discussion before answering.</p>
		</div>
	);
}
