import { describe, expect, it } from "vitest";
import { lineOf, maskComments, scanTags } from "./jsx-tags.js";

/**
 * The unit test the tokenizer never had (#536).
 *
 * Two guards read every `.tsx` in three trees through this module and print exact counts. Until
 * 2026-08-13 nothing tested the lexer itself, and it was one legal character away from measuring
 * less than it printed — which is what it had been doing: no backtick in the delimiter set, so
 * `` setError(`Couldn't remember ${key}`) `` opened a quote state that never closed and the scan
 * ate every tag until the next stray `>`. 33 tags across two of 107 files, and a ratchet pinned
 * at 42 over a tree holding 43.
 *
 * ADR 0002's answer to eight hand-rolled source strippers is that each one carries a test naming
 * what it does and does not handle, until the consolidation happens. This is that test.
 *
 * The apostrophe cases below are the non-vacuity proof. Against the pre-fix lexer the FIRST of
 * them returns 1 tag where it should return 2, and `sees the tag after an apostrophe…` in both
 * consumer suites goes red. Verified by reverting `findTagEnd` to the old quote flag before
 * landing, per ADR 0002 G4.
 */

/** Built by concatenation so this file holds no literal `${` inside a plain string (biome). */
const dollar = "$";

describe("scanTags — the delimiters", () => {
	const names = (src: string) => scanTags(src).map((t) => t.name);

	it("closes a tag at its own `>`", () => {
		expect(names(`<div className="a"><span /></div>`)).toEqual(["div", "span", "div"]);
	});

	it("does not end a tag at a `>` inside an arrow function or a string", () => {
		expect(scanTags(`<button onClick={(e) => go(e)} className="p-1"><X /></button>`)[0].body).toContain("className");
		expect(scanTags(`<input placeholder=">" aria-label="x" />`)[0].body).toContain("aria-label");
	});

	it("treats a backtick as a string delimiter, so an apostrophe inside one is content (#536)", () => {
		// THE regression. Pre-fix this returned one tag: the apostrophe in `agent's` opened a quote
		// state the closing backtick could not clear, and the scan ran on through the </button> and
		// the entire rest of the file.
		const src = ["<button title={`the agent", "'s runner`} className=\"p-2 rounded-lg\">Go</button>\n<input aria-label=\"after\" />"].join("");
		expect(names(src)).toEqual(["button", "button", "input"]);
		expect(scanTags(src)[0].body).toContain("rounded-lg");
	});

	it("survives an apostrophe in a template that also interpolates", () => {
		const src = ["<button title={`Couldn", "'t remember ", dollar, "{key} as your ", dollar, "{noun}`} className=\"p-2 rounded\">x</button>\n<input aria-label=\"after\" />"].join("");
		expect(names(src)).toEqual(["button", "button", "input"]);
	});

	it("honours a backslash escape in every string kind", () => {
		expect(names(`<div title="a \\" b" /><input />`)).toEqual(["div", "input"]);
		expect(names(`<div title='a \\' b' /><input />`)).toEqual(["div", "input"]);
		expect(names(["<div title={`a \\` b`} /><input />"].join(""))).toEqual(["div", "input"]);
	});

	it("re-enters CODE inside an interpolation, which is the third nesting case #536 asked to be decided", () => {
		// An interpolation is code: a quote inside it opens a string, a nested template inside it
		// is a template again, and a `>` inside it is not the end of the tag. Treating a backtick
		// as a plain delimiter — the cheap fix — gets the first case right and this one wrong.
		const nested = ["<button className={`base ", dollar, "{on ? `px-3 ", "rounded-lg` : `it", "'s off`}`}>x</button>\n<input aria-label=\"after\" />"].join("");
		expect(names(nested)).toEqual(["button", "button", "input"]);

		const compare = ["<button className={`", dollar, "{n > 1 ? 'many' : 'one'}`} title=\"t\">x</button>"].join("");
		expect(scanTags(compare)[0].body).toContain('title="t"');
	});

	it("counts a `{` inside an interpolation, so a brace there cannot end the expression early", () => {
		const src = ["<div style={`", dollar, "{fmt({ a: 1 })}`} className=\"c\">x</div>"].join("");
		expect(scanTags(src)[0].body).toContain('className="c"');
	});
});

describe("scanTags — what it reports rather than skips (ADR 0002 G3)", () => {
	it("throws on a tag whose `>` never arrives, instead of dropping it", () => {
		// The `continue` that used to be here is what turned a lexer bug into an under-count: the
		// tag and everything after it left the measurement and every consumer kept printing a
		// confident number.
		expect(() => scanTags(`<button className="p-2"`)).toThrow(/never closed/);
		expect(() => scanTags(`<div title="unterminated`)).toThrow(/ADR 0002 G3/);
	});

	it("names the line and the text, so the failure can be acted on", () => {
		expect(() => scanTags(`\n\n<section data-x={`)).toThrow(/line 3/);
	});
});

describe("scanTags — the shape of what it returns", () => {
	it("marks self-closing and closing tags", () => {
		const [open, selfClosing, close] = scanTags(`<div><br /></div>`);
		expect([open.selfClosing, open.closing]).toEqual([false, false]);
		expect([selfClosing.selfClosing, selfClosing.closing]).toEqual([true, false]);
		expect([close.selfClosing, close.closing]).toEqual([false, true]);
	});

	it("preserves case, because a capitalised name is a component", () => {
		expect(scanTags(`<Button /><button />`).map((t) => t.name)).toEqual(["Button", "button"]);
	});

	it("reports an index that resolves to the source line", () => {
		const src = `\n\n<input />`;
		expect(lineOf(src, scanTags(src)[0].index)).toBe(3);
	});
});

describe("maskComments", () => {
	it("blanks a JSX comment, a leading block comment and a leading line comment", () => {
		expect(scanTags(`{/* <input /> */}`)).toEqual([]);
		expect(scanTags(`/**\n * <textarea />\n */`)).toEqual([]);
		expect(scanTags(`\t// <select />\n`)).toEqual([]);
	});

	it("does not read `//` inside an https URL as a comment", () => {
		expect(scanTags(`<a href="https://x.example"><b /></a>`).map((t) => t.name)).toEqual(["a", "b", "a"]);
	});

	it("keeps every newline, so indices and lines still line up", () => {
		const src = `{/* a\nb */}\n<input />`;
		expect(maskComments(src).split("\n").length).toBe(src.split("\n").length);
		expect(lineOf(src, scanTags(src)[0].index)).toBe(3);
	});
});

describe("what this lexer does NOT handle, stated rather than discovered", () => {
	it("counts a tag written inside a string literal — it does not know where it is", () => {
		// The guards' own fixtures depend on this, and real component source is unaffected. Said
		// out loud because ADR 0002 requires a hand-rolled scanner to name its own limits.
		expect(scanTags(`const s = "<button className='p-2 rounded'>x</button>";`).map((t) => t.name)).toEqual(["button", "button"]);
	});

	it("counts a TypeScript type argument as a tag", () => {
		// `useRef<HTMLButtonElement>(null)` looks exactly like an opening tag to this scanner. It is
		// harmless — every consumer filters by tag NAME — but it is part of what the tag count means.
		expect(scanTags(`const r = useRef<HTMLButtonElement>(null);`).map((t) => t.name)).toEqual(["HTMLButtonElement"]);
	});
});
