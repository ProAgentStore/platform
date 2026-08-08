import { describe, expect, it } from "vitest";
import { mergeOlderMessages, nextOlderCursor, resolveHasMore } from "./messagePaging.js";

const msg = (id: string, content = id) => ({ id, role: "user", content, createdAt: `2026-08-08T06:00:${id.slice(-2)}.000Z` });

describe("mergeOlderMessages — a repeated page shows as nothing, never as duplicates (#428)", () => {
	it("prepends genuinely older messages, in order", () => {
		const current = [msg("m10"), msg("m11")];
		expect(mergeOlderMessages([msg("m08"), msg("m09")], current).map((m) => m.id)).toEqual([
			"m08",
			"m09",
			"m10",
			"m11",
		]);
	});

	it("drops ids the thread already holds — the whole failure was the newest page coming back", () => {
		const current = [msg("m10"), msg("m11")];
		// Exactly what the broken server returned: page 2 identical to page 1.
		expect(mergeOlderMessages([msg("m10"), msg("m11")], current)).toBe(current);
	});

	it("keeps the copy already on screen, which may carry local state the refetch does not", () => {
		const onScreen = { ...msg("m10"), content: "glossed locally" };
		const merged = mergeOlderMessages([msg("m09"), msg("m10")], [onScreen]);
		expect(merged.map((m) => m.id)).toEqual(["m09", "m10"]);
		expect(merged[1].content).toBe("glossed locally");
	});

	it("partially-overlapping pages keep only what is new", () => {
		const current = [msg("m10"), msg("m11")];
		expect(mergeOlderMessages([msg("m09"), msg("m10")], current).map((m) => m.id)).toEqual(["m09", "m10", "m11"]);
	});

	it("an id-less optimistic row is not equal to every other id-less row", () => {
		const a = { role: "user", content: "first", createdAt: "2026-08-08T06:00:00.000Z" };
		const b = { role: "user", content: "second", createdAt: "2026-08-08T06:00:01.000Z" };
		expect(mergeOlderMessages([a], [b])).toHaveLength(2);
		expect(mergeOlderMessages([a], [a, b])).toHaveLength(2);
	});

	it("an empty older page leaves the thread untouched", () => {
		const current = [msg("m10")];
		expect(mergeOlderMessages([], current)).toBe(current);
	});
});

describe("resolveHasMore — the server's measurement, not the page-length guess (#428)", () => {
	it("takes the server's answer even when the page is exactly full", () => {
		expect(resolveHasMore({ messages: new Array(20).fill(msg("m")), hasMore: false }, 20)).toBe(false);
	});

	it("takes the server's answer even when the page is short", () => {
		expect(resolveHasMore({ messages: [msg("m01")], hasMore: true }, 20)).toBe(true);
	});

	it("falls back to the length guess only when the field is absent (an API from before #428)", () => {
		expect(resolveHasMore({ messages: new Array(20).fill(msg("m")) }, 20)).toBe(true);
		expect(resolveHasMore({ messages: [msg("m01")] }, 20)).toBe(false);
		expect(resolveHasMore({}, 20)).toBe(false);
	});
});

describe("nextOlderCursor — null is 'the conversation starts here', a fact from the server (#428)", () => {
	it("returns the cursor the server emitted", () => {
		expect(nextOlderCursor({ nextCursor: "msg:2026-08-08T06:00:00.000Z:abc" })).toBe("msg:2026-08-08T06:00:00.000Z:abc");
	});

	it("null, undefined and empty all mean stop", () => {
		expect(nextOlderCursor({ nextCursor: null })).toBeNull();
		expect(nextOlderCursor({ nextCursor: "" })).toBeNull();
		expect(nextOlderCursor({})).toBeNull();
	});
});
