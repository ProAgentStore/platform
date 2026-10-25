import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuestionIssueContext, { resolveQuestionIssue, STALE_COPY } from "./QuestionIssueContext";

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

	it("keeps an unlinked coding question answerable, says nothing is linked (not that a load failed), and shows the run", () => {
		const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: null, codingQuestion: true, objective: "Investigate transient compare-read errors", status: "none" }));
		expect(html).toContain("No source issue linked");
		expect(html).toContain('data-testid="question-source-none"');
		expect(html).toContain("Investigate transient compare-read errors");
		expect(html).not.toContain("could not be loaded");
		expect(html).not.toContain("href=");
		// An older event with no status is the same honest answer.
		expect(renderToStaticMarkup(createElement(QuestionIssueContext, { issue: null, codingQuestion: true }))).toContain("No source issue linked");
	});

	it("says the source could not be loaded when the lookup failed, which is a different state from none", () => {
		const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: null, codingQuestion: true, objective: "Investigate transient compare-read errors", status: "unavailable" }));
		expect(html).toContain("Source issue could not be loaded");
		expect(html).toContain('data-testid="question-source-unavailable"');
		expect(html).toContain("Investigate transient compare-read errors");
		expect(html).not.toContain("No source issue linked");
		expect(html).not.toContain("href=");
	});

	it("renders nothing for a non-coding question with no issue", () => {
		expect(renderToStaticMarkup(createElement(QuestionIssueContext, { issue: null, status: "unavailable" }))).toBe("");
	});

	describe("a stale source (#1363)", () => {
		const closed = { ...issue, issueState: "closed", stale: true, staleReason: "issue_closed", staleDetail: "the source issue is closed (since 2026-10-24), so what this question assumes may no longer hold" };

		it("shows a 'needs refresh' notice beside the link, keeps the link and summary, and promises the question is unchanged", () => {
			const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue(closed, null) }));
			expect(html).toContain('data-testid="question-issue-stale"');
			expect(html).toContain('data-stale-reason="issue_closed"');
			expect(html).toContain("Needs refresh.");
			expect(html).toContain("The source issue is closed (since 2026-10-24)");
			expect(html).toContain("The question below is unchanged.");
			expect(html).toContain('href="https://github.com/ProAgentStore/platform/issues/1349"');
			expect(html).toContain(issue.summary);
		});

		it("falls back to the stock sentence for a reason when the server sent no detail", () => {
			for (const [reason, text] of Object.entries(STALE_COPY)) {
				const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue({ ...issue, stale: true, staleReason: reason }, null) }));
				expect(html, reason).toContain(text);
			}
		});

		it("shows no notice for a fresh issue", () => {
			expect(renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue({ ...issue, issueState: "open" }, null) }))).not.toContain("question-issue-stale");
		});

		it("ignores a stale flag with an unknown reason or that is not literally true", () => {
			for (const bad of [{ stale: true, staleReason: "trust_me" }, { stale: "yes", staleReason: "issue_closed" }, { stale: true }]) {
				expect(resolveQuestionIssue({ ...issue, ...bad }, null)?.stale).toBeUndefined();
			}
		});

		it("an older question's issue is judged against the board's CURRENT card: closed since, or updated after it was asked", () => {
			const asked = "2026-10-25T10:00:00Z";
			const boardClosed = { ...issue, state: "closed", updatedAt: "2026-10-25T09:00:00Z" };
			expect(resolveQuestionIssue(issue, boardClosed, asked)).toMatchObject({ stale: true, staleReason: "issue_closed" });
			const boardChanged = { ...issue, state: "open", updatedAt: "2026-10-25T11:00:00Z" };
			expect(resolveQuestionIssue(issue, boardChanged, asked)).toMatchObject({ stale: true, staleReason: "issue_changed_since_asked" });
			expect(resolveQuestionIssue(issue, { ...issue, state: "open", updatedAt: "2026-10-25T09:00:00Z" }, asked)?.stale).toBeUndefined();
			expect(resolveQuestionIssue(issue, boardChanged, undefined)?.stale).toBeUndefined(); // no asked-at: cannot call it "changed since"
		});

		it("never judges a question by a DIFFERENT issue's board card", () => {
			const other = { ...issue, number: 100, url: "https://github.com/ProAgentStore/platform/issues/100", title: "Other", state: "closed" };
			expect(resolveQuestionIssue(issue, other, "2026-10-25T10:00:00Z")?.stale).toBeUndefined();
			expect(resolveQuestionIssue(issue, other)?.number).toBe(1349);
		});

		it("an old parked question with only the board's card is still linked, and flagged when that card is closed", () => {
			const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue(undefined, { ...issue, state: "closed" }) }));
			expect(html).toContain('href="https://github.com/ProAgentStore/platform/issues/1349"');
			expect(html).toContain("question-issue-stale");
		});

		it("a stale notice cannot carry markup: the detail renders as text", () => {
			const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue({ ...issue, stale: true, staleReason: "issue_closed", staleDetail: "<img src=x onerror=alert(1)>" }, null) }));
			expect(html).not.toContain("<img");
			expect(html).toContain("&lt;img");
		});
	});

	it("renders exactly what the API produces for a linked, stale question (the shape the run's event carries)", () => {
		const fromApi = {
			repo: "owner/repo", number: 1349, title: "Page GitHub workflow and commit-range evidence safely", url: "https://github.com/owner/repo/issues/1349",
			summary: "Read every page of the release evidence before posting.", issueState: "closed", issueUpdatedAt: "2026-01-01T00:00:00Z",
			cacheAge: 3_600_000, stale: true, staleReason: "issue_closed", staleDetail: "the source issue is closed, so what this question assumes may no longer hold",
		};
		const html = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: resolveQuestionIssue(fromApi, null, "2026-10-25T10:00:00Z"), codingQuestion: true, status: "linked" }));
		expect(html).toContain('href="https://github.com/owner/repo/issues/1349"');
		expect(html).toContain("owner/repo#1349: Page GitHub workflow and commit-range evidence safely");
		expect(html).toContain("question-issue-stale");
		expect(html).not.toContain("question-source-none");
	});

	it("renders source context markdown without visible asterisks", () => {
		const fallback = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: null, codingQuestion: true, objective: "Configure **alerts**" }));
		expect(fallback).toContain("<strong>alerts</strong>");
		expect(fallback).not.toContain("**");
		const linked = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: { ...issue, summary: "Check **every** page" } }));
		expect(linked).toContain("<strong>every</strong>");
		expect(linked).not.toContain("**");
		const unavailable = renderToStaticMarkup(createElement(QuestionIssueContext, { issue: null, codingQuestion: true, objective: "Configure **alerts**", status: "unavailable" }));
		expect(unavailable).toContain("<strong>alerts</strong>");
	});
});
