import { describe, expect, it } from "vitest";
import { appendSnapshot, SNAPSHOT_GAP, stitchSnapshots, terminalPlaceholder } from "./terminal-history";

describe("appendSnapshot — snapshots overlap, so joining them is the hard part (#432)", () => {
	it("appends only the NEW tail of an overlapping snapshot", () => {
		// A snapshot is the tail of the whole transcript, so row N+1 is row N plus a few lines.
		// Naive concatenation would render an hour of work five times over, which is worse than
		// the single pane the scrollback replaces.
		const a = "$ npm test\nRUN v3.2.6\n".repeat(6);
		expect(appendSnapshot(a, `${a}PASS 42 tests\n`)).toBe(`${a}PASS 42 tests\n`);
	});

	it("adds nothing when the next snapshot is what we already end with", () => {
		const a = `${"line\n".repeat(40)}done\n`;
		expect(appendSnapshot(a, a)).toBe(a);
		expect(appendSnapshot(a, a.slice(-200))).toBe(a);
	});

	it("marks a gap rather than silently welding two unrelated panes together", () => {
		// The engine restarted, or the runner's buffer rotated past the overlap window. Pretending
		// the two are continuous would invent output order that never happened.
		const joined = appendSnapshot("A".repeat(200), "B".repeat(200));
		expect(joined).toBe("A".repeat(200) + SNAPSHOT_GAP + "B".repeat(200));
	});

	it("lets a longer snapshot supersede a very short one instead of duplicating it", () => {
		// The first live pane after a tiny stored snapshot: the pane CONTAINS what we have.
		expect(appendSnapshot("$ ", "$ npm test\nPASS\n")).toBe("$ npm test\nPASS\n");
	});

	it("handles the empty cases without producing a stray separator", () => {
		expect(appendSnapshot("", "abc")).toBe("abc");
		expect(appendSnapshot("abc", "")).toBe("abc");
	});
});

describe("stitchSnapshots — a page of rows becomes one continuous scrollback", () => {
	it("joins successive snapshots of a growing pane into the pane itself", () => {
		const growing = ["step 1\n", "step 1\nstep 2\n", "step 1\nstep 2\nstep 3\n"];
		expect(stitchSnapshots(growing.map((content) => ({ type: "terminal", content })))).toBe("step 1\nstep 2\nstep 3\n");
	});

	it("reads `text` as well as `content` — both column names reach the client", () => {
		expect(stitchSnapshots([{ type: "terminal", text: "hello\n" }])).toBe("hello\n");
	});

	it("is empty for an empty page, so the caller falls through to the placeholder", () => {
		expect(stitchSnapshots([])).toBe("");
	});
});

describe("terminalPlaceholder — four causes had one sentence between them (#432)", () => {
	it("names the command when the runner is offline, and outranks everything else", () => {
		// Nothing else can be true until this is fixed, and it is the only cause with an action.
		expect(terminalPlaceholder({ runnerConnected: false, loadingHistory: true, runState: "thinking" })).toContain("pags up");
	});

	// #537: the command is right for a machine that is off and WRONG for a session stamped to one
	// machine while another is running `pags up`. Only the server can tell those apart, so when it
	// sends its sentence the placeholder must show that instead of the hardcoded remedy.
	it("defers to the server's diagnosis, and stops prescribing `pags up` when it is the wrong advice", () => {
		const text = terminalPlaceholder({
			runnerConnected: false,
			offlineNotice: "This session is running on air.local, which isn't connected. mini.local is connected — open the session again to move it to mini.local.",
		});
		expect(text).toContain("air.local");
		expect(text).toContain("mini.local");
		expect(text).not.toContain("pags up");
	});

	it("keeps the hardcoded sentence when the server sends none — an older API must not blank the pane", () => {
		expect(terminalPlaceholder({ runnerConnected: false, offlineNotice: "   " })).toContain("pags up");
	});

	it("says it is still loading rather than that there is nothing", () => {
		// The old code cleared the DB fallback and THEN awaited the timeline, so this state was
		// reported as "(waiting for output...)" on every single session open.
		expect(terminalPlaceholder({ runnerConnected: true, loadingHistory: true })).toMatch(/loading/i);
	});

	it("distinguishes a session the runner no longer holds", () => {
		expect(terminalPlaceholder({ runnerConnected: true, alive: false })).toMatch(/isn't running/i);
	});

	it("says the engine is working when it is, instead of implying silence", () => {
		expect(terminalPlaceholder({ runnerConnected: true, alive: true, runState: "responding" })).toMatch(/working/i);
	});

	it("falls back to genuinely-no-output only when everything else is fine", () => {
		expect(terminalPlaceholder({ runnerConnected: true, alive: true, runState: "idle" })).toMatch(/No output yet/);
	});

	it("distinguishes a REFUSED turn from nothing having been sent (#545)", () => {
		// The owner's own words on the tab: "There is nothing there yet, it just says no output yet,
		// send the engine an instruction to get started." One HAD been sent; the engine exited 1 and
		// produced nothing. The sentence invited exactly the wrong next move.
		const refused = terminalPlaceholder({ runnerConnected: true, alive: true, runState: "idle", lastTurnFailed: true });
		expect(refused).toMatch(/last turn failed/i);
		expect(refused).not.toMatch(/No output yet/);
		// A turn RUNNING right now outranks a report about one that has ended.
		expect(terminalPlaceholder({ runnerConnected: true, alive: true, runState: "thinking", lastTurnFailed: true })).toMatch(/working/i);
		// And an offline runner still outranks everything: it is the only cause with a command.
		expect(terminalPlaceholder({ runnerConnected: false, lastTurnFailed: true })).toContain("pags up");
	});

	it("does not claim the runner is offline when the poll has not answered yet", () => {
		// `runnerConnected` is undefined before the first /capture. `=== false` rather than a
		// falsy check is what stops the first frame accusing a healthy machine.
		expect(terminalPlaceholder({})).not.toContain("pags up");
	});
});
