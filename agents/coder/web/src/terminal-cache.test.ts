import { describe, expect, it } from "vitest";
import { MAX_CACHE_CHARS, readTerminalCache, type StorageLike, type TerminalCacheEntry, writeTerminalCache } from "./terminal-cache";

/** A `sessionStorage` that can be told to fail, the way a private-mode Safari or a full quota does. */
function fakeStore(opts: { failWrite?: boolean; failRead?: boolean } = {}): StorageLike & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		get length() {
			return map.size;
		},
		key: (i: number) => [...map.keys()][i] ?? null,
		getItem(k) {
			if (opts.failRead) throw new DOMException("read blocked", "SecurityError");
			return map.get(k) ?? null;
		},
		setItem(k, v) {
			if (opts.failWrite) throw new DOMException("quota", "QuotaExceededError");
			map.set(k, v);
		},
		removeItem: (k) => void map.delete(k),
	};
}

const entry = (over: Partial<TerminalCacheEntry> = {}): TerminalCacheEntry => ({
	text: "$ npm test\nPASS\n",
	newestSeq: 20,
	oldestSeq: 10,
	hasOlder: true,
	...over,
});

describe("terminal cache — the page survives a reload, and knows where it stops (#550)", () => {
	it("round-trips the text AND both cursors, because text alone breaks 'load older'", () => {
		// `hasMore`/`oldestSeq` cached apart from the text is the regression the ticket names: the
		// next "load older" would start from the wrong cursor and silently duplicate or skip a page.
		const store = fakeStore();
		expect(writeTerminalCache("inst-1", "sess-1", entry(), store)).toBe(true);
		expect(readTerminalCache("inst-1", "sess-1", store)).toEqual(entry());
	});

	it("is per (instance, session) — another session's output can never be painted under this header", () => {
		const store = fakeStore();
		writeTerminalCache("inst-1", "sess-1", entry({ text: "repo A output" }), store);
		expect(readTerminalCache("inst-1", "sess-2", store)).toBeNull();
		expect(readTerminalCache("inst-2", "sess-1", store)).toBeNull();
	});

	it("keeps ONE session per instance, so a day of opening sessions cannot fill the quota", () => {
		const store = fakeStore();
		writeTerminalCache("inst-1", "sess-1", entry(), store);
		writeTerminalCache("inst-1", "sess-2", entry(), store);
		expect(readTerminalCache("inst-1", "sess-1", store)).toBeNull();
		expect(readTerminalCache("inst-1", "sess-2", store)).not.toBeNull();
		// A DIFFERENT instance is a different terminal and is left alone.
		writeTerminalCache("inst-2", "sess-9", entry(), store);
		expect(readTerminalCache("inst-1", "sess-2", store)).not.toBeNull();
	});

	it("advances `newestSeq` when a row is appended — this is what makes the cache self-correcting", () => {
		// The key does not move (nothing could look it up if it did); the CURSOR inside it moves,
		// and it is what the next load sends as `after=`. Pin that, or a cached page is served
		// forever and the delta is asked for from the wrong place.
		const store = fakeStore();
		writeTerminalCache("inst-1", "sess-1", entry({ newestSeq: 20 }), store);
		writeTerminalCache("inst-1", "sess-1", entry({ text: "$ npm test\nPASS\nmore\n", newestSeq: 30 }), store);
		const got = readTerminalCache("inst-1", "sess-1", store);
		expect(got?.newestSeq).toBe(30);
		expect(got?.text).toContain("more");
	});

	it("drops an over-size entry instead of trimming it, and leaves nothing behind", () => {
		// Trimming the head would leave `oldestSeq` pointing past a hole in the middle of the text.
		const store = fakeStore();
		writeTerminalCache("inst-1", "sess-1", entry(), store);
		expect(writeTerminalCache("inst-1", "sess-1", entry({ text: "x".repeat(MAX_CACHE_CHARS + 1) }), store)).toBe(false);
		expect(readTerminalCache("inst-1", "sess-1", store)).toBeNull();
	});

	it("degrades silently when storage throws, in both directions", () => {
		// Safari private mode and a full quota. The fallback is exactly the pre-cache behaviour:
		// fetch the page. Nothing user-visible, because there is nothing the user can do.
		expect(writeTerminalCache("inst-1", "sess-1", entry(), fakeStore({ failWrite: true }))).toBe(false);
		expect(readTerminalCache("inst-1", "sess-1", fakeStore({ failRead: true }))).toBeNull();
		expect(writeTerminalCache("inst-1", "sess-1", entry(), null)).toBe(false);
		expect(readTerminalCache("inst-1", "sess-1", null)).toBeNull();
	});

	it("refuses an entry written by another build, rather than painting its shape as history", () => {
		const store = fakeStore();
		store.setItem("coder:term:inst-1:sess-1", JSON.stringify({ v: 99, text: "from the future" }));
		expect(readTerminalCache("inst-1", "sess-1", store)).toBeNull();
		store.setItem("coder:term:inst-1:sess-1", "{not json");
		expect(readTerminalCache("inst-1", "sess-1", store)).toBeNull();
		store.setItem("coder:term:inst-1:sess-1", JSON.stringify({ v: 1, text: 42 }));
		expect(readTerminalCache("inst-1", "sess-1", store)).toBeNull();
	});

	it("stores nothing for a session with no output — an empty cache hit is not a history", () => {
		const store = fakeStore();
		expect(writeTerminalCache("inst-1", "sess-1", entry({ text: "" }), store)).toBe(false);
		expect(store.map.size).toBe(0);
	});
});
