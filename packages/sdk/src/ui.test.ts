import { describe, expect, it } from "vitest";
import { renderMd } from "./ui.js";

describe("renderMd link rendering (XSS hardening)", () => {
	it("neutralizes a quote-breakout event-handler injection in a markdown link", () => {
		const out = renderMd('[click me](https://x.com/" onmouseover="alert(document.cookie))');
		// The double-quote that would close the href attribute must be encoded, so
		// no live `onmouseover="` attribute can appear on the anchor.
		expect(out).not.toMatch(/onmouseover="/);
		expect(out).toContain("&quot;");
	});

	it("still renders a normal link and preserves query-string ampersands (no double-escape)", () => {
		const out = renderMd("see [docs](https://x.com/a?b=1&c=2)");
		expect(out).toContain('href="https://x.com/a?b=1&amp;c=2"');
		expect(out).not.toContain("&amp;amp;");
	});

	it("escapes raw HTML so tag injection can't execute", () => {
		const out = renderMd('<img src=x onerror="alert(1)">');
		expect(out).not.toContain("<img");
		expect(out).toContain("&lt;img");
	});
});
