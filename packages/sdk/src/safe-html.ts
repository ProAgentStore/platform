/**
 * The ONE boundary between "a string" and "HTML this app will inject into its own origin" (#297).
 *
 * WHY THIS EXISTS, with the evidence. `renderMd` shipped correct, and then a later edit added a
 * branch that returned a line UNESCAPED when it looked like generated markup — engine output
 * beginning `<code><img src=x onerror=…>` went verbatim into the console origin, where the page
 * holds the viewer's session token and their BYOK provider keys. That was fixed (2026-07 audit).
 * The reason it is worth building a type for is that nothing about the FIX made the next one
 * harder: every call site was still `dangerouslySetInnerHTML={{ __html: someFunction(x) }}`, and
 * the only thing standing between an attacker and the origin was that each of nine call sites
 * remembered to name the right function.
 *
 * WHAT THE BRAND BUYS, stated honestly. `SafeHtml` is a nominal type over `string`, so:
 *
 *   • A plain `string` — an API field, an LLM reply, a repo file, a form value — CANNOT be passed
 *     to the sink. `<SafeHtmlView html={m.content} />` is a compile error. That is the whole
 *     point, and it is checked by the compiler on every build rather than by a reviewer.
 *   • A `SafeHtml` IS a string, so it flows through `typeof renderMd` signatures, joins, and the
 *     surface-bundle SDK without a cast at any of those points.
 *
 * It does NOT make sanitisation correct — `sanitizedHtml()` is an assertion, and a renderer that
 * escapes badly still produces a `SafeHtml`. What it does is reduce "is this app XSS-safe?" from
 * a question about every call site to a question about the two functions that call
 * `sanitizedHtml`, which is a question a person can actually answer. `safe-html-guard.test.ts`
 * asserts that set stays at two, and that the sink stays at one.
 */

declare const SAFE_HTML: unique symbol;

/**
 * HTML that a renderer has already escaped and is cleared for injection.
 *
 * Structurally a `string` at runtime — the brand exists only in the type system, so there is no
 * wrapper object, no unwrapping at the sink, and no cost.
 */
export type SafeHtml = string & { readonly [SAFE_HTML]: true };

/**
 * Assert that `html` has been escaped by its producer. THE ONLY MINT.
 *
 * Deliberately not called `asSafeHtml` or `castHtml`: the name has to read like a claim someone
 * is making, because that is what it is. Call it only from a renderer that escapes EVERY byte of
 * its input up front and then adds markup it wrote itself — the shape `renderMd` and
 * `renderTerminal` both use. Never call it on a value that came from outside the process.
 *
 * The guard test enumerates its callers by scanning source, so a third one is a failing test
 * rather than a code review someone has to be lucky at.
 */
export function sanitizedHtml(html: string): SafeHtml {
	return html as SafeHtml;
}

/** Nothing to render. Saves a `sanitizedHtml("")` (which the guard would report) at call sites. */
export const EMPTY_HTML: SafeHtml = "" as SafeHtml;
