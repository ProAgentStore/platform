/**
 * The operator portal's copy of the console's button vocabulary (#366).
 *
 * ── Why a third copy, and where that stops being the right answer
 *
 * `store/admin` is its own Vite app and its own workspace package. It cannot import
 * `store/console/src/lib/control-classes.ts` — that is another package's private module, outside
 * this project's `rootDir`, and Tailwind would not scan it for the class strings either (v4 finds
 * classes by reading source text, which is the whole reason the console has to `@source` the Coder
 * UI's directory explicitly). This app already carries a byte-identical copy of the design TOKENS
 * for the same reason; DESIGN-SYSTEM.md §4 calls that "three copies" and a test holds them equal.
 *
 * Being honest about the weaker half of the argument: the Coder UI's copy is justified by the two
 * surfaces rendering ON ONE SCREEN, and this one is not — nobody sees the operator portal beside
 * the console. What justifies it here is narrower: a maintainer reading both should not have to
 * hold two definitions of "a small button", and 11 call sites stop inventing padding. If a FOURTH
 * copy is ever wanted, that is the signal to stop copying and build the shared package instead —
 * three is where duplication is still cheaper than the abstraction, and four is an assertion
 * nobody has tested.
 *
 * ── What holds it
 *
 * `store/console/src/lib/control-classes.test.ts` extracts the region between the
 * `vendored:button-vocabulary` markers from every copy and requires them byte-identical. Edit one,
 * paste into the others.
 *
 * `Card` and `Badge` are not here: nothing in this app uses them, and copying an unused table is
 * three copies of a decision with no call sites.
 */

/* ── vendored:button-vocabulary ──────────────────────────────────────────────────────────────
 * This region exists TWICE and is held byte-identical by `control-classes.test.ts`:
 * `store/console/src/lib/control-classes.ts` and `agents/coder/web/src/control-classes.ts`.
 * The two surfaces render on one screen — the console mounts the Coder UI and `index.css`
 * `@source`s its directory — so they must agree about what a button looks like, and they cannot
 * share a module: `store/console` depends on `@proagentstore/coder-web`, so the arrow already
 * points one way, and Tailwind v4 does not scan `node_modules`, which rules out the SDK. The
 * full argument is in the coder-web file's header. Edit one, paste into the other.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

/**
 * On every button regardless of variant.
 *
 * `inline-flex` rather than the browser's `inline-block`: nearly every real button here is an
 * icon beside a label, and every one of those call sites was authoring its own
 * `flex items-center gap-{1,1.5,2}`. `justify-center` is NOT optional with it — a flex box
 * ignores `text-align`, so a `w-full` button without it would left-align its label, which is
 * the regression this line prevents.
 *
 * `disabled:opacity-50` is here rather than at call sites because it was written at only some
 * of them, in three different strengths (30, 40, 50); a disabled control that looks enabled is
 * a defect, not a style choice.
 */
export const BUTTON_BASE = "inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50";

/**
 * Padding + radius + type step + a TARGET FLOOR. Four steps replace 47 shapes.
 *
 * `sm` and `md` differ by a real amount (a dense inline action beside a row of text, versus a
 * form's own buttons), unlike the 2px that separated `px-2.5 py-1.5` from `px-3 py-1.5`.
 * `icon` carries no type step because it holds an icon, not text.
 *
 * ── The `min-h-6 min-w-6` on every step (#389)
 *
 * 24×24 CSS px is WCAG 2.5.8 Target Size (Minimum), Level AA, and it is a FLOOR rather than a
 * resize: every step already renders at or above it today (24 · 30 · 36, and `icon` at 24 with
 * a 12px glyph), so this changes nothing on screen. What it changes is the next control —
 * `icon` with a 10px glyph, or `sm` around a single character, would have gone under without
 * it, and there is no build error for a target that is too small. Padding is the wrong place
 * to express it: padding is a look, a floor is a promise.
 *
 * It is deliberately NOT 44. Every control in this console is 24–38px tall; a 44px box floor
 * would re-lay-out every dense row in the app under cover of an accessibility fix. Where 44
 * is genuinely wanted, `tap-target` in `index.css` gives the reach without the box, and its
 * comment carries the arithmetic for why that expansion is vertical only.
 */
export const BUTTON_SIZE: Record<ButtonSize, string> = {
	sm: "text-xs px-2 py-1 rounded-lg min-h-6 min-w-6",
	md: "text-xs px-3 py-1.5 rounded-lg min-h-6 min-w-6",
	lg: "text-sm px-4 py-2 rounded-lg min-h-6 min-w-6",
	icon: "p-1.5 rounded-lg min-h-6 min-w-6",
};

/**
 * Colour + weight. Four intents, which is what the 266 call sites were reaching for.
 *
 * `primary` gets `hover:bg-accent-hover` — the token exists in `@theme` for exactly this and
 * almost no call site used it, so the app's most prominent control had no hover feedback.
 * `danger` is a bordered red rather than a filled one: every destructive action in this console
 * is a small inline "Delete" next to the thing it deletes, and a filled red block there reads
 * as the primary action of the row.
 */
export const BUTTON_VARIANT: Record<ButtonVariant, string> = {
	primary: "bg-accent text-white font-bold hover:bg-accent-hover",
	secondary: "border border-line text-muted font-semibold hover:border-accent hover:text-accent",
	ghost: "text-muted font-semibold hover:text-ink hover:bg-panel-hover",
	danger: "border border-line text-danger font-semibold hover:bg-danger-soft",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = ""): string {
	return `${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]}${extra ? ` ${extra}` : ""}`;
}
/* ── /vendored:button-vocabulary ─────────────────────────────────────────────────────────── */
