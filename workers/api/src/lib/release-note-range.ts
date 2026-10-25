/**
 * Turn the runner-recorded `base...head` push into the context a release note is rendered from (#1349).
 *
 * The queue tick calls this for a gated row that still carries `pendingRange`. It verifies the push went to the
 * repository's default branch, pages the whole compare (lib/github-evidence.ts), and derives:
 *   • the closing-issue references from the COMPLETE verified range (up to {@link COMPARE_COMMITS_MAX} commits);
 *   • the rendered subjects: the newest {@link SUMMARY_COMMITS_MAX}, plus an explicit omitted count.
 * The verification bound and the summary bound are different numbers on purpose.
 */
import { collectCommitRange, type CommitRange, type Evidence, type PageFetcher, shortSha } from "./github-evidence.js";
import type { MergeEvidence } from "./merge-evidence.js";
import { closedIssueNumbers, type ReleaseNoteContext } from "./release-notes.js";

/** Subjects stored for the note. The note itself shows fewer; the rest are counted, not dropped silently. */
export const SUMMARY_COMMITS_MAX = 50;
/** Issue titles looked up for the closing references. A reference past this still counts, without a title. */
export const ISSUE_TITLES_MAX = 25;

const sha40 = /^[0-9a-f]{40}$/;

/**
 * Re-prove each synchronous PR merge the runner reported, from GitHub with the owner's own credential (#1350). The
 * runner's claim is only what to check: every field below is read again, and `verified` is true only if all of it agrees.
 *
 *   • the pull request is merged, into this repository's pushed default branch, with the merge commit the runner named
 *   • it was merged by the account that ran the command
 *   • the merge result has the shape its method produces, and its first parent is the claimed prior branch tip:
 *       merge   two parents: the prior tip, then the PR head
 *       squash  one commit whose parent is the prior tip
 *       rebase  exactly the PR's commits, linear, on top of the prior tip (any other mapping is ambiguous: held)
 *   • the merge commit lies inside the range just verified from GitHub, so the note describes what this merge delivered
 */
export async function verifyMerges(fetchPage: PageFetcher, repo: string, branch: string, merges: readonly MergeEvidence[], range: CommitRange): Promise<Evidence<true>> {
	const bad = (message: string): Evidence<never> => ({ ok: false, kind: "permanent", code: "pr_merge_unverified", message });
	const transient = (what: string, r: { message: string }): Evidence<never> => ({ ok: false, kind: "transient", message: `${what}: ${r.message}; will retry` });
	const inRange = new Map(range.commits.map((c, i) => [c.sha, i]));
	for (const m of merges) {
		const label = `Pull request #${m.pr}`;
		if (m.repo.toLowerCase() !== repo.toLowerCase() || m.baseRef !== branch) return bad(`${label} was reported for ${m.repo}:${m.baseRef}, not ${repo}:${branch}`);
		const pr = await fetchPage(`/repos/${repo}/pulls/${m.pr}`);
		if (!pr.ok) return pr.kind === "transient" ? transient(`${label} could not be read`, pr) : bad(`${label} could not be read from GitHub (${pr.message})`);
		const p = pr.body as { merged?: unknown; merged_at?: unknown; merge_commit_sha?: unknown; merged_by?: { login?: unknown }; base?: { ref?: unknown; repo?: { full_name?: unknown } }; head?: { sha?: unknown }; commits?: unknown } | null;
		if (p?.merged !== true || typeof p.merged_at !== "string") return bad(`${label} is not merged according to GitHub`);
		if (p.base?.ref !== branch || String(p.base?.repo?.full_name ?? "").toLowerCase() !== repo.toLowerCase()) return bad(`${label} did not merge into ${repo}:${branch}`);
		if (String(p.merge_commit_sha ?? "").toLowerCase() !== m.afterSha) return bad(`${label}'s merge commit on GitHub is not the one the runner reported`);
		if (typeof p.merged_by?.login !== "string" || p.merged_by.login.toLowerCase() !== m.mergedBy.toLowerCase() || m.mergedBy.toLowerCase() !== m.actor.toLowerCase()) return bad(`${label} was not merged by the account that ran the command`);
		const commit = await fetchPage(`/repos/${repo}/commits/${m.afterSha}`);
		if (!commit.ok) return commit.kind === "transient" ? transient(`${label}'s merge commit could not be read`, commit) : bad(`${label}'s merge commit could not be read (${commit.message})`);
		const c = commit.body as { sha?: unknown; parents?: Array<{ sha?: unknown }> } | null;
		const parents = (Array.isArray(c?.parents) ? c.parents : []).map((x) => String(x?.sha ?? "").toLowerCase());
		if (!c || String(c.sha ?? "").toLowerCase() !== m.afterSha || !parents.length || parents.some((x) => !sha40.test(x))) return bad(`${label}'s merge commit has no readable parents`);
		// A merge commit or a squash is made directly on the prior tip. A rebase's last commit sits on the previous rebased one;
		// its prior tip is checked below, at the foot of the chain of the PR's own commits.
		if (m.method !== "rebase" && parents[0] !== m.beforeSha) return bad(`${label}'s merge commit was made on ${shortSha(parents[0])}, not the ${shortSha(m.beforeSha)} the runner reported`);
		const at = inRange.get(m.afterSha);
		if (at === undefined) return bad(`${label}'s merge commit is not inside the verified delivered range`);
		if (m.method === "merge") {
			if (parents.length !== 2 || parents[1] !== String(p.head?.sha ?? "").toLowerCase()) return bad(`${label} is not a merge commit of the pull request's head`);
		} else if (parents.length !== 1) {
			return bad(`${label}'s ${m.method} result has ${parents.length} parents`);
		} else if (m.method === "rebase") {
			const count = p.commits;
			if (!Number.isSafeInteger(count) || (count as number) < 1 || at + 1 < (count as number)) return bad(`${label}'s rebase cannot be mapped to its ${String(count)} commit(s)`);
			// The last `count` commits of the range must be this PR's, one after another, starting on the prior tip.
			const mine = range.commits.slice(at + 1 - (count as number), at + 1);
			const linear = mine.every((x, i) => x.parents.length === 1 && x.parents[0] === (i === 0 ? m.beforeSha : mine[i - 1].sha));
			if (!linear) return bad(`${label}'s rebase is ambiguous: its ${count} commit(s) do not form one line on ${shortSha(m.beforeSha)}`);
		}
	}
	return { ok: true, value: true };
}

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
	if (pending.merges?.length) {
		const verified = await verifyMerges(fetchPage, ctx.repo, pending.branch, pending.merges, range.value);
		if (!verified.ok) return verified;
	}
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
