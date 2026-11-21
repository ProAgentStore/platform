/**
 * #1338 — the owner's free-text answer box, rendered for real. Layout needs a browser (the mobile Playwright spec measures it); what is
 * pinned here is the contract the markup carries: a multi-line field, a visible Send under it, and no send-on-Enter.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AnswerBox from "./AnswerBox";

const render = (over: Partial<Parameters<typeof AnswerBox>[0]> = {}) =>
	renderToStaticMarkup(createElement(AnswerBox, { value: "", onChange: () => undefined, onSend: () => undefined, saving: false, labelledBy: "q-1", placeholder: "your answer", ...over }));
const src = readFileSync(new URL("./AnswerBox.tsx", import.meta.url), "utf8");
const runDetail = readFileSync(new URL("../pages/RunDetail.tsx", import.meta.url), "utf8");

describe("AnswerBox (#1338)", () => {
	it("is a multi-line textarea at least four lines tall — not the one-line input it replaced", () => {
		const html = render();
		expect(html).toMatch(/<textarea[^>]*rows="4"/);
		expect(html).not.toContain("<input");
		expect(html).toContain("min-h-28"); // 7rem = 112px
		// 16px text: a smaller font makes iOS zoom the page when the box is focused.
		expect(html).toMatch(/<textarea[^>]*class="[^"]*text-base/);
	});

	it("is labelled by the agent's question, and says its return key makes a new line", () => {
		const html = render();
		expect(html).toContain('aria-labelledby="q-1"');
		expect(html).toMatch(/enterkeyhint="enter"/i);
	});

	it("puts a visible Send BELOW the box, full width on a phone, and disables it for an empty answer", () => {
		const html = render();
		expect(html.indexOf("<textarea")).toBeLessThan(html.indexOf("<button"));
		expect(html).toMatch(/<button[^>]*class="[^"]*w-full[^"]*"[^>]*data-testid="answer-send"|<button[^>]*data-testid="answer-send"[^>]*class="[^"]*w-full/);
		expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Send<\/button>/);
		expect(render({ value: "   " })).toMatch(/<button[^>]*\sdisabled=""/);
		expect(render({ value: "my legal name" })).not.toMatch(/<button[^>]*\sdisabled=""/);
	});

	it("keeps the draft in the field as typed, multi-line", () => {
		expect(render({ value: "line one\nline two" })).toContain("line one\nline two</textarea>");
	});

	it("while saving: read-only (text stays selectable, focus kept), busy, and Send says Saving…, disabled", () => {
		const html = render({ value: "x", saving: true });
		expect(html).toMatch(/<textarea[^>]*readonly/i);
		expect(html).toContain('aria-busy="true"');
		expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Saving…<\/button>/);
	});

	it("never sends on a key press: Enter is a newline (the owner decided on a dedicated Send button)", () => {
		expect(src).not.toMatch(/onKeyDown|onKeyPress|onKeyUp|e\.key\s*===\s*"Enter"/);
		expect(runDetail).not.toMatch(/key === "Enter"\) sendValue/);
		expect(runDetail).toMatch(/<AnswerBox [^>]*onSend=\{\(\) => sendValue\(inputVal\)\}/);
	});
});
