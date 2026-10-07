/**
 * Instance tags (#961) — a short owner-chosen list per instance ("store-coders", "pas-apps") so a
 * fleet can be asked about as a group. Stored at `agent_instances.config.tags`; no column, because a
 * tag is a label the owner writes and the platform only ever filters on.
 *
 * Matching is case-insensitive and tags are stored as written (first spelling wins), so "PAS-apps"
 * and "pas-apps" are one tag and the owner's own capitalisation is what they read back.
 */

export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;
const TAG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]*$/;

/** The tags to store, or a refusal naming the first value that cannot be one — never a silent drop. */
export function normalizeTags(input: unknown): { tags: string[] } | { error: string } {
	if (!Array.isArray(input)) return { error: "`tags` must be a list of strings, e.g. [\"store-coders\"]. Send [] to clear them." };
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		if (typeof raw !== "string") return { error: "Every tag must be a string." };
		const tag = raw.trim();
		if (!tag) continue;
		if (tag.length > MAX_TAG_CHARS) return { error: `A tag is ${tag.length} characters; the limit is ${MAX_TAG_CHARS}.` };
		if (!TAG_SHAPE.test(tag)) return { error: `Tag "${tag}" may use letters, digits, spaces and . _ : - only, starting with a letter or digit.` };
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		tags.push(tag);
	}
	if (tags.length > MAX_TAGS) return { error: `${tags.length} tags; an instance may carry at most ${MAX_TAGS}.` };
	return { tags };
}

/** The tags stored on an instance config blob — anything malformed reads as none. */
export function tagsOf(config: Record<string, unknown>): string[] {
	return Array.isArray(config.tags) ? config.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
}

/** Does an instance carry ANY of the wanted tags? No wanted tags matches every instance. */
export function matchesTags(tags: readonly string[], wanted: readonly string[]): boolean {
	if (!wanted.length) return true;
	const have = new Set(tags.map((t) => t.toLowerCase()));
	return wanted.some((w) => have.has(w.trim().toLowerCase()));
}

/** `?tag=a&tag=b` and `?tags=a,b` both, as one list. */
export function wantedTags(query: { tag?: string[]; tags?: string }): string[] {
	return [...(query.tag ?? []), ...(query.tags ?? "").split(",")].map((t) => t.trim()).filter(Boolean);
}
