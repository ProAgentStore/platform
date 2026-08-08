/**
 * Paging back through a conversation, from the console's side (#428).
 *
 * "Load older messages" prepended whatever the server returned, with no dedup, and decided whether
 * there was more from `older.length >= PAGE`. Both were guesses, and both were wrong in the same
 * failure: the server was returning the NEWEST page every time, so the thread grew a second copy of
 * its own tail at the TOP, the length guess stayed true forever, and the button never went away.
 *
 * The server now hands back an opaque `nextCursor` and a measured `hasMore`, so the client stops
 * needing to know the storage key format — the drift that made the original cursor a UUID cannot
 * recur. What is left here is the part the client still owns:
 *
 *   • echo the cursor back rather than minting one from a field it picked;
 *   • dedup on prepend, so a server that ever repeats itself again shows up as "nothing happened"
 *     instead of silently corrupting the order and colliding React keys;
 *   • treat the absence of `hasMore` as the one legacy case, not as the normal path.
 */

/** The shape `GET /v1/instances/:id/messages` returns. `nextCursor`/`hasMore` are new (#428). */
export interface MessagePageResponse<T> {
	messages?: T[];
	nextCursor?: string | null;
	hasMore?: boolean;
}

/** Enough of a message to be identified. Optimistic local rows have no id yet. */
interface Identifiable {
	id?: string;
	createdAt?: string;
	role?: string;
	content?: string;
}

/**
 * Identity for dedup. `id` when the server gave one; otherwise the tuple that actually
 * distinguishes a row, because an optimistic user message has no id until the reply lands and must
 * not be treated as equal to every other id-less row in the thread.
 */
function identity(m: Identifiable): string {
	return m.id ? `id:${m.id}` : `n:${m.createdAt ?? ""}|${m.role ?? ""}|${m.content ?? ""}`;
}

/**
 * Prepend an older page, dropping anything the thread already holds.
 *
 * Order is preserved and the CURRENT copy wins: a message already on screen may carry local state
 * the fetched copy does not (a gloss, an optimistic field), so re-fetching it must not replace it.
 */
export function mergeOlderMessages<T extends Identifiable>(older: T[], current: T[]): T[] {
	if (older.length === 0) return current;
	const held = new Set(current.map(identity));
	const fresh = older.filter((m) => !held.has(identity(m)));
	if (fresh.length === 0) return current;
	return [...fresh, ...current];
}

/**
 * Is there another page behind this one?
 *
 * The server's answer when it gives one — it is the only side that can see past the page it just
 * returned. The `>= requested` fallback exists solely for an API deployed before #428 (a browser
 * tab open across the rollout); it is the guess this ticket is about, kept narrow and named.
 */
export function resolveHasMore<T>(page: MessagePageResponse<T>, requested: number): boolean {
	if (typeof page.hasMore === "boolean") return page.hasMore;
	return (page.messages?.length ?? 0) >= requested;
}

/**
 * The cursor to send for the NEXT older page.
 *
 * Null means "the start of the conversation is on screen" — a fact from the server, not an
 * inference. Never derived from a message field here: that derivation is exactly what produced a
 * UUID cursor no server could ever seek with.
 */
export function nextOlderCursor<T>(page: MessagePageResponse<T>): string | null {
	return typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
}
