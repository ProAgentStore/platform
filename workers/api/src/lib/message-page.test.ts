import { describe, expect, it } from "vitest";
import {
	assembleMessagePage,
	MESSAGE_KEY_PREFIX,
	messageListOptions,
	messageStorageKey,
	resolveCursor,
} from "./message-page.js";

/** A stored transcript, oldest first, one message a second. */
function transcript(n: number): Array<[string, { id: string; createdAt: string }]> {
	const rows: Array<[string, { id: string; createdAt: string }]> = [];
	for (let i = 0; i < n; i++) {
		const msg = { id: `m${String(i).padStart(3, "0")}`, createdAt: `2026-08-08T06:${String(i).padStart(2, "0")}:00.000Z` };
		rows.push([messageStorageKey(msg), msg]);
	}
	return rows;
}

/** What `ctx.storage.list()` would return for these options over that transcript. */
function fakeList(
	all: Array<[string, { id: string; createdAt: string }]>,
	opts: { start?: string; end?: string; prefix?: string; reverse: true; limit: number },
): Array<[string, { id: string; createdAt: string }]> {
	const inRange = all.filter(([key]) => {
		if (opts.prefix !== undefined && !key.startsWith(opts.prefix)) return false;
		if (opts.start !== undefined && key < opts.start) return false;
		// `end` is EXCLUSIVE — the whole point of the cursor.
		if (opts.end !== undefined && key >= opts.end) return false;
		return true;
	});
	return [...inRange].reverse().slice(0, opts.limit);
}

describe("messageStorageKey — the key format lives in one place (#428)", () => {
	it("orders by createdAt, and disambiguates a shared millisecond by id", () => {
		const a = messageStorageKey({ createdAt: "2026-08-08T06:00:00.000Z", id: "aaa" });
		const b = messageStorageKey({ createdAt: "2026-08-08T06:00:00.000Z", id: "bbb" });
		const later = messageStorageKey({ createdAt: "2026-08-08T06:00:00.001Z", id: "aaa" });
		expect(a < b).toBe(true);
		expect(b < later).toBe(true);
		expect(a.startsWith(MESSAGE_KEY_PREFIX)).toBe(true);
	});
});

describe("resolveCursor — a cursor that names no position is refused, not guessed at (#428)", () => {
	it("no cursor means the newest page", () => {
		expect(resolveCursor(undefined).kind).toBe("none");
		expect(resolveCursor(null).kind).toBe("none");
		expect(resolveCursor("").kind).toBe("none");
		expect(resolveCursor("   ").kind).toBe("none");
	});

	it("takes back the opaque cursor it emitted", () => {
		const key = messageStorageKey({ createdAt: "2026-08-08T06:00:00.000Z", id: "abc" });
		expect(resolveCursor(key)).toEqual({ kind: "end", end: key });
	});

	it("accepts a bare ISO createdAt, bounding BELOW every message written in that millisecond", () => {
		const r = resolveCursor("2026-08-08T06:00:00.000Z");
		expect(r).toEqual({ kind: "end", end: "msg:2026-08-08T06:00:00.000Z" });
		if (r.kind !== "end") throw new Error("unreachable");
		// Strictly below the key of a message stamped at exactly that instant, so that message is
		// excluded by the exclusive `end` rather than returned a second time.
		expect(r.end < messageStorageKey({ createdAt: "2026-08-08T06:00:00.000Z", id: "zzz" })).toBe(true);
	});

	it("REFUSES a message id — the defect that made the feature unfixable from the server alone", () => {
		const r = resolveCursor("ffb4c8f8-4247-4da1-8f5f-d20c20e4acda");
		expect(r.kind).toBe("invalid");
		if (r.kind !== "invalid") throw new Error("unreachable");
		// The message has to name the fix; "invalid cursor" would send someone back to the client.
		expect(r.reason).toContain("nextCursor");
		expect(r.reason.toLowerCase()).toContain("ordering");
	});
});

describe("assembleMessagePage — hasMore is measured, not inferred (#428)", () => {
	it("a full page with more behind it reports hasMore and a cursor", () => {
		// 11 rows for a limit of 10: the 11th is the probe and must never be returned.
		const newestFirst = [...transcript(11)].reverse();
		const page = assembleMessagePage(newestFirst, 10);
		expect(page.messages).toHaveLength(10);
		expect(page.hasMore).toBe(true);
		expect(page.nextCursor).toBe(newestFirst[9][0]);
	});

	it("a page that reaches the start reports hasMore:false and a NULL cursor", () => {
		const page = assembleMessagePage([...transcript(4)].reverse(), 10);
		expect(page.messages).toHaveLength(4);
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeNull();
	});

	it("an exactly-full page with nothing behind it is not 'more' — the >= PAGE guess was wrong here", () => {
		const page = assembleMessagePage([...transcript(10)].reverse(), 10);
		expect(page.messages).toHaveLength(10);
		expect(page.hasMore).toBe(false);
	});

	it("returns oldest-first, which is the order the transcript renders in", () => {
		const page = assembleMessagePage([...transcript(3)].reverse(), 10);
		expect(page.messages.map((m) => m.id)).toEqual(["m000", "m001", "m002"]);
	});

	it("an empty conversation is a page, not a failure", () => {
		expect(assembleMessagePage([], 10)).toEqual({ messages: [], nextCursor: null, hasMore: false });
	});
});

describe("paging end to end — two pages share no ids, and lose none (#428)", () => {
	const all = transcript(25);

	function page(before: string | null) {
		const cursor = resolveCursor(before);
		if (cursor.kind === "invalid") throw new Error(cursor.reason);
		return assembleMessagePage(fakeList(all, messageListOptions(cursor, 10)), 10);
	}

	it("walks the whole transcript backwards, with no overlap and no gap", () => {
		const p1 = page(null);
		expect(p1.messages.map((m) => m.id)).toEqual(all.slice(15).map(([, m]) => m.id));
		expect(p1.hasMore).toBe(true);

		const p2 = page(p1.nextCursor);
		expect(p2.messages.map((m) => m.id)).toEqual(all.slice(5, 15).map(([, m]) => m.id));
		expect(p2.hasMore).toBe(true);

		const p3 = page(p2.nextCursor);
		expect(p3.messages.map((m) => m.id)).toEqual(all.slice(0, 5).map(([, m]) => m.id));
		// The start of the conversation: the button must disappear rather than loop.
		expect(p3.hasMore).toBe(false);
		expect(p3.nextCursor).toBeNull();

		const seen = [...p1.messages, ...p2.messages, ...p3.messages].map((m) => m.id);
		expect(new Set(seen).size).toBe(25);
		expect(seen).toHaveLength(25);
	});

	it("the cursor message itself is NOT repeated — `end` is exclusive on BOTH boundaries", () => {
		const p1 = page(null);
		const p2 = page(p1.nextCursor);
		const oldestOfPage1 = p1.messages[0].id;
		expect(p2.messages.map((m) => m.id)).not.toContain(oldestOfPage1);
		// …and nothing was skipped either: p2 ends immediately below p1's first row.
		const index = all.findIndex(([, m]) => m.id === oldestOfPage1);
		expect(p2.messages[p2.messages.length - 1].id).toBe(all[index - 1][1].id);
	});

	it("the same page requested twice is stable — the bug was page 2 == page 1", () => {
		const p1 = page(null);
		const again = page(null);
		expect(again.messages.map((m) => m.id)).toEqual(p1.messages.map((m) => m.id));
		const p2 = page(p1.nextCursor);
		expect(p2.messages.map((m) => m.id)).not.toEqual(p1.messages.map((m) => m.id));
	});
});
