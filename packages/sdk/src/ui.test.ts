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

describe("renderMd YouTube embeds", () => {
	it("renders a bare watch URL as a playable youtube-nocookie iframe with a fallback link", () => {
		const out = renderMd("check this: https://www.youtube.com/watch?v=0WkCQZd113Y");
		expect(out).toContain('<iframe src="https://www.youtube-nocookie.com/embed/0WkCQZd113Y"');
		expect(out).toContain('href="https://www.youtube.com/watch?v=0WkCQZd113Y"');
	});

	it("renders youtu.be and shorts URLs as embeds", () => {
		expect(renderMd("https://youtu.be/0WkCQZd113Y")).toContain("youtube-nocookie.com/embed/0WkCQZd113Y");
		expect(renderMd("https://www.youtube.com/shorts/0WkCQZd113Y")).toContain("youtube-nocookie.com/embed/0WkCQZd113Y");
	});

	it("never lets URL junk past the validated video id into the iframe src", () => {
		const out = renderMd('https://www.youtube.com/watch?v=0WkCQZd113Y&t=1"><script>alert(1)</script>');
		expect(out).toContain('embed/0WkCQZd113Y"');
		expect(out).not.toContain("<script>");
	});

	it("leaves non-YouTube URLs as plain links", () => {
		const out = renderMd("https://example.com/watch?v=0WkCQZd113Y");
		expect(out).not.toContain("iframe");
		expect(out).toContain("<a href=");
	});

	it("does not break markdown-style YouTube links — renders them as normal links", () => {
		const out = renderMd("[Fable 5 demo](https://www.youtube.com/watch?v=0WkCQZd113Y)");
		expect(out).toContain('<a href="https://www.youtube.com/watch?v=0WkCQZd113Y"');
		expect(out).toContain("Fable 5 demo");
		expect(out).not.toContain("@@YT_EMBED");
	});
});
