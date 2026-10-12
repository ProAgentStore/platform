/**
 * The admin MCP audit sweep's pager (#1016). `GET /v1/admin/mcp-audit` pages newest first over the
 * cross-owner time index and hands back an opaque `nextCursor` (`null` = the end of the retained
 * ledger) and the legacy-index `coverage`. Before this the page read one 200-event page and stopped.
 */
export interface McpAuditCoverage {
	complete: boolean;
	detail: string;
}

export interface McpAuditPage<E> {
	events: E[];
	nextCursor: string | null;
	coverage?: McpAuditCoverage;
}

/** The first page (no cursor) REPLACES the list — a new filter starts over; a cursor's page is appended. */
export function appendAuditPage<E>(prev: readonly E[] | null, page: McpAuditPage<E>, usedCursor: string | null | undefined): { events: E[]; nextCursor: string | null } {
	return { events: usedCursor ? [...(prev ?? []), ...page.events] : [...page.events], nextCursor: page.nextCursor || null };
}

/** Null when every retained event is indexed; otherwise the server's own sentence, so a short sweep never reads as complete. */
export function auditCoverageNote(coverage: McpAuditCoverage | undefined): string | null {
	if (!coverage || coverage.complete) return null;
	return coverage.detail || "Older history is still being indexed, so earlier events may be missing.";
}
