import { describe, expect, it } from "vitest";
import { renderTerminal, terminalTail } from "./terminal-render.js";

describe("renderTerminal — escaping (output goes through dangerouslySetInnerHTML)", () => {
	it("escapes a line that STARTS WITH <code — the injection the old version allowed", () => {
		// The original skipped escaping for any line starting with "<code", to avoid re-escaping
		// its own generated JSON blocks. Engine output is not trusted: a coding agent reads
		// repository files, so this line was injected verbatim into the console origin.
		const out = renderTerminal('<code><img src=x onerror=alert(1)>');
		expect(out).not.toContain("<img");
		expect(out).toContain("&lt;img");
	});

	it("escapes ordinary markup anywhere in a line", () => {
		const out = renderTerminal('hello <script>alert(1)</script>');
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;");
	});

	it("escapes markup inside a prompt/error/tool line too", () => {
		for (const prefix of ["❯ ", "Error: ", "⚙ ", "↳ ", "✓ ", "- "]) {
			expect(renderTerminal(`${prefix}<b>x</b>`)).not.toContain("<b>");
		}
	});

	it("escapes ampersands so entities cannot be smuggled", () => {
		expect(renderTerminal("a &lt;b&gt; c")).toContain("&amp;lt;");
	});

	it("does not let raw input forge the internal block marker", () => {
		// A FIXED marker is forgeable: input spelling it renders into the same wrapper the
		// re-insertion regex looks for, so a crafted line could delete itself or swap in
		// another block. The marker carries a per-call nonce, so input survives as text.
		const out = renderTerminal(" TERMBLOCK-0-0 ");
		expect(out).toContain("TERMBLOCK-0-0");
	});
});

describe("renderTerminal — formatting", () => {
	it("pretty-prints a standalone JSON block", () => {
		const out = renderTerminal('{"a":1}');
		expect(out).toContain("<code");
		expect(out).toContain('"a"');
	});

	it("escapes markup INSIDE a JSON block", () => {
		const out = renderTerminal(JSON.stringify({ x: "<img src=x>" }));
		expect(out).not.toContain("<img");
	});

	it("leaves a malformed JSON-looking line on the normal escaped path", () => {
		const out = renderTerminal("{not json <b>");
		expect(out).not.toContain("<b>");
		expect(out).toContain("&lt;b&gt;");
	});

	it("tints by line kind", () => {
		expect(renderTerminal("❯ run tests")).toContain("#67e8f9");
		expect(renderTerminal("Error: nope")).toContain("#f87171");
		expect(renderTerminal("✓ done")).toContain("#4ade80");
		expect(renderTerminal("plain")).toContain("#d6d6e0");
	});

	it("renders inline bold and code", () => {
		expect(renderTerminal("a **b** c")).toContain("<strong>b</strong>");
		expect(renderTerminal("a `x` c")).toContain("<code style=");
	});

	it("handles empty and nullish input without throwing", () => {
		expect(renderTerminal("")).toBe('<span style="color:#d6d6e0"></span>');
		expect(() => renderTerminal(undefined as never)).not.toThrow();
	});
});

describe("terminalTail", () => {
	it("keeps the END, which is where the latest output is", () => {
		expect(terminalTail("abcdef", 3)).toBe("def");
	});

	it("returns short input unchanged", () => {
		expect(terminalTail("ab", 400)).toBe("ab");
	});

	it("is plain text — never HTML", () => {
		expect(terminalTail("<b>x</b>")).toBe("<b>x</b>");
	});
});
