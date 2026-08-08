/**
 * Which of the Terminal tab's blocks are on screen at phone width (#370).
 *
 * MEASURED, not inferred. `TmuxTab` is a two-column grid that degrades to `grid-cols-1`, so below
 * `lg` its eight blocks stack: the target-list header, the target list, the pane header, the
 * status line, the `<pre>`, and three control rows whose own `grid-cols-1 sm:grid-cols-[…]` shape
 * turns into five full-width inputs below `sm`. Every one of those is fixed height and the `<pre>`
 * is the only `flex-1` element in the column, so it absorbs the entire deficit. At 320px and at
 * 390px it resolved to **24px tall — its own `p-3` padding, and zero lines of output** — on the tab
 * whose whole purpose is reading terminal output. At 768px it was 321px and at 1280px 568px, which
 * is why this only ever looked broken on a phone.
 *
 * The fix is to switch between the blocks below `lg` instead of stacking them, which is what
 * `CodingTab` already does on the same phone. The visibility decision lives here rather than in
 * the render because it is the load-bearing part of the fix and the console has no
 * component-testing infrastructure (#282) — a pure function is the only shape of it a test can
 * hold.
 *
 * The breakpoint is CSS, never JS: a block is `hidden lg:flex` when another view owns it, so the
 * wide layout is exactly what it was before and no resize listener or media-query state exists to
 * disagree with the stylesheet.
 */

import type { TerminalToolAccess, TerminalToolFamily } from "./terminalTools";
import type { RunnerPresence } from "./types";

/** The three things a phone can show one at a time. */
export type TmuxView = "targets" | "output" | "controls";

/** Left-to-right order of the switch. */
export const TMUX_VIEWS: readonly TmuxView[] = ["targets", "output", "controls"];

/**
 * Output, because reading the pane is what the tab is for and it is the block the stacked layout
 * took away. A first paint that lands on the target list would reproduce the reported symptom
 * ("shows the terminal selector and everything on one screen") on purpose.
 */
export const DEFAULT_TMUX_VIEW: TmuxView = "output";

/**
 * The hidden-below-`lg` variants, spelled out.
 *
 * Deliberately NOT built as `` `hidden lg:${display}` ``. Tailwind v4 generates utilities by
 * scanning source text for whole class names, so a template literal yields the fragments
 * `hidden lg:` and `flex` and the rule that does the actual hiding is never emitted — the fix
 * would then work or not depending on whether some unrelated file happened to contain the
 * string. The scanner's literalism is the same property that bit #368 from the other side, where
 * quoting a broken class in a comment regenerated it in the built CSS.
 */
const HIDDEN_BELOW_LG = { flex: "hidden lg:flex", block: "hidden lg:block" } as const;

/**
 * Responsive display classes for a block owned by one or more views.
 *
 * Below `lg` only the active view's blocks are displayed; from `lg` up every block is, which is
 * the pre-#370 two-column layout untouched.
 */
export function tmuxBlockClass(active: TmuxView, owners: readonly TmuxView[], display: "flex" | "block" = "flex"): string {
	return owners.includes(active) ? display : HIDDEN_BELOW_LG[display];
}

// ── What the pane SAYS, and why that is decided here ─────────────────────────
//
// The tab learned that the runner was gone only by a tool call FAILING, and then blanked that
// failure at the start of the next poll — so on a phone the whole tab was three sentences that
// assert a runner ("on the connected runner", "on the connected machine", "select a target")
// plus a red line that appeared and vanished every 4 seconds (#378).
//
// Two halves, and both live here:
//
//   PRESENCE. `/runtime/status` already answers "is a relay socket live" and, since #237, WHY it
//   is not — with the remedy that actually applies, which is sometimes `pags up --force` and not
//   `pags up`. The shell polls it for the header dot. Reading that instead of inferring
//   connectivity from a failed round-trip is the difference between a state the tab can render
//   deliberately and one it stumbles into.
//
//   PRECEDENCE. When the runner is known offline, the failed capture is a SYMPTOM of that, not a
//   second fact. Printing both is what `lib/runnerPanel.ts` documents as the defect a reader
//   cannot arbitrate: two statements about one thing. Offline therefore OUTRANKS the error slot,
//   which also means the notice no longer depends on the error slot's timing at all — it is
//   present for as long as the runner is, and a poll cannot erase it. An error state a poll
//   erases before it can be read is not an error state.
//
// Pure, for the reason the header of this file already gives: this console has no
// component-testing infrastructure (#282), so a function is the only shape of these decisions a
// test can hold.

/** How the notice line reads. Maps to a colour in the render, nothing more. */
export type TmuxNoticeTone = "error" | "status" | "hint";

export interface TmuxNotice {
	tone: TmuxNoticeTone;
	text: string;
	/** The bare command that fixes it, when the server named one — rendered as code. */
	remedy: string | null;
	/**
	 * Where to run it. Always set alongside `remedy`, because `pags up` is not a thing the phone
	 * reading this can do and a remedy that does not name the OTHER machine reads as one that can.
	 */
	remedyOn: string;
}

export interface TmuxPaneInputs {
	presence: RunnerPresence;
	/**
	 * What this agent's own tool list lets the tab do (#409). Read BEFORE presence, because a tool
	 * the agent does not have is not fixed by a runner: telling the owner to run `pags up` when
	 * nothing was ever asked of the machine is the same false remedy as telling them to open a tmux
	 * session, and that sentence is exactly what this ticket exists to delete.
	 */
	access: TerminalToolAccess;
	/** The message from the last COMPLETED call — "" when that call succeeded. */
	error: string;
	/** The last action's confirmation ("Ran in …"). */
	status: string;
	/** Does the owner have any terminal write tool granted? */
	canWrite: boolean;
	/** The selected target key, "" when none. */
	selected: string;
	targetCount: number;
}

export interface TmuxPaneState {
	/**
	 * Known-unreachable. An UNANSWERED presence (`online: null`, the first paint) is deliberately
	 * not offline: opening on a red offline banner that a landing status call then withdraws is
	 * the same flicker in the other direction.
	 */
	offline: boolean;
	/** The one line the status row prints, or null for no row at all. */
	notice: TmuxNotice | null;
	/** The `<pre>` placeholder, used only when nothing has been captured. */
	emptyPane: string;
	/**
	 * The target list's empty state. Identical to `emptyPane` when offline: the sentence that
	 * names the runner used to live only here, on the Targets view, which a phone does not show
	 * (`DEFAULT_TMUX_VIEW` is `output`) — so the one honest empty state was the one nobody saw.
	 */
	emptyTargets: string;
	/** The pane header's subtitle when no target is selected. */
	hint: string;
}

/**
 * The write-access hint, named for the connector the CONSENT ROW is actually keyed by.
 *
 * It used to say "terminal" unconditionally. On the tmux Operator the grant the owner needs is
 * `tmux` (#403 carries the existing `terminal` consent across for exactly this reason), and a hint
 * that points at the wrong checkbox is a hint that cannot be followed.
 */
export function writeHint(family: TerminalToolFamily): string {
	return `Grant ${family.connector} write access in Settings to run commands, send keys, and create or close ${family.noun}s.`;
}

/** "tmux" / "tmux, kitty, or iTerm2" — only ever the backends the resolved family can reach. */
function backendList(backends: readonly string[]): string {
	const names = backends.map((b) => (b === "iterm2" ? "iTerm2" : b));
	if (names.length <= 1) return names[0] ?? "a terminal";
	return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

/**
 * "tmux session" for the backend-exclusive family, "terminal target" for the generic one.
 *
 * Derived from the family's own backends rather than switched on its id, so the generic family's
 * sentences come out byte-identical to what they said before #409 — the three Operators that kept
 * `terminal_*` must read exactly as they did.
 */
function targetLabel(family: TerminalToolFamily): string {
	return family.backends.length === 1 ? `${backendList(family.backends)} ${family.noun}` : `terminal ${family.noun}`;
}

/**
 * Said when the status probe reports no socket but names no reason — the `transient`/error
 * branches of `/runtime/status` carry no `attachment`. Asserting nothing beats rendering an
 * empty line, and it claims strictly less than the copy it replaced.
 */
const OFFLINE_FALLBACK = "No runner is connected for this agent.";

/** Where a remedy has to be run, named as precisely as we can name it. */
const UNKNOWN_MACHINE = "the machine whose terminal you want to control";

/** "on Mac" / "on the connected machine" / "on your machine" — never a machine we are guessing at. */
function machinePhrase(presence: RunnerPresence): string {
	if (presence.node) return `on ${presence.node}`;
	return presence.online === true ? "on the connected machine" : "on your machine";
}

export function tmuxPaneState({ presence, access, error, status, canWrite, selected, targetCount }: TmuxPaneInputs): TmuxPaneState {
	// Before anything else: has the tool policy even landed? Every other branch below asserts
	// something about what this agent can do, and for the first round trip we do not know.
	if (access.state === "loading") {
		const empty = "Checking what this agent can reach…";
		return { offline: false, notice: null, emptyPane: empty, emptyTargets: empty, hint: empty };
	}

	// The #409 state. It OUTRANKS offline deliberately: with no terminal tool declared, nothing was
	// ever asked of the machine, so "run `pags up`" is advice that cannot work, and "open tmux
	// there" — the sentence the old empty state printed — is worse, because a reader who follows it
	// gets the same tab back and concludes the product is broken.
	if (access.state === "unsupported") {
		const empty = "This agent has no terminal tool, so nothing was asked of your machine.";
		return {
			offline: false,
			notice: {
				tone: "error",
				text: `This agent doesn't have the tool this tab needs (${access.needs.join(" or ")}). An agent's creator declares which tools it has — Settings › Tools lists them.`,
				remedy: null,
				remedyOn: "",
			},
			emptyPane: empty,
			emptyTargets: empty,
			hint: "There is nothing to control: this agent cannot call a terminal tool.",
		};
	}

	const { family, canCapture } = access;

	if (presence.online === false) {
		// Four blocks are on screen at once on a phone, so each says a DIFFERENT part of one
		// consistent answer: the notice carries the reason and the remedy, the header states the
		// fact, and the two empty states say what will happen. Repeating the diagnosis in all of
		// them would fill a 390px screen with one sentence three times.
		const empty = "Terminal output appears here as soon as the runner reconnects.";
		return {
			offline: true,
			notice: {
				tone: "error",
				text: presence.attachment?.message?.trim() || OFFLINE_FALLBACK,
				remedy: presence.attachment?.remedy?.trim() || null,
				remedyOn: presence.node || UNKNOWN_MACHINE,
			},
			// Identical on purpose: the one empty state that named the runner used to live on the
			// Targets view, which a phone does not land on.
			emptyPane: empty,
			emptyTargets: empty,
			hint: "No runner is connected, so there are no terminals to control.",
		};
	}

	const machine = machinePhrase(presence);
	// Only ever `error` OR `status`, never both — they are the outcome of one action, and the
	// error is the one worth keeping when they disagree.
	const notice: TmuxNotice | null = error
		? { tone: "error", text: error, remedy: null, remedyOn: "" }
		: status
			? { tone: "status", text: status, remedy: null, remedyOn: "" }
			: canWrite
				? null
				: { tone: "hint", text: writeHint(family), remedy: null, remedyOn: "" };
	// Every sentence below is spoken in the RESOLVED family's vocabulary. A tmux-only agent offering
	// to go open kitty is the same class of false instruction as the empty state this ticket exists
	// to delete: it names a thing the tab cannot reach on this agent.
	const emptyTargets = `No ${targetLabel(family)}s found ${machine}. Open ${backendList(family.backends)} there, or create one from Controls.`;
	return {
		offline: false,
		notice,
		// A selected target with no output yet is a genuinely empty pane, not a placeholder: the
		// capture is in flight and a sentence here would be replaced a moment later. Unless reading a
		// pane is the one thing this agent cannot do — that is a fact, not a wait.
		emptyPane: !canCapture
			? `This agent can list ${targetLabel(family)}s but not read one — it doesn't have ${family.capture}.`
			: targetCount === 0
				? emptyTargets
				: selected
					? ""
					: `Select a ${targetLabel(family)} to capture its output.`,
		emptyTargets,
		hint: targetCount === 0 ? emptyTargets : `Start a ${targetLabel(family)} from Controls, or open ${backendList(family.backends)} ${machine}.`,
	};
}
