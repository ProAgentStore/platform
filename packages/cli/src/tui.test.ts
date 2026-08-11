/**
 * The three pane defects from #497, pinned. A status pane that lies is why a human had to notice
 * that six of nineteen agents were detached.
 */
import { describe, expect, it } from "vitest";
import { connectingNote, describe as describeRow, LABEL_WIDTH, pagsNote } from "./tui.js";

describe("status rows", () => {
	it("pads past the longest label, so 'ProAgentStore' never runs into its note", () => {
		// `padEnd(13)` with a 13-character label added nothing: `ProAgentStorenot registered`.
		const { label, note } = describeRow("pags", "failed");
		expect(LABEL_WIDTH).toBeGreaterThan("ProAgentStore".length);
		expect(`${label.padEnd(LABEL_WIDTH)}${note}`).toContain("ProAgentStore  ");
	});

	it("every row's label fits the derived width", () => {
		for (const kind of ["runner", "tunnel", "pags"] as const) {
			expect(describeRow(kind, "online").label.length).toBeLessThan(LABEL_WIDTH);
		}
	});
});

describe("the connecting note", () => {
	it("says 'a few seconds' only while that is plausibly true", () => {
		expect(connectingNote(0)).toContain("a few seconds");
		expect(connectingNote(29_000)).toContain("a few seconds");
	});

	it("past 30s it states the elapsed time and where to look instead", () => {
		expect(connectingNote(45_000)).toBe("Still connecting — 45s elapsed. Press l for logs.");
		expect(connectingNote(4 * 60_000)).toBe("Still connecting — 4m elapsed. Press l for logs.");
		expect(connectingNote(60 * 60_000)).not.toContain("a few seconds");
	});
});

describe("the ProAgentStore row's two independent facts", () => {
	it("names the heartbeat when registration is fine but the beat is not", () => {
		expect(pagsNote("registered", "failing")).toMatch(/heartbeat/);
	});

	it("says nothing extra in every other combination", () => {
		expect(pagsNote("registered", "ok")).toBeUndefined();
		expect(pagsNote("registered", undefined)).toBeUndefined();
		// A failed registration has its own note already; two problems in one line helps nobody.
		expect(pagsNote("failed", "failing")).toBeUndefined();
		expect(pagsNote("pending", "failing")).toBeUndefined();
	});
});
