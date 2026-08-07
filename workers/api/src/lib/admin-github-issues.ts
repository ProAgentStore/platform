import type { Env } from "../types.js";

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_PAGES = 10;
const PER_PAGE = 100;

export type IssueState = "open" | "closed";
export type IssueSeverity = "critical" | "high" | "medium" | "low" | "none";

export interface GithubIssueMonitorIssue {
	number: number;
	title: string;
	state: IssueState;
	labels: string[];
	severity: IssueSeverity;
	createdAt: string;
	closedAt: string | null;
	updatedAt: string;
	url: string;
	comments: number;
}

export interface GithubIssueMonitorReport {
	repo: string;
	generatedAt: string;
	complete: boolean;
	fetched: number;
	totals: {
		all: number;
		open: number;
		closed: number;
	};
	bySeverity: Record<IssueSeverity, { total: number; open: number; closed: number }>;
	labels: Array<{ name: string; total: number; open: number; closed: number }>;
	history: Array<{ date: string; opened: number; closed: number; openTotal: number; totalFiled: number; totalClosed: number }>;
	issues: GithubIssueMonitorIssue[];
}

interface RawGithubIssue {
	number: number;
	title: string;
	state: string;
	labels?: Array<{ name?: string } | string>;
	created_at: string;
	closed_at: string | null;
	updated_at: string;
	html_url: string;
	comments: number;
	pull_request?: unknown;
}

export function parseGithubRepo(input: string): { owner: string; name: string; full: string } | null {
	const parts = String(input || "").trim().split("/");
	if (parts.length !== 2 || !SEGMENT.test(parts[0]) || !SEGMENT.test(parts[1])) return null;
	return { owner: parts[0], name: parts[1], full: `${parts[0]}/${parts[1]}` };
}

export function severityFromLabels(labels: string[]): IssueSeverity {
	const normalized = labels.map((label) => label.toLowerCase().replace(/^severity[:/]\s*/, "").trim());
	if (normalized.some((label) => /\b(critical|blocker|sev[ -]?0|sev[ -]?1|p0)\b/.test(label))) return "critical";
	if (normalized.some((label) => /\b(high|major|sev[ -]?2|p1)\b/.test(label))) return "high";
	if (normalized.some((label) => /\b(medium|moderate|sev[ -]?3|p2)\b/.test(label))) return "medium";
	if (normalized.some((label) => /\b(low|minor|sev[ -]?4|p3)\b/.test(label))) return "low";
	return "none";
}

export function buildIssueMonitorReport(
	repo: string,
	rawIssues: RawGithubIssue[],
	opts: { generatedAt?: string; complete?: boolean; since?: string | null } = {},
): GithubIssueMonitorReport {
	const generatedAt = opts.generatedAt ?? new Date().toISOString();
	const issues = rawIssues
		.filter((issue) => !issue.pull_request)
		.map((issue) => {
			const labels = labelNames(issue.labels);
			return {
				number: issue.number,
				title: issue.title ?? "",
				state: issue.state === "closed" ? "closed" : "open",
				labels,
				severity: severityFromLabels(labels),
				createdAt: issue.created_at,
				closedAt: issue.closed_at ?? null,
				updatedAt: issue.updated_at,
				url: issue.html_url,
				comments: issue.comments ?? 0,
			} satisfies GithubIssueMonitorIssue;
		})
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

	const bySeverity = emptySeverityCounts();
	const labelMap = new Map<string, { name: string; total: number; open: number; closed: number }>();
	for (const issue of issues) {
		incrementCounts(bySeverity[issue.severity], issue.state);
		for (const label of issue.labels) {
			const current = labelMap.get(label) ?? { name: label, total: 0, open: 0, closed: 0 };
			incrementCounts(current, issue.state);
			labelMap.set(label, current);
		}
	}

	const closed = issues.filter((issue) => issue.state === "closed").length;
	return {
		repo,
		generatedAt,
		complete: opts.complete ?? true,
		fetched: issues.length,
		totals: {
			all: issues.length,
			open: issues.length - closed,
			closed,
		},
		bySeverity,
		labels: [...labelMap.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
		history: buildHistory(issues, opts.since ?? null),
		issues,
	};
}

export async function fetchGithubIssueMonitorReport(
	env: Env,
	repoInput: string,
	opts: { since?: string | null } = {},
): Promise<GithubIssueMonitorReport> {
	const repo = parseGithubRepo(repoInput);
	if (!repo) throw new Error("Invalid GitHub repo. Use owner/repo.");
	if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");

	const raw: RawGithubIssue[] = [];
	let complete = true;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const params = new URLSearchParams({
			state: "all",
			sort: "created",
			direction: "asc",
			per_page: String(PER_PAGE),
			page: String(page),
		});
		const res = await fetch(`https://api.github.com/repos/${repo.full}/issues?${params.toString()}`, {
			headers: {
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "proagentstore-admin/1.0",
			},
		});
		if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
		const pageIssues = (await res.json()) as RawGithubIssue[];
		if (!Array.isArray(pageIssues)) break;
		raw.push(...pageIssues);
		if (pageIssues.length < PER_PAGE) {
			complete = true;
			break;
		}
		complete = false;
	}
	return buildIssueMonitorReport(repo.full, raw, { complete, since: opts.since ?? null });
}

function labelNames(labels: RawGithubIssue["labels"]): string[] {
	if (!Array.isArray(labels)) return [];
	return labels
		.map((label) => (typeof label === "string" ? label : label?.name))
		.filter((label): label is string => typeof label === "string" && label.length > 0)
		.sort((a, b) => a.localeCompare(b));
}

function emptySeverityCounts(): Record<IssueSeverity, { total: number; open: number; closed: number }> {
	return {
		critical: { total: 0, open: 0, closed: 0 },
		high: { total: 0, open: 0, closed: 0 },
		medium: { total: 0, open: 0, closed: 0 },
		low: { total: 0, open: 0, closed: 0 },
		none: { total: 0, open: 0, closed: 0 },
	};
}

function incrementCounts(counts: { total: number; open: number; closed: number }, state: IssueState): void {
	counts.total++;
	if (state === "closed") counts.closed++;
	else counts.open++;
}

function buildHistory(issues: GithubIssueMonitorIssue[], since: string | null) {
	if (!issues.length) return [];
	const firstDay = since || issues.map((issue) => day(issue.createdAt)).sort()[0];
	const lastDay = day(new Date().toISOString());
	const openedByDay = new Map<string, number>();
	const closedByDay = new Map<string, number>();
	for (const issue of issues) {
		add(openedByDay, day(issue.createdAt), 1);
		if (issue.closedAt) add(closedByDay, day(issue.closedAt), 1);
	}

	const history: GithubIssueMonitorReport["history"] = [];
	let totalFiled = issues.filter((issue) => day(issue.createdAt) < firstDay).length;
	let totalClosed = issues.filter((issue) => issue.closedAt && day(issue.closedAt) < firstDay).length;
	for (const date of daysBetween(firstDay, lastDay)) {
		const opened = openedByDay.get(date) ?? 0;
		const closed = closedByDay.get(date) ?? 0;
		totalFiled += opened;
		totalClosed += closed;
		history.push({ date, opened, closed, totalFiled, totalClosed, openTotal: totalFiled - totalClosed });
	}
	return history;
}

function day(value: string): string {
	return value.slice(0, 10);
}

function add(map: Map<string, number>, key: string, value: number): void {
	map.set(key, (map.get(key) ?? 0) + value);
}

function daysBetween(start: string, end: string): string[] {
	const out: string[] = [];
	const startDate = new Date(`${start}T00:00:00Z`);
	const endDate = new Date(`${end}T00:00:00Z`);
	for (let t = startDate.getTime(); t <= endDate.getTime(); t += 86_400_000) {
		out.push(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}
