import { describe, expect, it } from "vitest";
import { describeTerminal, renderTerminalLine, type TerminalInputs } from "./terminal-label.js";

const base: TerminalInputs = {
	runnerOnline: true,
	captureOk: true,
	pane: "some current pane output",
	alive: true,
	runState: "idle",
	lastSnapshot: "older stored snapshot",
	updatedAt: "2026-07-07 10:00:00",
};

describe("describeTerminal", () => {
	it("runner offline → runner-offline with the stored snapshot", () => {
		const v = describeTerminal({ ...base, runnerOnline: false });
		expect(v.kind).toBe("runner-offline");
		expect(v.text).toBe("older stored snapshot");
		expect(v.asOf).toBe("2026-07-07 10:00:00");
	});

	it("online but capture FAILED → capture-failed (NOT collapsed into offline/stale)", () => {
		const v = describeTerminal({ ...base, captureOk: false });
		expect(v.kind).toBe("capture-failed");
		expect(v.text).toBe("older stored snapshot");
	});

	it("online, capture ok, blank pane → empty-pane", () => {
		expect(describeTerminal({ ...base, pane: "   " }).kind).toBe("empty-pane");
		expect(describeTerminal({ ...base, pane: null }).kind).toBe("empty-pane");
	});

	it("online, pane present, IDLE → live-idle (never stamped 'captured just now = current activity')", () => {
		const v = describeTerminal({ ...base, runState: "idle", alive: false });
		expect(v.kind).toBe("live-idle");
		expect(v.text).toBe("some current pane output");
	});

	it("online, pane present, engine working → live-active", () => {
		expect(describeTerminal({ ...base, runState: "thinking" }).kind).toBe("live-active");
		expect(describeTerminal({ ...base, runState: "responding" }).kind).toBe("live-active");
	});

	it("no live pane and no stored snapshot → none", () => {
		expect(describeTerminal({ ...base, runnerOnline: false, lastSnapshot: null }).kind).toBe("none");
		expect(describeTerminal({ ...base, pane: "", lastSnapshot: "" }).kind).toBe("none");
	});

	it("REGRESSION (the flip-flop): same stored snapshot, only captureOk toggles → different, correct kinds", () => {
		// Turn A: capture succeeded on a live idle session.
		const a = describeTerminal({ ...base, captureOk: true, pane: "live text", runState: "idle" });
		// Turn B: the capture round-trip failed this turn (runner still online).
		const b = describeTerminal({ ...base, captureOk: false });
		expect(a.kind).toBe("live-idle");
		expect(b.kind).toBe("capture-failed"); // NOT "runner-offline", NOT silently the same stale label
		expect(a.kind).not.toBe(b.kind);
	});
});

describe("renderTerminalLine", () => {
	it("labels idle scrollback as possibly-old, never 'captured just now'", () => {
		const line = renderTerminalLine(describeTerminal({ ...base, runState: "idle" }));
		expect(line).toMatch(/IDLE/);
		expect(line).toMatch(/may be OLD/i);
		expect(line).not.toMatch(/captured just now/i);
	});

	it("tells the model NOT to infer idle/done from a failed capture", () => {
		const line = renderTerminalLine(describeTerminal({ ...base, captureOk: false }));
		expect(line).toMatch(/UNAVAILABLE/);
		expect(line).toMatch(/do NOT infer/i);
	});

	it("empty view renders nothing", () => {
		expect(renderTerminalLine({ kind: "none", text: "" })).toBe("");
	});
});
