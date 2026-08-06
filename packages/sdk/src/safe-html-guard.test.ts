/**
 * The regression guard for #297: raw-HTML injection has exactly ONE door, and one mint.
 *
 * WHY A SCANNER. The 2026-07 audit found a real stored-XSS in `renderTerminal` — a branch that
 * returned engine output UNESCAPED when the line looked like generated markup, injected straight
 * into the console origin where the viewer's session token and BYOK provider keys live. The fix
 * was correct and changed nothing structural: nine call sites still each wrote their own
 * `dangerouslySetInnerHTML={{ __html: f(x) }}` and were safe only because each remembered to name
 * the right `f`. Nine chances to get it wrong, and no signal when a tenth appeared.
 *
 * So the boundary is now typed (`SafeHtml`, mintable only by an escaping renderer) AND counted.
 * The type stops a plain string reaching the sink; this file stops someone routing around the
 * type by opening a new sink next to it. Both are needed — a brand with nine unguarded sinks is
 * decoration.
 *
 * WHY THE LEXER. Five of the eight textual matches for `dangerouslySetInnerHTML` in this repo are
 * PROSE — header comments explaining the escaping rule, and the `Omit<…, "dangerouslySetInnerHTML">`
 * string literal in the boundary's own props type. A grep-based version of this guard reports all
 * of them, and a guard that cries wolf gets deleted. Everything below runs over source with
 * comments, string literals and regex literals blanked (`workers/api/src/lib/source-guard.ts`,
 * the same lexer #306's security invariants use).
 *
 * HOW TO ADD AN EXCEPTION: extend the allowlist below WITH A REASON. The assertions compare the
 * offender set EXACTLY, so removing a sink fails too — the list can only change deliberately.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { findCalls, matchLines, stripCommentsAndLiterals } from "../../../workers/api/src/lib/source-guard.js";
import { renderMd } from "./ui.js";
import { SafeHtmlView } from "./ui-react.js";

const REPO = resolve(__dirname, "../../..");

/**
 * Every front-end tree that renders agent-influenced text into a browser origin.
 *
 * `workers/` is deliberately absent: it produces HTML strings server-side (`workers/host`), which
 * is a different problem with different tools, and sweeping it in would mean allowlisting a
 * template engine's worth of legitimate string concatenation until the guard said nothing.
 */
const TREES = ["packages/sdk/src", "store/console/src", "store/admin/src", "agents/coder/web/src"];

interface Source {
	/** Path relative to the repo root, e.g. "store/console/src/tabs/TmuxTab.tsx". */
	rel: string;
	/** Comments, string literals and regex literals blanked; line numbers preserved. */
	code: string;
}

function sources(): Source[] {
	const out: Source[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			if (!/\.tsx?$/.test(p) || /\.test\.tsx?$/.test(p) || p.endsWith(".d.ts")) continue;
			out.push({ rel: relative(REPO, p), code: stripCommentsAndLiterals(readFileSync(p, "utf-8")) });
		}
	};
	for (const t of TREES) walk(join(REPO, t));
	return out;
}

const ALL = sources();

/**
 * Every way a browser turns a string into live markup.
 *
 * `innerHTML`/`outerHTML` are matched only as ASSIGNMENTS whose right-hand side is not the empty
 * string — `el.innerHTML = ""` is how `DynamicSurface` clears a surface bundle's subtree on
 * unmount, which injects nothing and is the normal way to do that. Reading `.innerHTML` is not a
 * sink either.
 *
 * The exemption is spelled as "the RHS starts with something that is not an empty literal"
 * (`["'][^"']` | a non-quote token) rather than the obvious `=\s*(?!["']["'])`. That obvious form
 * silently matches EVERYTHING: `\s*` backtracks to zero width, the lookahead is then evaluated at
 * the space before the quote, and passes. It is a trap worth naming because the guard still looks
 * correct while reporting the very line it was written to exempt.
 */
const SINKS: [label: string, re: RegExp][] = [
	["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
	["innerHTML/outerHTML assignment", /\.(?:inner|outer)HTML\s*=[ \t]*(?:["'][^"']|[^\s"';])/],
	["insertAdjacentHTML", /insertAdjacentHTML\s*\(/],
	["document.write", /document\s*\.\s*write(?:ln)?\s*\(/],
];

/** Files allowed to contain a raw-HTML sink, and why. */
const SINK_ALLOWED: Record<string, string> = {
	"packages/sdk/src/ui-react.ts": "SafeHtmlView — THE boundary. Takes only branded SafeHtml; every other surface renders through it.",
};

/** Files allowed to call `sanitizedHtml`, the mint, and why. */
const MINT_ALLOWED: Record<string, string> = {
	"packages/sdk/src/safe-html.ts": "declares it (the `export function` header matches a call)",
	"packages/sdk/src/ui.ts": "renderMd / mdLite / renderJson — escape the entire input, then add only markup written here",
	"packages/sdk/src/terminal-render.ts": "renderTerminal — escapes every byte; generated blocks are re-inserted only after escaping",
};

const listing = (hits: { rel: string; line: number; excerpt: string }[]) => hits.map((h) => `  ${h.rel}:${h.line}  ${h.excerpt}`).join("\n") || "  (none)";

describe("raw HTML has exactly one door (#297)", () => {
	const sinkHits = ALL.flatMap((s) => SINKS.flatMap(([label, re]) => matchLines(s.code, re).map((h) => ({ rel: s.rel, line: h.line, excerpt: `${label}: ${h.excerpt}` }))));

	it("finds the sink at all — the guard is pointed at real code", () => {
		// Without this, deleting SafeHtmlView (or mis-typing a tree path) turns every assertion
		// below into a vacuous pass over an empty file list.
		expect(ALL.length).toBeGreaterThan(100);
		expect(sinkHits.length).toBeGreaterThan(0);
	});

	it("no file outside the SafeHtmlView boundary writes raw HTML", () => {
		const offenders = [...new Set(sinkHits.map((h) => h.rel))].sort();
		expect(
			offenders,
			`raw-HTML sinks outside the boundary:\n${listing(sinkHits.filter((h) => !(h.rel in SINK_ALLOWED)))}\n\nRender it through <SafeHtmlView html={renderMd(x)} /> from @proagentstore/sdk/ui-react. If this genuinely cannot go through the boundary, add the file to SINK_ALLOWED with a reason.`,
		).toEqual(Object.keys(SINK_ALLOWED).sort());
	});

	it("reports an innerHTML write but not the clear-the-subtree idiom", () => {
		// Both halves matter. Dropping the exemption reports `DynamicSurface`'s unmount cleanup —
		// a false positive in the guard's very first real run, which is how guards get muted.
		// Dropping the match reports nothing at all, which is worse and looks identical.
		const sink = SINKS.find(([label]) => label.startsWith("innerHTML"))?.[1] as RegExp;
		expect(matchLines(stripCommentsAndLiterals(`el.innerHTML = html;`), sink)).toHaveLength(1);
		expect(matchLines(stripCommentsAndLiterals(`el.innerHTML = "<b>" + name;`), sink)).toHaveLength(1);
		expect(matchLines(stripCommentsAndLiterals(`if (ref.current) ref.current.innerHTML = "";`), sink)).toHaveLength(0);
		expect(matchLines(stripCommentsAndLiterals(`el.innerHTML = '';`), sink)).toHaveLength(0);
		expect(matchLines(stripCommentsAndLiterals(`const snapshot = el.innerHTML;`), sink)).toHaveLength(0);
	});

	it("the boundary still contains the one sink it is allowed", () => {
		// The other half of an exact comparison: an allowlist entry for a file that no longer has
		// a sink is a stale blessing, and the next file to take that path inherits it.
		for (const rel of Object.keys(SINK_ALLOWED)) {
			expect(sinkHits.some((h) => h.rel === rel), `${rel} is allowlisted as the sink but no longer contains one — delete the entry`).toBe(true);
		}
	});
});

describe("SafeHtml is minted only by a renderer that escapes (#297)", () => {
	const mintHits = ALL.flatMap((s) => findCalls(s.code, "sanitizedHtml").map((h) => ({ rel: s.rel, line: h.line, excerpt: h.excerpt })));

	it("only the approved renderers assert safety", () => {
		const callers = [...new Set(mintHits.map((h) => h.rel))].sort();
		expect(
			callers,
			`unapproved sanitizedHtml() callers:\n${listing(mintHits.filter((h) => !(h.rel in MINT_ALLOWED)))}\n\nsanitizedHtml() is a CLAIM that the string was escaped by its producer. Do not call it on a value from outside the process — escape it, or render it as text.`,
		).toEqual(Object.keys(MINT_ALLOWED).sort());
	});

	it("every approved minter still mints", () => {
		for (const rel of Object.keys(MINT_ALLOWED)) {
			expect(mintHits.some((h) => h.rel === rel), `${rel} is allowlisted as a minter but no longer calls sanitizedHtml — delete the entry`).toBe(true);
		}
	});
});

describe("SafeHtmlView", () => {
	it("passes the branded html straight through to the sink", () => {
		// The boundary must not transform: renderMd already decided what is safe, and a second
		// pass here would either double-escape (breaking every rendered message) or invent a
		// second, weaker sanitiser to disagree with the first.
		const html = renderMd("**hi**");
		const el = createElement(SafeHtmlView, { html }) as { props: { html: string } };
		expect(el.props.html).toBe(html);
	});

	it("escapes tag injection end-to-end — a raw <img onerror> never reaches the sink as markup", () => {
		// The 2026-07 finding, asserted at the boundary rather than only inside the renderer.
		const rendered = renderMd('<img src=x onerror="alert(1)">');
		expect(rendered).not.toContain("<img");
		expect(rendered).toContain("&lt;img");
	});
});
