/**
 * The console's atomic shape vocabulary: what a button, a card and a badge LOOK like (#366).
 *
 * ── What was measured, on 2026-08-08, before any of this was written
 *
 * 266 `<button>` elements across `store/console/src` in 47 distinct padding+radius shapes.
 * The three biggest were `px-3 py-1.5 rounded-lg` (58), `px-2 py-1 rounded` (23) and
 * `px-2.5 py-1.5 rounded-lg` (22) — the first and third differ by 2px of horizontal padding
 * and nothing else. Nobody chose that difference 22 times; it was copied from whichever
 * neighbour was nearest. Cards were three geometries over 78 panels: `rounded-xl p-3 sm:p-4`
 * (34), `rounded-xl p-4` (18), `rounded-lg p-3` (15) — so whether a card's padding responded
 * to the viewport depended on which file you were in.
 *
 * ── Why a table and not a component with ternaries
 *
 * These are DATA. A `variant === "primary" ? … : variant === "danger" ? …` chain cannot be
 * enumerated, cannot be tested for the property that actually matters (every variant produces
 * exactly one font-weight, exactly one radius), and grows a fifteenth shape the same way the
 * call sites did. A record can be iterated by a test; a ternary can only be read.
 *
 * ── Why the strings are whole and literal
 *
 * Tailwind v4 finds classes by scanning source text. `` `rounded-${size}` `` generates nothing
 * — the same silent-nothing failure mode as a dead colour token (`DESIGN-SYSTEM.md` §1), with
 * no error at build time. Every utility below is written out in full for that reason; see
 * `components/Page.tsx`, which learned it first.
 *
 * ── The conventions these encode, from DESIGN-SYSTEM.md §3
 *
 *  - `rounded-lg` for controls, `rounded-xl` for cards, `rounded-full` for pills. Bare
 *    `rounded` on a control is older code, and the 23 sites that had it are folded in here.
 *  - Nothing a user reads is below `text-xs` (12px). The smallest step below is `text-[0.7rem]`
 *    = 11.2px, used 110 times, including for button labels and descriptive copy.
 */

import { INTENT_CLASS, type StatusIntent } from "./statusBadge";

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
 * Padding + radius + type step. Four steps replace 47 shapes.
 *
 * `sm` and `md` differ by a real amount (a dense inline action beside a row of text, versus a
 * form's own buttons), unlike the 2px that separated `px-2.5 py-1.5` from `px-3 py-1.5`.
 * `icon` carries no type step because it holds an icon, not text.
 */
export const BUTTON_SIZE: Record<ButtonSize, string> = {
	sm: "text-xs px-2 py-1 rounded-lg",
	md: "text-xs px-3 py-1.5 rounded-lg",
	lg: "text-sm px-4 py-2 rounded-lg",
	icon: "p-1.5 rounded-lg",
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
	danger: "border border-line text-red font-semibold hover:bg-red/10",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = ""): string {
	return `${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]}${extra ? ` ${extra}` : ""}`;
}

/**
 * ONE card geometry, with the responsive padding as the default rather than as one of three.
 *
 * `tone` is colour, not geometry: `panel` is a card on the page, `paper` is a card nested
 * INSIDE a panel (a board item inside a column), where the same fill would disappear. Adding a
 * padding prop here would re-open exactly the three-geometry drift this replaces.
 */
export type CardTone = "panel" | "paper";

export const CARD_TONE: Record<CardTone, string> = {
	panel: "bg-panel border border-line",
	paper: "bg-paper border border-line",
};

export const CARD_GEOMETRY = "rounded-xl p-3 sm:p-4";

export function cardClass(tone: CardTone = "panel", extra = ""): string {
	return `${CARD_TONE[tone]} ${CARD_GEOMETRY}${extra ? ` ${extra}` : ""}`;
}

/**
 * Status pills. The tone vocabulary is `statusBadge.ts`'s existing intent layer, imported
 * rather than restated — #368 refused to invent a third status vocabulary and this would have
 * been the fourth.
 */
export const BADGE_BASE = "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium";

export function badgeClass(tone: StatusIntent = "neutral", extra = ""): string {
	return `${BADGE_BASE} ${INTENT_CLASS[tone]}${extra ? ` ${extra}` : ""}`;
}
