import type { IssueSummary, IssuesPage } from "./github-issues.js";

/** Bound GitHub work per repo/wake, including pages occupied entirely by pull requests. */
export const AUTO_PICKUP_MAX_ISSUE_PAGES = 5;

export interface AutoPickupIssueScan {
	issues: IssueSummary[];
	unreadable: boolean;
	incomplete?: boolean;
}

export async function scanAutoPickupIssues(readPage: (page: number) => Promise<IssuesPage>): Promise<AutoPickupIssueScan> {
	const issues = new Map<number, IssueSummary>();
	let read = false;
	for (let page = 1; page <= AUTO_PICKUP_MAX_ISSUE_PAGES; page++) {
		let result: IssuesPage;
		try {
			result = await readPage(page);
		} catch {
			return { issues: [...issues.values()], unreadable: !read, incomplete: true };
		}
		if (result.unreadable) return { issues: [...issues.values()], unreadable: !read, incomplete: true };
		read = true;
		// ListIssuesPage already excludes PRs; its hasMore uses the RAW GitHub page length.
		for (const issue of result.issues) issues.set(issue.number, issue);
		if (!result.hasMore) return { issues: [...issues.values()], unreadable: false, incomplete: false };
	}
	return { issues: [...issues.values()], unreadable: false, incomplete: true };
}
