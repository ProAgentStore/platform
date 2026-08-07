import { describe, expect, it } from "vitest";
import { buildIssueMonitorReport, parseGithubRepo, severityFromLabels } from "./admin-github-issues.js";

describe("admin GitHub issue monitor", () => {
	it("validates owner/repo slugs", () => {
		expect(parseGithubRepo("ProAgentStore/platform")).toEqual({
			owner: "ProAgentStore",
			name: "platform",
			full: "ProAgentStore/platform",
		});
		expect(parseGithubRepo("owner/repo?per_page=100")).toBeNull();
		expect(parseGithubRepo("owner/repo/extra")).toBeNull();
	});

	it("maps common severity labels", () => {
		expect(severityFromLabels(["severity:critical"])).toBe("critical");
		expect(severityFromLabels(["P1"])).toBe("high");
		expect(severityFromLabels(["sev-3"])).toBe("medium");
		expect(severityFromLabels(["minor"])).toBe("low");
		expect(severityFromLabels(["bug"])).toBe("none");
	});

	it("builds issue totals, labels, and cumulative history", () => {
		const report = buildIssueMonitorReport(
			"owner/repo",
			[
				{
					number: 1,
					title: "First",
					state: "closed",
					labels: [{ name: "bug" }, { name: "severity:high" }],
					created_at: "2026-01-01T10:00:00Z",
					closed_at: "2026-01-03T10:00:00Z",
					updated_at: "2026-01-03T10:00:00Z",
					html_url: "https://github.com/owner/repo/issues/1",
					comments: 2,
				},
				{
					number: 2,
					title: "Second",
					state: "open",
					labels: ["enhancement"],
					created_at: "2026-01-02T10:00:00Z",
					closed_at: null,
					updated_at: "2026-01-04T10:00:00Z",
					html_url: "https://github.com/owner/repo/issues/2",
					comments: 0,
				},
				{
					number: 3,
					title: "PR",
					state: "open",
					labels: [],
					created_at: "2026-01-02T10:00:00Z",
					closed_at: null,
					updated_at: "2026-01-02T10:00:00Z",
					html_url: "https://github.com/owner/repo/pull/3",
					comments: 0,
					pull_request: {},
				},
			],
			{ generatedAt: "2026-01-04T00:00:00Z", since: "2026-01-01" },
		);

		expect(report.totals).toEqual({ all: 2, open: 1, closed: 1 });
		expect(report.bySeverity.high).toEqual({ total: 1, open: 0, closed: 1 });
		expect(report.bySeverity.none).toEqual({ total: 1, open: 1, closed: 0 });
		expect(report.labels.find((label) => label.name === "bug")).toMatchObject({ total: 1, closed: 1 });
		expect(report.history.slice(0, 3)).toEqual([
			{ date: "2026-01-01", opened: 1, closed: 0, totalFiled: 1, totalClosed: 0, openTotal: 1 },
			{ date: "2026-01-02", opened: 1, closed: 0, totalFiled: 2, totalClosed: 0, openTotal: 2 },
			{ date: "2026-01-03", opened: 0, closed: 1, totalFiled: 2, totalClosed: 1, openTotal: 1 },
		]);
	});
});
