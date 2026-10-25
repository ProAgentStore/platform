/**
 * Turn the runner-recorded `base...head` push into the context a release note is rendered from (#1349).
 *
 * The queue tick calls this for a gated row that still carries `pendingRange`. It verifies the push went to the
 * repository's default branch, pages the whole compare (lib/github-evidence.ts), and derives:
 *   • the closing-issue references from the COMPLETE verified range (up to {@link COMPARE_COMMITS_MAX} commits);
 *   • the rendered subjects: the newest {@link SUMMARY_COMMITS_MAX}, plus an explicit omitted count.
 * The verification bound and the summary bound are different numbers on purpose.
 */
import { collectCommitRange, type Evidence, type PageFetcher, shortSha } from "./github-evidence.js";
import { closedIssueNumbers, type ReleaseNoteContext } from "./release-notes.js";

/** Subjects stored for the note. The note itself shows fewer; the rest are counted, not dropped silently. */
export const SUMMARY_COMMITS_MAX = 50;
/** Issue titles looked up for the closing references. A reference past this still counts, without a title. */
export const ISSUE_TITLES_MAX = 25;

export async function resolvePendingRange(fetchPage: PageFetcher, ctx: ReleaseNoteContext): Promise<Evidence<{ sha: string; context: ReleaseNoteContext }>> {
	const pending = ctx.pendingRange;
	if (!pending) return { ok: false, kind: "permanent", code: "commit_range_inconsistent", message: "The release note has no recorded commit range to read" };
	const meta = await fetchPage(`/repos/${ctx.repo}`);
	if (!meta.ok) {
		return meta.kind === "transient"
			? { ok: false, kind: "transient", message: `The repository could not be read: ${meta.message}; will retry` }
			: { ok: false, kind: "permanent", code: "github_refused", message: `The repository could not be read: ${meta.message}` };
	}
	const reported = (meta.body as { default_branch?: unknown } | null)?.default_branch;
	if (typeof reported !== "string" || !reported) return { ok: false, kind: "permanent", code: "default_branch_mismatch", message: "GitHub did not report the repository's default branch, so the push cannot be shown to be on it" };
	if (reported !== pending.branch) return { ok: false, kind: "permanent", code: "default_branch_mismatch", message: `The run pushed to ${pending.branch}, but the default branch is ${reported}; only a push to the default branch is announced` };

	const range = await collectCommitRange(fetchPage, ctx.repo, pending.base, pending.head);
	if (!range.ok) return range;
	const { commits, total } = range.value;
	const head = commits[commits.length - 1].sha;
	const subjects = commits.map((c) => c.message.split("\n")[0].trim()).filter(Boolean).reverse(); // newest first
	const numbers = closedIssueNumbers(commits.map((c) => c.message)); // the whole verified range
	const closedIssues = await Promise.all(
		numbers.map(async (number, index) => {
			if (index >= ISSUE_TITLES_MAX) return { number, title: null };
			const issue = await fetchPage(`/repos/${ctx.repo}/issues/${number}`);
			const title = issue.ok ? (issue.body as { title?: unknown } | null)?.title : null;
			return { number, title: typeof title === "string" ? title : null };
		}),
	);
	const { pendingRange: _resolved, ...rest } = ctx;
	return {
		ok: true,
		value: {
			sha: head,
			context: {
				...rest,
				commitRange: total === 1 ? `${shortSha(head)} (1 commit)` : `${shortSha(commits[0].sha)}…${shortSha(head)} (${total} commits)`,
				changes: subjects.slice(0, SUMMARY_COMMITS_MAX),
				changesCapped: false,
				changesOmitted: Math.max(0, subjects.length - SUMMARY_COMMITS_MAX),
				closedIssues,
				headSha: head,
				ciStatus: "pending",
			},
		},
	};
}
