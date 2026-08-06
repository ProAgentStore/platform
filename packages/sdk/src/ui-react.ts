// @proagentstore/sdk/ui-react — the React half of the UI helpers.
//
// Split from `./ui` rather than added to it. `ui.ts` is imported by things that have no React
// (and, historically in this ecosystem, a barrel that quietly pulled React in was a real bug —
// see the FAS SDK's React-free-barrel rule). Everything here needs React; everything there does
// not. One subpath each keeps that true by construction instead of by care.

import { createElement, type HTMLAttributes, type ReactElement, type Ref } from "react";
import type { SafeHtml } from "./safe-html.js";

export { EMPTY_HTML, sanitizedHtml, type SafeHtml } from "./safe-html.js";

/** The elements a rendered block is ever mounted into. A closed set — see the note below. */
export type SafeHtmlTag = "div" | "span" | "p" | "pre" | "code";

export type SafeHtmlViewProps<E extends HTMLElement> = Omit<HTMLAttributes<E>, "dangerouslySetInnerHTML" | "children"> & {
	/** Escaped markup from an approved renderer. A plain `string` will not typecheck. */
	html: SafeHtml;
	/** Element to mount into. Defaults to `div`. */
	as?: SafeHtmlTag;
	ref?: Ref<E>;
};

/**
 * THE ONLY `dangerouslySetInnerHTML` in the product. Everything else renders through here.
 *
 * There is nothing clever in the body — the value is entirely in the two constraints around it:
 *
 *   1. `html` is `SafeHtml`, so a caller cannot reach this sink with an unescaped string. The
 *      compiler enforces that, on every build, for every call site that exists or will exist.
 *   2. `safe-html-guard.test.ts` asserts that no OTHER file in the console, the admin, the agent
 *      UIs or this package writes to `dangerouslySetInnerHTML` / `innerHTML` / `outerHTML` /
 *      `insertAdjacentHTML`. Adding a tenth ad-hoc sink is a failing test, not a review miss.
 *
 * `as` is a closed union rather than `keyof JSX.IntrinsicElements` on purpose: the point of a
 * boundary is that you can enumerate what passes through it, and "any tag the caller names" puts
 * `<iframe>`, `<object>` and `<script>` back in scope for no benefit — every real call site is
 * one of five block/inline containers.
 *
 * Written with `createElement` rather than JSX so this module stays a plain `.ts` and the SDK's
 * `tsc` build needs no JSX configuration for one element.
 */
export function SafeHtmlView<E extends HTMLElement = HTMLDivElement>({ html, as = "div", ...rest }: SafeHtmlViewProps<E>): ReactElement {
	// THE reviewed boundary. `html` is branded SafeHtml — mintable only by an escaping renderer
	// (safe-html.ts) — and safe-html-guard.test.ts keeps this the only sink in the repo. (No
	// biome suppression: `noDangerouslySetInnerHtml` matches JSX, and this is `createElement`,
	// which is exactly why the guard is a source scan and not a lint rule.)
	return createElement(as, { ...rest, dangerouslySetInnerHTML: { __html: html as string } });
}
