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
