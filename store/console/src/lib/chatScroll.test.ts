import { describe, expect, it } from "vitest";
import { BOTTOM_EPSILON_PX, isPinnedToBottom, shouldScrollAfterLoad } from "./chatScroll";

const geom = (scrollTop: number, scrollHeight = 2000, clientHeight = 600) => ({ scrollHeight, scrollTop, clientHeight });

describe("isPinnedToBottom", () => {
	it("is true at the exact bottom and just short of it", () => {
		expect(isPinnedToBottom(geom(1400))).toBe(true);
		expect(isPinnedToBottom(geom(1400 - (BOTTOM_EPSILON_PX - 1)))).toBe(true);
	});

	it("is false once the reader is a line or more up", () => {
		expect(isPinnedToBottom(geom(1400 - BOTTOM_EPSILON_PX))).toBe(false);
		expect(isPinnedToBottom(geom(200))).toBe(false);
	});

	it("is true for a thread shorter than its viewport — there is nowhere to scroll", () => {
		expect(isPinnedToBottom(geom(0, 300, 600))).toBe(true);
	});
});

describe("shouldScrollAfterLoad", () => {
	// #335: the loop watcher refreshes the transcript every 3s. Scrolled up, that must not move.
	it("does NOT move a refresh under a reader who has scrolled up", () => {
		expect(shouldScrollAfterLoad({ initial: false, pinned: false })).toBe(false);
	});

	it("keeps following on a refresh while the reader is at the bottom", () => {
		expect(shouldScrollAfterLoad({ initial: false, pinned: true })).toBe(true);
	});

	// Opening a conversation must land on the newest message even when the PREVIOUS conversation
	// was left scrolled up — the page is reused across instances, so `pinned` is stale here.
	it("always lands on the newest message when a conversation is opened", () => {
		expect(shouldScrollAfterLoad({ initial: true, pinned: false })).toBe(true);
		expect(shouldScrollAfterLoad({ initial: true, pinned: true })).toBe(true);
	});
});
