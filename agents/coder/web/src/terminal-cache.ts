// The Terminal view's local copy of its own scrollback (#550).
//
// The owner's words: "when I'm looking at the terminal it always loads it from the server every
// time I load the page. It should be caching it locally." Measured on production, one real
// session's newest page was 41,767 bytes over 0.156 s — paid on every load and every switch back,
// for rows that are append-only by construction (`coding_timeline`, migration 0023). #432 built
// the scrollback because every snapshot was fetched then discarded; this is the same sentence one
// level up, where every PAGE was fetched then discarded on unmount.
//
// ── Why the seq goes in the VALUE and not in the key
//
// The obvious key is `term:{instance}:{session}:{newestSeq}`, which is self-invalidating because
// an append moves it. But nothing can LOOK IT UP: the newest seq is what the request is for, so a
// reader would have to enumerate the store and pick a key by prefix — reintroducing the staleness
// the key was supposed to remove, one directory listing later. So the key is per (instance,
// session) and the seq rides in the value, where it does the same job better: it is the cursor the
// refetch sends as `after=`, which makes the cache self-correcting rather than merely
// self-invalidating. A cache that is a page BEHIND still paints instantly and then gets exactly
// the rows it is missing.
//
// ── Why sessionStorage
//
// Terminal output is the inside of the owner's private repository — build logs, file paths,
// occasionally a secret echoed by a failing command. It should not outlive the tab.
// `localStorage` would need an eviction policy and a "clear my data" story that does not exist
// here; `sessionStorage` gets that lifetime for free.

/** Bump when the shape below changes — a stored entry from an older build is discarded, not read. */
const VERSION = 1;

/**
 * The ceiling on one cached entry, in characters.
 *
 * A newest page is at most 5 snapshots of ~8,000 chars, and consecutive snapshots overlap almost
 * entirely, so a stitched page is nowhere near this. The ceiling exists for the case where the
 * user has paged BACKWARDS before leaving: `saved` then holds an arbitrarily long scrollback, and
 * caching it would grow without bound.
 */
export const MAX_CACHE_CHARS = 128_000;

export interface TerminalCacheEntry {
	/** The stitched PERSISTED history, exactly as the pane rendered it. Never the live pane. */
	text: string;
	/** The `seq` of the newest row `text` contains — the `after=` cursor for the delta refetch. */
	newestSeq: number | null;
	/** The `before=` cursor for "load older", and whether that control should be shown. */
	oldestSeq: number | null;
	hasOlder: boolean;
}

/** The two `Storage` methods used, plus what pruning needs — so a test can pass a plain object. */
export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
	readonly length: number;
	key(i: number): string | null;
}

const prefix = (instanceId: string) => `coder:term:${instanceId}:`;
const cacheKey = (instanceId: string, sessionId: string) => `${prefix(instanceId)}${sessionId}`;

/**
 * `sessionStorage`, or null where it cannot be touched.
 *
 * Safari in private mode and a storage-disabled profile both throw on ACCESS, not just on write,
 * so the getter itself is guarded.
 */
export function sessionStore(): StorageLike | null {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		/* Storage disabled (Safari private mode, blocked cookies) — the caller falls back to the
		   network path, which is what it did before this cache existed. Nothing is lost but speed. */
		return null;
	}
}

/** The cached page for this session, or null if there is none, it is unreadable, or it is stale-shaped. */
export function readTerminalCache(instanceId: string, sessionId: string, store: StorageLike | null = sessionStore()): TerminalCacheEntry | null {
	if (!store) return null;
	let raw: string | null = null;
	try {
		raw = store.getItem(cacheKey(instanceId, sessionId));
	} catch {
		/* A read that throws is a store that is unusable, not a cache miss worth reporting. */
		return null;
	}
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as { v?: number; text?: unknown; newestSeq?: unknown; oldestSeq?: unknown; hasOlder?: unknown };
		// A shape check, not a version check alone: this is parsed from a store the user's other
		// tabs and older builds can write, and a half-valid entry would paint garbage as history.
		if (v.v !== VERSION || typeof v.text !== "string" || !v.text) return null;
		return {
			text: v.text,
			newestSeq: typeof v.newestSeq === "number" ? v.newestSeq : null,
			oldestSeq: typeof v.oldestSeq === "number" ? v.oldestSeq : null,
			hasOlder: v.hasOlder === true,
		};
	} catch {
		/* Corrupt JSON — treat exactly as a miss. */
		return null;
	}
}

/**
 * Store this session's page, and drop any OTHER session's page for the same instance.
 *
 * One session per instance is the bound (#550): the terminal shows one session at a time, and
 * keeping every session a user has ever opened is how a 5 MB quota gets spent on output nobody
 * will look at again.
 *
 * Returns whether anything was stored, which is what the test asserts against — an over-size entry
 * is DROPPED rather than trimmed. Trimming the head would leave `oldestSeq` pointing past a hole in
 * the middle of the text, and "load older" would then prepend a page that does not join what is on
 * screen: a silent duplication or a silent skip, which is worse than refetching.
 */
export function writeTerminalCache(
	instanceId: string,
	sessionId: string,
	entry: TerminalCacheEntry,
	store: StorageLike | null = sessionStore(),
): boolean {
	if (!store) return false;
	const key = cacheKey(instanceId, sessionId);
	if (!entry.text || entry.text.length > MAX_CACHE_CHARS) {
		try {
			store.removeItem(key);
		} catch {
			/* Nothing to do about a store that will not delete; the read side validates anyway. */
		}
		return false;
	}
	pruneOtherSessions(instanceId, sessionId, store);
	try {
		store.setItem(key, JSON.stringify({ v: VERSION, ...entry }));
		return true;
	} catch {
		/* Quota exceeded, or a store that refuses writes. Caching is an optimisation: the next load
		   simply fetches the page as it always did. Reporting this would put a scary line in the
		   console for a condition the user cannot act on and does not perceive. */
		return false;
	}
}

// No `clear` counterpart on purpose: the only history-clearing control in this tab is "Clear
// co-pilot chat history", and `clearChat` (lib/coding-timeline.ts:86) deletes `chat_user`,
// `chat_assistant` and `command` rows — never a `terminal` one. Nothing in the product deletes
// what this caches except the per-session prune, which only ever removes rows OLDER than the page
// stored here.

function pruneOtherSessions(instanceId: string, keepSessionId: string, store: StorageLike): void {
	try {
		const keep = cacheKey(instanceId, keepSessionId);
		const doomed: string[] = [];
		for (let i = 0; i < store.length; i++) {
			const k = store.key(i);
			if (k && k !== keep && k.startsWith(prefix(instanceId))) doomed.push(k);
		}
		// Collected first: removing during the walk shifts the indices under it.
		for (const k of doomed) store.removeItem(k);
	} catch {
		/* Enumeration is best-effort — failing it must not stop the write that follows. */
	}
}
