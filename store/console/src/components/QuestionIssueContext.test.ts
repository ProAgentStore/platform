import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuestionIssueContext, { resolveQuestionIssue } from "./QuestionIssueContext";

const issue = {
	repo: "ProAgentStore/platform",
	number: 1349,
	title: "Page GitHub workflow and commit-range evidence safely",
	url: "https://github.com/ProAgentStore/platform/issues/1349",
	summary: "Read every page of the release evidence before posting.",
};

describe("coding question issue context", () => {
	it("shows the linked issue, title, and summary from structured event metadata", () => {
		const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue(issue, null) }));
		expect(html).toContain('href="https://github.com/ProAgentStore/platform/issues/1349"');
		expect(html).toContain("ProAgentStore/platform#1349");
		expect(html).toContain(issue.title);
		expect(html).toContain(issue.summary);
		expect(html).toContain("Read the full issue and comments");
	});

	it("uses the board's cached issue for a question already parked before metadata shipped", () => {
		const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue(undefined, issue) }));
		expect(html).toContain('href="https://github.com/ProAgentStore/platform/issues/1349"');
	});

	it("rejects untrusted or mismatched URLs and leaves unrelated questions without an issue link", () => {
		const wrongRepo = { ...issue, repo: "someone/other" };
		const wrongNumber = { ...issue, url: "https://github.com/ProAgentStore/platform/issues/1350" };
		const fakeGitHub = { ...issue, url: "https://github.com.evil.example/ProAgentStore/platform/issues/1349" };
		for (const source of [wrongRepo, wrongNumber, fakeGitHub, { ...issue, url: "javascript:alert(1)" }]) {
			const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue(source, null) }));
			expect(html).toBe("");
		}
		expect(resolveQuestionIssue({ question: "Issue #1349 item 6" }, null)).toBeNull();
	});

	it("prefers the question's exact issue over an older board card", () => {
		const older = { ...issue, number: 100, title: "Old issue", url: "https://github.com/ProAgentStore/platform/issues/100" };
		expect(resolveQuestionIssue(issue, older)?.number).toBe(1349);
	});

	it("keeps an unlinked coding question answerable with an honest run objective", () => {
		const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: null, codingQuestion: true, objective: "Investigate transient compare-read errors" }));
		expect(html).toContain("Source issue unavailable");
		expect(html).toContain("Investigate transient compare-read errors");
		expect(html).not.toContain("href=");
	});
});
