import { describe, expect, it } from "vitest";
import {
	INFLIGHT_MAX_MS,
	INFLIGHT_PREFIX,
	inflightKey,
	interruptedNotice,
	partitionTurns,
	previewOf,
	turnLiveness,
	type InflightTurn,
} from "./chat-inflight.js";

const NOW = 1_700_000_000_000;
const turn = (over: Partial<InflightTurn> = {}): InflightTurn => ({
	turnId: "t1",
	startedAt: NOW - 5_000,
	userId: "u1",
	channel: "chat",
	...over,
});

describe("inflightKey", () => {
	it("namespaces markers so concurrent turns cannot clobber each other", () => {
		expect(inflightKey("a")).toBe(`${INFLIGHT_PREFIX}a`);
		expect(inflightKey("a")).not.toBe(inflightKey("b"));
	});
});

describe("turnLiveness", () => {
	it("a turn this instance is running is still running", () => {
		expect(turnLiveness(turn(), { isLive: () => true, now: NOW })).toBe("running");
	});
	it("THE BUG: a marker whose turn this instance is NOT running was interrupted", () => {
		// The object restarted (deploy/eviction) or the work was killed — the marker survives,
		// the promise does not. Without this, the transcript just silently lacks a reply.
		expect(turnLiveness(turn(), { isLive: () => false, now: NOW })).toBe("abandoned");
	});
	it("an ancient marker is abandoned even if something claims it is live", () => {
		expect(turnLiveness(turn({ startedAt: NOW - INFLIGHT_MAX_MS }), { isLive: () => true, now: NOW })).toBe("abandoned");
		expect(turnLiveness(turn({ startedAt: NOW - INFLIGHT_MAX_MS + 1 }), { isLive: () => true, now: NOW })).toBe("running");
	});
	it("a long BYOK turn with many tool rounds is NOT called dead early", () => {
		// Declaring a running turn dead is the worse error: it announces an interruption that
		// never happened, and the real reply then lands after the notice.
		expect(turnLiveness(turn({ startedAt: NOW - 4 * 60_000 }), { isLive: () => true, now: NOW })).toBe("running");
	});
});

describe("partitionTurns", () => {
	it("splits live work from residue, keeping both", () => {
		const live = new Set(["live"]);
		const { running, abandoned } = partitionTurns(
			[turn({ turnId: "live" }), turn({ turnId: "dead" }), turn({ turnId: "old", startedAt: NOW - 60 * 60_000 })],
			{ isLive: (id) => live.has(id), now: NOW },
		);
		expect(running.map((t) => t.turnId)).toEqual(["live"]);
		expect(abandoned.map((t) => t.turnId)).toEqual(["dead", "old"]);
	});
	it("no markers → nothing running, nothing to reap", () => {
		expect(partitionTurns([], { isLive: () => false, now: NOW })).toEqual({ running: [], abandoned: [] });
	});
});

describe("interruptedNotice", () => {
	it("says the actions may have landed — that is the whole failure", () => {
		const notice = interruptedNotice(turn({ preview: "file a bug for the login crash" }));
		expect(notice).toContain("file a bug for the login crash");
		expect(notice).toContain("did happen");
	});
	it("reads fine with no preview", () => {
		expect(interruptedNotice(turn({ preview: undefined }))).not.toContain("“");
	});
});

describe("previewOf", () => {
	it("flattens whitespace", () => {
		expect(previewOf("  hello\n  there ")).toBe("hello there");
	});
	it("truncates long messages", () => {
		const p = previewOf("x".repeat(200), 20);
		expect(p).toHaveLength(20);
		expect(p.endsWith("…")).toBe(true);
	});
	it("leaves a short message alone", () => {
		expect(previewOf("hi", 20)).toBe("hi");
	});
});
