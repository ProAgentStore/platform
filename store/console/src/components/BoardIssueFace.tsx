import { issueLabel } from "../lib/boardLanes";

/** The issue fields a board card carries (#895) — `githubIssue`, `issueRun`, `closingCommit` from `GET /board`. */
export interface BoardIssueFields {
	githubIssue?: { number: number; title: string; state: string; labels: string[]; url: string; repo?: string; assignees?: string[]; summary?: string };
	issueRun?: { runId: string; sessionId: string | null; status: string; waitingReason: string | null };
	closingCommit?: { sha: string; url: string };
}

/**
 * What a card that IS (or works on) a GitHub issue says about it (#895): the issue by meaning — repo,
 * number and title — its state, labels and assignees, what it asks, a link out to GitHub, the run on it
 * and the commit that closed it. Rendered beside the card's open button, never inside it: a link may
 * not sit in a button.
 */
export default function BoardIssueFace({ item, onOpenSession }: { item: BoardIssueFields; onOpenSession: (sessionId: string) => void }) {
	const issue = item.githubIssue;
	if (!issue) return null;
	const run = item.issueRun;
	return (
		<div className="text-2xs mt-1.5 flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-1.5">
				<a href={issue.url} target="_blank" rel="noreferrer" className="font-bold text-accent hover:underline break-words" title="Open the issue on GitHub">
					{issueLabel(issue)}
				</a>
				<span className={`px-1 rounded border ${issue.state === "closed" ? "border-success-line text-success" : "border-line text-muted"}`}>{issue.state}</span>
				{issue.labels.map((l) => (
					<span key={l} className="px-1 rounded bg-panel border border-line text-muted">
						{l}
					</span>
				))}
				{issue.assignees?.length ? <span className="text-muted-soft">@{issue.assignees.join(", @")}</span> : null}
			</div>
			{issue.summary && <p className="text-muted line-clamp-2 break-words">{issue.summary}</p>}
			<div className="flex flex-wrap items-center gap-2">
				{run?.sessionId && (
					<button type="button" onClick={() => onOpenSession(run.sessionId as string)} className="text-accent hover:underline" title="Open the coding session working on this issue">
						Run: {run.waitingReason ? `waiting (${run.waitingReason})` : run.status} →
					</button>
				)}
				{item.closingCommit && (
					<a href={item.closingCommit.url} target="_blank" rel="noreferrer" className="text-success hover:underline" title="The commit that closed this issue">
						closed by {item.closingCommit.sha.slice(0, 7)}
					</a>
				)}
			</div>
		</div>
	);
}
