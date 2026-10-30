/**
 * Unit tests for the marker-delimited run and cursor-based capture primitives (#1406).
 *
 * These tests are PURE — `waitForMarker` takes a custom `captureFn` so no real tmux session is
 * needed; the others take plain strings. A real-tmux end-to-end case lives in
 * `tmux-connector.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
	capturePaneSince,
	encodeCursor,
	extractBetweenMarkers,
	makeRunMarkers,
	waitForMarker,
	wrapWithMarkers,
} from "./tmux.js";

describe("makeRunMarkers / wrapWithMarkers", () => {
	it("makes a fresh, distinct pair each call", () => {
		const a = makeRunMarkers();
		const b = makeRunMarkers();
		expect(a.start).not.toBe(b.start);
		expect(a.end).not.toBe(b.end);
		expect(a.start).not.toBe(a.end);
	});

	it("wraps the command with echo start, the command, then echo end:$?", () => {
		const markers = { start: "S1", end: "E1" };
		expect(wrapWithMarkers("npm test", markers)).toBe("echo S1; npm test; echo E1:$?");
	});

	it("passes multi-statement commands through unchanged — $? is still the LAST one's status", () => {
		const markers = { start: "S1", end: "E1" };
		expect(wrapWithMarkers("cd app && npm test", markers)).toBe("echo S1; cd app && npm test; echo E1:$?");
	});
});

describe("extractBetweenMarkers", () => {
	const markers = { start: "__S__", end: "__E__" };

	it("extracts only what's between the two marker lines, with the exit code", () => {
		const pane = ["$ echo __S__; ls; echo __E__:$?", "__S__", "a.txt", "b.txt", "__E__:0", "$ "].join("\n");
		const r = extractBetweenMarkers(pane, markers);
		expect(r.completed).toBe(true);
		expect(r.exitCode).toBe(0);
		expect(r.truncated).toBe(false);
		expect(r.output).toBe("a.txt\nb.txt");
	});

	it("reports a non-zero exit code", () => {
		const pane = ["$ echo __S__; false; echo __E__:$?", "__S__", "__E__:1", "$ "].join("\n");
		const r = extractBetweenMarkers(pane, markers);
		expect(r.exitCode).toBe(1);
		expect(r.output).toBe("");
	});

	it("does NOT match the start marker inside the typed echo line (only the bare output line)", () => {
		// Only the typed line is present — the shell has not produced the echo output yet.
		const pane = "$ echo __S__; sleep 5; echo __E__:$?";
		const r = extractBetweenMarkers(pane, markers);
		// The typed line is not a bare `__S__` line, so no match — falls back to truncated/raw.
		expect(r.truncated).toBe(true);
		expect(r.output).toBe(pane);
	});

	it("start seen but end not yet — still running, no exit code", () => {
		const pane = ["$ echo __S__; sleep 5; echo __E__:$?", "__S__", "partial output so far"].join("\n");
		const r = extractBetweenMarkers(pane, markers);
		expect(r.completed).toBe(false);
		expect(r.exitCode).toBeNull();
		expect(r.truncated).toBe(false);
		expect(r.output).toBe("partial output so far");
	});

	it("earlier commands and their output never leak into the result (#1406's core complaint)", () => {
		const pane = [
			"$ echo hello from an EARLIER command",
			"hello from an EARLIER command",
			"$ echo __S__; echo new output; echo __E__:$?",
			"__S__",
			"new output",
			"__E__:0",
			"$ ",
		].join("\n");
		const r = extractBetweenMarkers(pane, markers);
		expect(r.output).toBe("new output");
		expect(r.output).not.toContain("EARLIER");
	});
});

describe("waitForMarker", () => {
	const FAST = { pollMs: 10, timeoutMs: 500 };

	it("returns as soon as the end marker appears", async () => {
		let calls = 0;
		const markers = { start: "S", end: "E" };
		const pane = await waitForMarker("sess", markers, {
			...FAST,
			captureFn: () => {
				calls++;
				return calls < 3 ? "S\nstill going" : "S\ndone\nE:0";
			},
		});
		expect(pane).toContain("E:0");
		expect(calls).toBeGreaterThanOrEqual(3);
	});

	it("gives up at timeoutMs when the end marker never appears, returning the last capture", async () => {
		const markers = { start: "S", end: "E" };
		const start = Date.now();
		const pane = await waitForMarker("sess", markers, { pollMs: 10, timeoutMs: 100, captureFn: () => "S\nstill running, never finishes" });
		expect(Date.now() - start).toBeGreaterThanOrEqual(90);
		expect(pane).toBe("S\nstill running, never finishes");
	});

	it("does not false-positive on an end marker belonging to a DIFFERENT run", async () => {
		const markers = { start: "S2", end: "E2" };
		const pane = await waitForMarker("sess", markers, {
			...FAST,
			timeoutMs: 60,
			captureFn: () => "S1\nold output\nE1:0", // a previous, unrelated run's markers
		});
		// Never matched E2, so it just times out and returns the last capture — not a false "done".
		expect(pane).toBe("S1\nold output\nE1:0");
	});
});

describe("encodeCursor / capturePaneSince", () => {
	it("a fresh capture (no `since`) returns everything and a cursor matching it", () => {
		const r = capturePaneSince("sess", undefined, 200, () => "line1\nline2");
		expect(r.pane).toBe("line1\nline2");
		expect(r.sinceValid).toBe(true);
		expect(r.cursor).toBe(encodeCursor("line1\nline2"));
	});

	it("a valid cursor returns only what's new (append-only pane)", () => {
		const first = capturePaneSince("sess", undefined, 200, () => "line1\n");
		const second = capturePaneSince("sess", first.cursor, 200, () => "line1\nline2\n");
		expect(second.sinceValid).toBe(true);
		expect(second.pane).toBe("line2\n");
	});

	it("an invalid/garbage cursor falls back to the full pane rather than erroring", () => {
		const r = capturePaneSince("sess", "not-a-real-cursor", 200, () => "line1\nline2");
		expect(r.sinceValid).toBe(false);
		expect(r.pane).toBe("line1\nline2");
	});

	it("a cursor from BEFORE the pane was cleared (shorter/different history) falls back to the full pane", () => {
		const stale = encodeCursor("a very long previous history that is no longer a prefix");
		const r = capturePaneSince("sess", stale, 200, () => "fresh short pane after clear");
		expect(r.sinceValid).toBe(false);
		expect(r.pane).toBe("fresh short pane after clear");
	});

	it("never returns a cursor so long its own call cannot validate it next time", () => {
		const r = capturePaneSince("sess", undefined, 200, () => "some pane text");
		const again = capturePaneSince("sess", r.cursor, 200, () => "some pane text");
		expect(again.sinceValid).toBe(true);
		expect(again.pane).toBe(""); // nothing new since last time
	});
});
