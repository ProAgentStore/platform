import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TMUX_VIEW, TMUX_VIEWS, type TmuxPaneInputs, type TmuxView, tmuxBlockClass, tmuxPaneState, WRITE_HINT } from "./tmuxView.js";

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

/** A tab with a live runner, one target, nothing to report — the state everything else varies from. */
const HEALTHY: TmuxPaneInputs = {
	presence: { online: true, node: "Mac" },
	error: "",
	status: "",
	canWrite: true,
	selected: "tmux:work",
	targetCount: 1,
};

describe("tmuxPaneState — the offline state the tab never had", () => {
	it("THE BUG: an empty error slot cannot blank the offline notice", () => {
		// #378 in one assertion. The notice used to BE the error slot, which every poll cleared
		// before re-attempting — so the tab's only true statement existed for the ~200ms between a
		// call failing and the next one starting, four seconds apart, forever.
		const between = tmuxPaneState({ ...HEALTHY, presence: { online: false, node: "Mac" }, error: "", targetCount: 0 });
		expect(between.offline).toBe(true);
		expect(between.notice?.tone).toBe("error");
		expect(between.notice?.text).toBeTruthy();
	});

	it("prints the server's reason and remedy, and names the machine to run it on", () => {
		// `pags up` is the WRONG advice for this one, and a hardcoded string can never say so.
		const s = tmuxPaneState({
			...HEALTHY,
			presence: {
				online: false,
				node: "Mac",
				attachment: { message: "The machine is online but this agent isn't attached.", remedy: "pags up --force" },
			},
		});
		expect(s.notice?.text).toBe("The machine is online but this agent isn't attached.");
		expect(s.notice?.remedy).toBe("pags up --force");
		// The reader is holding a phone; a remedy that does not name the OTHER machine reads as one
		// they could run here.
		expect(s.notice?.remedyOn).toBe("Mac");
	});

	it("still says something when the probe answered without a diagnosis", () => {
		// `/runtime/status`'s transient + error branches carry no `attachment`.
		const s = tmuxPaneState({ ...HEALTHY, presence: { online: false }, targetCount: 0 });
		expect(s.notice?.text).toBe("No runner is connected for this agent.");
		expect(s.notice?.remedy).toBeNull();
		expect(s.notice?.remedyOn).toBe("the machine whose terminal you want to control");
	});

	it("reads the same on Output as on Targets, and asserts no runner", () => {
		// Defect 3: the one empty state that named the runner lived on the Targets view, which a
		// phone does not show — so the phone got "select a target" three times instead.
		const s = tmuxPaneState({
			...HEALTHY,
			presence: { online: false, attachment: { message: "The runner for this agent isn't running.", remedy: "pags up" } },
			selected: "",
			targetCount: 0,
		});
		expect(s.emptyPane).toBe(s.emptyTargets);
		for (const line of [s.emptyPane, s.emptyTargets, s.hint]) {
			expect(line).not.toMatch(/connected (runner|machine)/);
			expect(line).not.toMatch(/Select a terminal target|Start a terminal target/);
		}
		// Four blocks share one 390px screen, so they must not each repeat the diagnosis.
		expect(new Set([s.notice?.text, s.emptyPane, s.hint]).size).toBe(3);
	});

	it("outranks the failed call it caused — one statement about one fact", () => {
		// The failing tool call IS the offline state; printing both is the contradiction
		// `lib/runnerPanel.ts` documents, where a reader cannot arbitrate between two sentences.
		const s = tmuxPaneState({ ...HEALTHY, presence: { online: false }, error: "No runner is connected for this agent — run `pags up` …" });
		expect(s.notice?.text).toBe("No runner is connected for this agent.");
	});

	it("an unanswered status is not an offline one", () => {
		// The first paint happens before the shell's status poll lands. Opening on a red banner
		// that a moment later withdraws itself is the same flicker from the other side.
		const s = tmuxPaneState({ ...HEALTHY, presence: { online: null }, targetCount: 0 });
		expect(s.offline).toBe(false);
		expect(s.notice).toBeNull();
		// …and with nothing known, it must not assert a connection either.
		expect(s.emptyTargets).toContain("on your machine");
	});
});

describe("tmuxPaneState — the online notices", () => {
	it("shows the last completed call's error, in preference to a stale success", () => {
		const s = tmuxPaneState({ ...HEALTHY, error: "no such target", status: "Ran in tmux:work" });
		expect(s.notice).toEqual({ tone: "error", text: "no such target", remedy: null, remedyOn: "" });
	});

	it("shows an action's confirmation when nothing failed", () => {
		expect(tmuxPaneState({ ...HEALTHY, status: "Ran in tmux:work" }).notice?.tone).toBe("status");
	});

	it("falls back to the write-access hint, and to no row at all", () => {
		expect(tmuxPaneState({ ...HEALTHY, canWrite: false }).notice).toEqual({ tone: "hint", text: WRITE_HINT, remedy: null, remedyOn: "" });
		expect(tmuxPaneState(HEALTHY).notice).toBeNull();
	});

	it("names the machine it can see, and offers Controls rather than a hidden block", () => {
		const s = tmuxPaneState({ ...HEALTHY, selected: "", targetCount: 0 });
		expect(s.emptyTargets).toContain("on Mac");
		// "below" was the wide layout talking: on a phone the create-target row is a different view.
		expect(s.emptyTargets).toContain("Controls");
		expect(s.hint).toBe(s.emptyTargets);
	});

	it("leaves a selected target's pane genuinely empty while its first capture is in flight", () => {
		expect(tmuxPaneState(HEALTHY).emptyPane).toBe("");
		expect(tmuxPaneState({ ...HEALTHY, selected: "" }).emptyPane).toBe("Select a terminal target to capture its output.");
	});
});

/**
 * The regression guards for the two defects, in the shape `loopStopState.test.ts` gives its own:
 * a pure resolver nobody calls is the bug repeating, and neither console has component-testing
 * infrastructure (#282) to catch that by rendering. Both properties below are properties of the
 * SOURCE, so they can be checked without a DOM.
 */
describe("the tab actually routes through the resolver", () => {
	const SRC = resolve(__dirname, "..");
	const tab = () => readFileSync(resolve(SRC, "tabs/TmuxTab.tsx"), "utf8");

	it("TmuxTab decides its copy with tmuxPaneState, not inline", () => {
		expect(tab()).toContain("tmuxPaneState");
		// The three sentences the report quoted. Each asserted a runner, or told the reader to pick
		// a target that does not exist; all three now come from the resolver, which knows whether
		// there is one.
		expect(tab()).not.toContain("on the connected runner");
		expect(tab()).not.toContain("on the connected machine");
		expect(tab()).not.toContain("Select a terminal target to capture");
	});

	it("neither POLLED call clears the error before it attempts", () => {
		// The flicker itself. Deliberately scoped to the two polled callbacks: the button handlers
		// DO clear on attempt, and should — a person pressed them, so the previous action's message
		// is stale by definition, and nothing re-runs them every 4 seconds.
		const src = tab();
		for (const fn of ["const refreshTargets = useCallback(", "const capture = useCallback("]) {
			const start = src.indexOf(fn);
			expect(start, `${fn} not found — did it get renamed?`).toBeGreaterThan(-1);
			const head = src.slice(start, src.indexOf("try {", start));
			expect(head, `${fn} clears the error on attempt`).not.toContain("setError(");
		}
	});

	it("the shell hands the surface its runner presence", () => {
		// Without this the resolver is perfect and permanently unanswered: `online` stays null and
		// the tab is back to learning about the runner only by failing.
		const surfaces = readFileSync(resolve(SRC, "lib/surfaces.tsx"), "utf8");
		expect(surfaces).toContain("runner?: RunnerPresence");
		expect(surfaces).toMatch(/<TmuxTab[^>]*runner=\{runner\}/);
		const page = readFileSync(resolve(SRC, "pages/InstanceDetail.tsx"), "utf8");
		expect(page).toContain("runner: { online: runnerOnline");
		// The reason and the remedy, not just the boolean the header dot needed.
		expect(page).toContain("setRunnerAttachment");
	});
});
