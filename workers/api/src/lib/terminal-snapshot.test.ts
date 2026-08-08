import { describe, expect, it } from "vitest";
import { parseTimelineTimestamp, shouldPersistSnapshot, SNAPSHOT_THROTTLE_MS } from "./terminal-snapshot.js";

const NOW = Date.parse("2026-08-09T07:00:00Z");

describe("parseTimelineTimestamp — SQLite's timestamp is UTC and does not say so", () => {
	it("reads `datetime('now')`'s shape as UTC, not as local time", () => {
		// The column default is `datetime('now')` → "2026-08-09 07:00:00". `Date.parse` treats
		// that as LOCAL. On a Worker (UTC) the bug is invisible; on any machine east or west of
		// it the throttle below is off by the offset — hours, in Australia — which either writes
		// on every poll or never writes at all.
		expect(parseTimelineTimestamp("2026-08-09 07:00:00")).toBe(NOW);
	});

	it("leaves a value that already carries a zone alone", () => {
		expect(parseTimelineTimestamp("2026-08-09T07:00:00Z")).toBe(NOW);
		expect(parseTimelineTimestamp("2026-08-09T07:00:00.000Z")).toBe(NOW);
		expect(parseTimelineTimestamp("2026-08-09T17:00:00+10:00")).toBe(NOW);
	});

	it("returns null rather than NaN for nothing and for nonsense", () => {
		expect(parseTimelineTimestamp(null)).toBeNull();
		expect(parseTimelineTimestamp("")).toBeNull();
		expect(parseTimelineTimestamp("not a date")).toBeNull();
	});
});

describe("shouldPersistSnapshot — a busy session must leave a record too (#432)", () => {
	const base = { pane: "$ npm test\nPASS", lastContent: "$ npm test", lastAt: "2026-08-09 06:59:59", runState: "idle", now: NOW };

	it("writes nothing for an empty pane", () => {
		expect(shouldPersistSnapshot({ ...base, pane: "   " })).toBe(false);
	});

	it("writes nothing when the pane has not changed — the dedup an idle poll depends on", () => {
		// /capture polls every 1.5s. Without this an idle session appends an identical 8000-char
		// row forty times a minute, forever.
		expect(shouldPersistSnapshot({ ...base, pane: "$ npm test", lastContent: "$ npm test" })).toBe(false);
		expect(shouldPersistSnapshot({ ...base, pane: "  $ npm test  ", lastContent: "$ npm test" })).toBe(false);
	});

	it("writes a changed pane the instant the engine goes idle — unchanged from before #432", () => {
		// The end-of-turn snapshot is the valuable one, and it must not wait out the throttle.
		expect(shouldPersistSnapshot({ ...base, lastAt: "2026-08-09 06:59:59" })).toBe(true);
	});

	it("writes DURING a run once the last snapshot is old enough", () => {
		// This is the whole point. Before, a session busy from the moment it started never reached
		// the gate, so a 40-step Loop run persisted nothing and reopening the tab showed
		// "(waiting for output...)" over an hour of real work.
		const busy = { ...base, runState: "thinking" };
		expect(shouldPersistSnapshot({ ...busy, lastAt: new Date(NOW - SNAPSHOT_THROTTLE_MS).toISOString() })).toBe(true);
		expect(shouldPersistSnapshot({ ...busy, lastAt: new Date(NOW - SNAPSHOT_THROTTLE_MS - 1000).toISOString() })).toBe(true);
	});

	it("holds off DURING a run while the last snapshot is recent — the write-amplification guard", () => {
		const busy = { ...base, runState: "responding" };
		expect(shouldPersistSnapshot({ ...busy, lastAt: new Date(NOW - 1_000).toISOString() })).toBe(false);
		expect(shouldPersistSnapshot({ ...busy, lastAt: new Date(NOW - SNAPSHOT_THROTTLE_MS + 1).toISOString() })).toBe(false);
	});

	it("treats a session with no snapshot yet as due, whatever the engine is doing", () => {
		// The first snapshot of a busy session is the one there is no excuse for missing.
		expect(shouldPersistSnapshot({ ...base, runState: "thinking", lastContent: null, lastAt: null })).toBe(true);
	});

	it("treats an undateable row as due rather than as a reason to write nothing", () => {
		expect(shouldPersistSnapshot({ ...base, runState: "thinking", lastAt: "garbage" })).toBe(true);
	});
});
