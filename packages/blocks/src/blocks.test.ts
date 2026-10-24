/**
 * #187 — the first blocks lifted out of the console and the Coder UI. Each test pins what the
 * copies it replaced did, so the extraction is a move, not a change:
 *
 *  - `timeAgo` is the three identical formatters, boundary for boundary;
 *  - `TerminalPane` colorizes through the SDK's escaping renderer into a `<pre>`, passes the
 *    caller's layout straight through, and never lets raw markup from a pane through;
 *  - `CopyButton` keeps each original's visibility, and the shared box/ARIA/guard hooks.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyButton, MessageHeader, TerminalPane, timeAgo } from "./index";

describe("timeAgo", () => {
	const NOW = Date.parse("2026-10-14T12:00:00Z");
	const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

	it.each([
		[0, "just now"],
		[59, "just now"],
		[60, "1m ago"],
		[3599, "59m ago"],
		[3600, "1h ago"],
		[86_399, "23h ago"],
		[86_400, "1d ago"],
		[40 * 86_400, "40d ago"], // never switches to a calendar date, unlike the SDK's formatTime
	])("%ss ago → %s", (s, label) => {
		expect(timeAgo(at(s), NOW)).toBe(label);
	});

	it("a clock slightly ahead reads 'just now', and missing or unparseable input is blank", () => {
		expect(timeAgo(new Date(NOW + 30_000).toISOString(), NOW)).toBe("just now");
		expect(timeAgo(undefined, NOW)).toBe("");
		expect(timeAgo("", NOW)).toBe("");
		expect(timeAgo("not a date", NOW)).toBe("");
	});
});

describe("TerminalPane", () => {
	it("renders the pane in a <pre> with the caller's classes and style", () => {
		const html = renderToStaticMarkup(createElement(TerminalPane, { text: "$ ls\nREADME.md", className: "pane-x", style: { whiteSpace: "pre-wrap" } }));
		expect(html.startsWith('<pre class="pane-x" style="white-space:pre-wrap">')).toBe(true);
		expect(html).toContain("README.md");
	});

	it("escapes markup from the pane — engine output is untrusted", () => {
		const html = renderToStaticMarkup(createElement(TerminalPane, { text: "<code><img src=x onerror=alert(1)>" }));
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("tailChars previews only the end of a long pane", () => {
		const text = `${"old line\n".repeat(200)}latest`;
		const html = renderToStaticMarkup(createElement(TerminalPane, { text, tailChars: 20 }));
		expect(html).toContain("latest");
		expect((html.match(/old line/g) ?? []).length).toBeLessThan(3);
		expect((renderToStaticMarkup(createElement(TerminalPane, { text })).match(/old line/g) ?? []).length).toBe(200);
	});
});

describe("CopyButton", () => {
	const render = (reveal: "hover" | "hover-from-sm") => renderToStaticMarkup(createElement(CopyButton, { text: "hello", reveal }));

	it("console chat (`hover`): hidden until the bubble is hovered, at every width", () => {
		const html = render("hover");
		expect(html).toContain("opacity-0 group-hover:opacity-100");
		expect(html).not.toContain("sm:opacity-0");
	});

	it("Co-pilot (`hover-from-sm`): always visible on a phone, hover-revealed from sm up", () => {
		const html = render("hover-from-sm");
		expect(html).toContain("opacity-100 sm:opacity-0 sm:group-hover:opacity-100");
	});

	it("both keep the shared box, label, tap target and the overlap guard's hook", () => {
		for (const html of [render("hover"), render("hover-from-sm")]) {
			expect(html).toContain('data-msg-action="copy"');
			expect(html).toContain('aria-label="Copy message"');
			expect(html).toContain('title="Copy"');
			expect(html).toMatch(/class="tap-target absolute top-1 right-1\.5 .* p-1 rounded bg-black\/40 text-muted hover:text-accent transition-opacity"/);
		}
	});
});

describe("MessageHeader", () => {
	const html = (props: Parameters<typeof MessageHeader>[0]) => renderToStaticMarkup(createElement(MessageHeader, props));

	it("user: dim strip, label, stamp — and no play button without a recording", () => {
		const out = html({ speaker: "user", label: "You", stamp: "Oct 14, 9:00", stampTitle: "full time" });
		expect(out).toContain("text-2xs opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3 pr-12 sm:pr-0");
		expect(out).toContain("You");
		expect(out).not.toContain("<button");
		expect(out).toContain('data-msg-stamp="true" title="full time" class="font-normal opacity-80 text-right"');
	});

	it("assistant: accent strip, play button with title/ARIA, muted stamp", () => {
		const out = html({
			speaker: "assistant",
			label: "Assistant",
			onPlay: () => {},
			playTitle: "Play this message",
			playAriaLabel: "Play this message",
			stamp: "now",
		});
		expect(out).toContain("text-2xs text-accent mb-0.5");
		expect(out).toContain('title="Play this message" aria-label="Play this message"');
		expect(out).toContain("tap-target min-w-6 inline-flex justify-center opacity-70 hover:opacity-100");
		expect(out).toContain("font-normal text-muted text-right");
	});

	it("omits the stamp span when there is no time", () => {
		expect(html({ speaker: "assistant", label: "Co-pilot" })).not.toContain("data-msg-stamp");
	});
});
