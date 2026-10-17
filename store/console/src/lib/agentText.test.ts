/** #1129 — agent text renders as markdown, and a question's options always become buttons. */
import { describe, expect, it } from "vitest";
import { renderMd } from "@proagentstore/sdk/ui";
import { plainMarkdown, questionOptions, splitInlineNumberedList, whyWithoutOptions } from "./agentText";

describe("splitInlineNumberedList (#1129)", () => {
	it("puts an inline 1. 2. 3. sequence on its own lines, so it renders as a list", () => {
		const q = "Three decisions: 1. **Notification channel** email or push? 2. **Threshold** 90%? 3. Retry automatically?";
		const split = splitInlineNumberedList(q);
		expect(split).toBe("Three decisions:\n\n1. **Notification channel** email or push?\n2. **Threshold** 90%?\n3. Retry automatically?");
		expect(String(renderMd(split))).toContain("<ol><li><strong>Notification channel</strong> email or push?</li><li><strong>Threshold</strong> 90%?</li><li>Retry automatically?</li></ol>");
	});

	it("leaves a lone number, an out-of-order one, and an already-split list alone", () => {
		for (const t of ["Upgrade to version 2. Then restart.", "Step 3. only", "1. one", "a\n1. one\n2. two"]) expect(splitInlineNumberedList(t)).toBe(t);
		expect(splitInlineNumberedList("Pick: 1) yes 2) no")).toBe("Pick:\n\n1) yes\n2) no");
	});
});

describe("questionOptions (#1129)", () => {
	it("prefers the structured options — including ones with commas and long ones the text parse lost", () => {
		const long = "Use the platform default notification channel, which is email to the owner, and nothing else";
		expect(questionOptions({ options: ["Email, then push", long, " SMS "] }, "(why — from: Email, then push, SMS)")).toEqual(["Email, then push", long, "SMS"]);
	});

	it("falls back to the `from:` text only for an older event, and returns none when there are none", () => {
		expect(questionOptions(undefined, "the salary range — from: 100k, 120k, 140k")).toEqual(["100k", "120k", "140k"]);
		expect(questionOptions({ options: [] }, "what is your legal name?")).toEqual([]);
	});

	it("whyWithoutOptions drops the options list the text carries for older consoles", () => {
		expect(whyWithoutOptions("needed for the form — from: a, b")).toBe("needed for the form");
		expect(whyWithoutOptions("from: a, b")).toBe("");
	});
});

describe("plainMarkdown — a one-line preview without raw markers (#1129)", () => {
	it("drops bold, code, heading and link markup, keeps the words", () => {
		expect(plainMarkdown("**Notification channel** — use `email`, see [docs](https://x.example/a)")).toBe("Notification channel — use email, see docs");
		expect(plainMarkdown("## Heading\n- item")).toBe("Heading\n• item");
		expect(plainMarkdown("a * b * c")).toBe("a * b * c");
	});
});
