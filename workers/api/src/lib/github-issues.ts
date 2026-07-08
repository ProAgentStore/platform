import { installationTokenForOwner } from "./github-app.js";
import type { Env } from "../types.js";

/**
 * Read-only GitHub Issues access for the Coder's Co-pilot/Chat and the console
 * Issues panel. This is a CLOUD → GitHub call (not a runner call), so it works
 * regardless of which runner version the user is on.
 *
 * Auth mirrors the deploy-status route (routes/coding.ts): a verified installation
 * token for private repos (installationTokenForOwner → non-null), or unauthenticated
 * for public repos (60 req/hr). Never throws — a GitHub/network error degrades to an
 * empty list / null so callers can render "couldn't load issues" instead of crashing.
 */

export interface IssueSummary {
	number: number;
	title: string;
	state: string;
	labels: string[];
	comments: number;
	updatedAt: string;
	url: string;
}

export interface IssueDetail extends IssueSummary {
	body: string;
}

export interface ListIssuesOpts {
	state?: "open" | "closed" | "all";
	labels?: string;
	limit?: number;
}

const GH_HEADERS = (token: string | null) => ({
	...(token ? { Authorization: `token ${token}` } : {}),
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "proagentstore-coding/1.0",
});

/** Owner login from an "owner/repo" string; "" when malformed. */
function ownerOf(githubRepo: string): string {
	const parts = githubRepo.split("/");
	return parts.length === 2 && parts[0] ? parts[0] : "";
}

/** GitHub returns PRs from the issues endpoint too — they carry a `pull_request` field. */
interface RawIssue {
	number: number;
	title: string;
	state: string;
	comments: number;
	updated_at: string;
	html_url: string;
	body: string | null;
	pull_request?: unknown;
	labels?: Array<{ name?: string } | string>;
}

function labelNames(labels: RawIssue["labels"]): string[] {
	if (!Array.isArray(labels)) return [];
	return labels
		.map((l) => (typeof l === "string" ? l : l?.name))
		.filter((n): n is string => typeof n === "string" && n.length > 0);
}

function toSummary(raw: RawIssue): IssueSummary {
	return {
		number: raw.number,
		title: raw.title ?? "",
		state: raw.state ?? "open",
		labels: labelNames(raw.labels),
		comments: typeof raw.comments === "number" ? raw.comments : 0,
		updatedAt: raw.updated_at ?? "",
		url: raw.html_url ?? "",
	};
}

const BODY_CAP = 8 * 1024;

/**
 * List a repo's issues (PRs filtered out). Public repos work unauthenticated;
 * private repos need the GitHub App installed for the owner. Returns [] on any
 * failure (no App, no install, GitHub error, malformed repo).
 */
export async function listIssues(env: Env, userId: string, githubRepo: string, opts: ListIssuesOpts = {}): Promise<IssueSummary[]> {
	const owner = ownerOf(githubRepo);
	if (!owner) return [];
	try {
		const token = await installationTokenForOwner(env, userId, owner);
		const state = opts.state ?? "open";
		const perPage = Math.min(Math.max(opts.limit ?? 30, 1), 100);
		const params = new URLSearchParams({ state, per_page: String(perPage), sort: "updated", direction: "desc" });
		if (opts.labels) params.set("labels", opts.labels);
		const res = await fetch(`https://api.github.com/repos/${githubRepo}/issues?${params.toString()}`, { headers: GH_HEADERS(token) });
		if (!res.ok) return [];
		const data = (await res.json()) as RawIssue[];
		if (!Array.isArray(data)) return [];
		return data.filter((i) => !i.pull_request).map(toSummary);
	} catch {
		return [];
	}
}

/** Read one issue's detail (with a capped body). Returns null if it's a PR or not found. */
export async function readIssue(env: Env, userId: string, githubRepo: string, number: number): Promise<IssueDetail | null> {
	const owner = ownerOf(githubRepo);
	if (!owner || !Number.isFinite(number)) return null;
	try {
		const token = await installationTokenForOwner(env, userId, owner);
		const res = await fetch(`https://api.github.com/repos/${githubRepo}/issues/${number}`, { headers: GH_HEADERS(token) });
		if (!res.ok) return null;
		const raw = (await res.json()) as RawIssue;
		if (raw.pull_request) return null; // it's a PR, not an issue
		const body = (raw.body ?? "").slice(0, BODY_CAP);
		return { ...toSummary(raw), body };
	} catch {
		return null;
	}
}
