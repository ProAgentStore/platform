import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_FAMILY, TMUX_FAMILY } from "./terminalTools.js";
import { DEFAULT_TMUX_VIEW, TMUX_VIEWS, type TmuxPaneInputs, type TmuxView, tmuxBlockClass, tmuxPaneState, writeHint } from "./tmuxView.js";

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
	access: { state: "ready", family: TERMINAL_FAMILY, canCapture: true },
	error: "",
	status: "",
	canWrite: true,
	selected: "tmux:work",
	targetCount: 1,
};

/** The same tab on an agent that declares the backend-exclusive `tmux_*` family (#403). */
const TMUX_ONLY: TmuxPaneInputs = { ...HEALTHY, access: { state: "ready", family: TMUX_FAMILY, canCapture: true } };

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
		expect(tmuxPaneState({ ...HEALTHY, canWrite: false }).notice).toEqual({ tone: "hint", text: writeHint(TERMINAL_FAMILY), remedy: null, remedyOn: "" });
		expect(tmuxPaneState(HEALTHY).notice).toBeNull();
	});

	it("asks for the grant the CONSENT ROW is keyed by, not for 'terminal' every time", () => {
		// #403 carries this agent's existing `terminal` consent to `tmux` precisely so the owner does
		// not have to re-grant. A hint naming the wrong connector points at a checkbox that is not
		// the one standing in the way.
		expect(writeHint(TMUX_FAMILY)).toContain("Grant tmux write access");
		expect(writeHint(TMUX_FAMILY)).not.toContain("terminal");
		expect(writeHint(TERMINAL_FAMILY)).toContain("Grant terminal write access");
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

describe("tmuxPaneState — the agent has no terminal tool (#409)", () => {
	const UNSUPPORTED: TmuxPaneInputs = { ...HEALTHY, access: { state: "unsupported", needs: ["terminal_list_targets", "tmux_list_sessions"] }, targetCount: 0, selected: "" };

	it("THE BUG: it never again says the machine has no terminals", () => {
		// The reported symptom. With #403 applied, `terminal_list_targets` 403s on the tmux Operator,
		// the target list stays empty, and the empty state told the owner to go open a tmux session —
		// which they can do all day without changing anything, because nothing was ever asked of the
		// machine. That sentence is the actively harmful part of the failure.
		const s = tmuxPaneState(UNSUPPORTED);
		for (const line of [s.emptyPane, s.emptyTargets, s.hint]) {
			expect(line).not.toMatch(/No terminal targets found|No tmux sessions found/);
			expect(line).not.toMatch(/Open tmux|Start a/);
		}
	});

	it("names the tool it needs and who decides it", () => {
		const s = tmuxPaneState(UNSUPPORTED);
		expect(s.notice?.tone).toBe("error");
		expect(s.notice?.text).toContain("terminal_list_targets or tmux_list_sessions");
		// Not a 403 string addressed to a creator: the reader declared nothing and can act on neither.
		expect(s.notice?.text).not.toContain("is not one of this agent's tools");
		expect(s.notice?.text).toContain("Settings");
	});

	it("outranks offline — `pags up` is not the remedy for a tool that was never declared", () => {
		// Both facts are true at once on a machine that is down. Only one of them is the reason the
		// tab is empty, and printing the other sends the reader to fix something that is not broken.
		const s = tmuxPaneState({ ...UNSUPPORTED, presence: { online: false, node: "Mac", attachment: { message: "The runner isn't running.", remedy: "pags up" } } });
		expect(s.offline).toBe(false);
		expect(s.notice?.remedy).toBeNull();
		expect(s.notice?.text).toContain("terminal_list_targets");
	});

	it("is STABLE across polls — it is derived from the policy, never from an error slot (#378)", () => {
		// The same property #378 established for the offline notice, and the reason the tab must not
		// go on calling a tool it knows will be refused: a notice written by a failing poll is a
		// notice the next poll erases, four seconds apart, forever.
		const settled = tmuxPaneState(UNSUPPORTED);
		const midPoll = tmuxPaneState({ ...UNSUPPORTED, error: "" });
		const afterAFailure = tmuxPaneState({ ...UNSUPPORTED, error: '"terminal_list_targets" is not one of this agent\'s tools.' });
		expect(midPoll).toEqual(settled);
		expect(afterAFailure.notice?.text).toBe(settled.notice?.text);
	});

	it("says nothing at all until the policy has answered", () => {
		// A first paint that asserted "this agent has no terminal tools" and withdrew it 200ms later
		// is the #378 flicker rebuilt from the other side.
		const s = tmuxPaneState({ ...HEALTHY, access: { state: "loading" }, targetCount: 0, selected: "" });
		expect(s.notice).toBeNull();
		expect(s.offline).toBe(false);
		expect(s.emptyPane).not.toMatch(/no terminal tool|No terminal targets/);
	});
});

describe("tmuxPaneState — the resolved family owns the vocabulary", () => {
	it("a tmux-only agent is never told to go open kitty", () => {
		const s = tmuxPaneState({ ...TMUX_ONLY, targetCount: 0, selected: "" });
		expect(s.emptyTargets).toBe("No tmux sessions found on Mac. Open tmux there, or create one from Controls.");
		expect(s.emptyTargets).not.toMatch(/kitty|iTerm2/);
		expect(s.hint).toBe(s.emptyTargets);
	});

	it("the generic agent keeps every word it had — three of the four Operators still use it", () => {
		const s = tmuxPaneState({ ...HEALTHY, targetCount: 0, selected: "" });
		expect(s.emptyTargets).toBe("No terminal targets found on Mac. Open tmux, kitty, or iTerm2 there, or create one from Controls.");
	});

	it("asks you to select a tmux session, not a terminal target, when that is what the agent has", () => {
		expect(tmuxPaneState({ ...TMUX_ONLY, selected: "" }).emptyPane).toBe("Select a tmux session to capture its output.");
		// Byte-identical to what it said before #409: this is the sentence the other three Operators
		// still read.
		expect(tmuxPaneState({ ...HEALTHY, selected: "" }).emptyPane).toBe("Select a terminal target to capture its output.");
	});

	it("a family that can list but not capture says so, rather than showing a blank pane", () => {
		// `1f3ca00` gates per TOOL. An agent declaring the list tool and not the capture tool is a
		// real declaration, and the honest answer is which half is missing — not an empty `<pre>`.
		const s = tmuxPaneState({ ...TMUX_ONLY, access: { state: "ready", family: TMUX_FAMILY, canCapture: false } });
		expect(s.emptyPane).toContain("tmux_capture_pane");
		expect(s.emptyPane).toContain("but not read one");
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

	it("BOTH polled calls are gated on the resolved family, and neither writes the error slot to do it", () => {
		// #409's fix in the same shape #378's is checked: a resolver the component does not consult is
		// the bug intact. The reads must bail BEFORE the fetch — a gate that fires the call and then
		// interprets the 403 is the 4-second refusal storm with better copy.
		const src = tab();
		for (const [fn, guard] of [
			["const refreshTargets = useCallback(", "if (!family) return;"],
			["const capture = useCallback(", "if (!session || !family || !canCapture) return;"],
		]) {
			const start = src.indexOf(fn);
			expect(start, `${fn} not found — did it get renamed?`).toBeGreaterThan(-1);
			const head = src.slice(start, src.indexOf("try {", start));
			expect(head, `${fn} no longer checks the agent declares the tool`).toContain(guard);
			expect(head, `${fn} writes the error slot on a refusal it could predict`).not.toContain("setError(");
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
