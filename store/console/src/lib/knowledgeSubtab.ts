/**
 * URL state for Knowledge's second-level navigation.
 *
 * InstanceDetail owns the top-level tab in its path.  Knowledge owns this smaller
 * choice in a query parameter so a link can name Files without adding a third
 * splat segment (which InstanceDetail intentionally does not parse).
 */
export const KNOWLEDGE_SUBTABS = ["docs", "memory", "tasks", "files", "index", "credentials", "rules"] as const;

export type KnowledgeSubtab = (typeof KNOWLEDGE_SUBTABS)[number];

export function knowledgeSubtabFromSearch(search: URLSearchParams): KnowledgeSubtab | null {
	const value = search.get("subtab");
	return (KNOWLEDGE_SUBTABS as readonly string[]).includes(value ?? "")
		? (value as KnowledgeSubtab)
		: null;
}

/** Keep unrelated query state while changing only Knowledge's selected panel. */
export function searchWithKnowledgeSubtab(search: URLSearchParams, subtab: KnowledgeSubtab): URLSearchParams {
	const next = new URLSearchParams(search);
	next.set("subtab", subtab);
	return next;
}
