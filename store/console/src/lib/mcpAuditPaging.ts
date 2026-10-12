/**
 * The owner's MCP activity pager (#1016) — `GET /v1/mcp-audit` pages newest first and hands back an
 * opaque `nextCursor`; `null` is the end of the 90-day ledger. Pure so the paging rule is testable.
 */
export interface McpAuditCoverage {
	complete: boolean;
	detail: string;
}

export interface McpAuditPageView<E> {
	events: E[];
	nextCursor: string | null;
	coverage?: McpAuditCoverage;
}

/** The first page REPLACES the list; a page fetched with a cursor is older history and is appended. */
export function appendMcpAuditPage<E>(prev: readonly E[] | null, page: McpAuditPageView<E>, usedCursor: string | null | undefined): { events: E[]; nextCursor: string | null } {
	return { events: usedCursor ? [...(prev ?? []), ...page.events] : [...page.events], nextCursor: page.nextCursor || null };
}

/** What to tell the owner about coverage: nothing when every retained event is indexed, else the server's own sentence. */
export function mcpAuditCoverageNote(coverage: McpAuditCoverage | undefined): string | null {
	if (!coverage || coverage.complete) return null;
	return coverage.detail || "Older history is still being indexed, so earlier events may be missing.";
}
