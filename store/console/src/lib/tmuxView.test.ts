import { describe, expect, it } from "vitest";
import { DEFAULT_TMUX_VIEW, TMUX_VIEWS, type TmuxView, tmuxBlockClass } from "./tmuxView.js";

/**
 * The invariant the #370 fix rests on, stated as a property rather than as three examples:
 * below `lg` exactly one view's blocks are displayed, and from `lg` up every block is.
 *
 * The second half matters as much as the first. The wide layout was never broken, so a fix that
 * quietly hid something above `lg` would trade a phone bug for a desktop one, and there is no
 * component test in this console that would notice (#282).
 */

/** The blocks as `TmuxTab` assigns them. Kept here so the test breaks if the render regroups them. */
const BLOCKS: { name: string; owners: readonly TmuxView[] }[] = [
	{ name: "target list", owners: ["targets"] },
	{ name: "pane header", owners: ["output"] },
	{ name: "status / error line", owners: ["output", "controls"] },
	{ name: "pane", owners: ["output"] },
	{ name: "command row", owners: ["output"] },
	{ name: "send-keys + create-target rows", owners: ["controls"] },
];

describe("tmuxBlockClass", () => {
	it("displays a block its active view owns", () => {
		expect(tmuxBlockClass("output", ["output"])).toBe("flex");
		expect(tmuxBlockClass("controls", ["output", "controls"], "block")).toBe("block");
	});

	it("hides a block below lg when another view owns it, and restores it from lg up", () => {
		expect(tmuxBlockClass("targets", ["output"])).toBe("hidden lg:flex");
		expect(tmuxBlockClass("targets", ["output"], "block")).toBe("hidden lg:block");
	});

	it("shows every block from lg up whichever view is active", () => {
		for (const active of TMUX_VIEWS) {
			for (const block of BLOCKS) {
				const cls = tmuxBlockClass(active, block.owners);
				// Either displayed outright, or hidden with an lg: override — never hidden at lg.
				expect(cls === "flex" || cls === "hidden lg:flex", `${block.name} under ${active}: ${cls}`).toBe(true);
			}
		}
	});

	it("displays at least one block per view below lg — no view is an empty screen", () => {
		for (const active of TMUX_VIEWS) {
			const shown = BLOCKS.filter((b) => !tmuxBlockClass(active, b.owners).startsWith("hidden"));
			expect(shown.length, `${active} shows nothing`).toBeGreaterThan(0);
		}
	});

	it("gives the pane a view of its own, with no other block competing for the column", () => {
		// The bug was the pane sharing one column with seven fixed-height blocks. Under `output`
		// the only companions are the header, the status line and the single-row command bar —
		// the three stacking control grids belong to `controls`.
		const shownUnderOutput = BLOCKS.filter((b) => !tmuxBlockClass("output", b.owners).startsWith("hidden")).map((b) => b.name);
		expect(shownUnderOutput).toEqual(["pane header", "status / error line", "pane", "command row"]);
	});
});

describe("the view set", () => {
	it("defaults to the pane, not the selector the report complained about", () => {
		expect(DEFAULT_TMUX_VIEW).toBe("output");
		expect(TMUX_VIEWS).toContain(DEFAULT_TMUX_VIEW);
	});

	it("every view owns at least one block", () => {
		for (const view of TMUX_VIEWS) {
			expect(BLOCKS.some((b) => b.owners.includes(view)), `${view} owns nothing`).toBe(true);
		}
	});
});
