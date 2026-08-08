import { installationTokenForOwner } from "./github-app.js";
import { githubAuthContext, githubConditionalJson, invalidateGithubCache } from "./github-cache.js";
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
 *
 * Both reads go through `lib/github-cache.ts` (#401), which stores GitHub's own ETag and
 * re-sends it as `If-None-Match`. That matters here more than anywhere else on this surface:
 * issues-mode calls `listIssues` on EVERY Loop iteration via `nextIssue()`, which until now was an
 * unconditional GitHub round-trip per iteration per repo. The interval is unchanged — a 304 is
 * cheaper, not a licence to poll harder — and with no KV binding the cache is off and these
 * functions behave exactly as they did before.
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

// Valid GitHub owner/repo segments are [A-Za-z0-9._-] only. Validating the charset here
// (defense-in-depth, matching connectors/github.ts) means the segments are safe to embed
// in the api.github.com path regardless of caller — a crafted value like
// "owner/name?per_page=100" can't smuggle a query/path into an authenticated request.
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Parse "owner/repo" into validated, URL-safe segments; null when malformed. */
function parseRepo(githubRepo: string): { owner: string; name: string } | null {
	const parts = String(githubRepo || "").split("/");
	if (parts.length !== 2 || !SEGMENT.test(parts[0]) || !SEGMENT.test(parts[1])) return null;
	return { owner: parts[0], name: parts[1] };
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

/** The cache resources this module owns — named once so the write path can drop the right one. */
export const ISSUES_RESOURCE = "issues";
export const ISSUE_RESOURCE = "issue";

/**
 * Forget this user's cached issue LIST for a repo.
 *
 * Called after the platform itself opens an issue (`github_create_issue`). Without it an agent
 * that opens an issue and then lists issues reads its own pre-write copy back and concludes the
 * write did not happen — the `get_tasks`-after-`create_task` failure `agent-think.ts` already
 * documents for the dedup guard, one layer out. A dropped entry costs one ordinary conditional
 * request; a TTL short enough to hide the problem would cost every poll.
 */
export async function invalidateIssuesCache(env: Env, userId: string, githubRepo: string): Promise<void> {
	await invalidateGithubCache(env, userId, githubRepo, ISSUES_RESOURCE);
}

/**
 * List a repo's issues (PRs filtered out). Public repos work unauthenticated;
 * private repos need the GitHub App installed for the owner. Returns [] on any
 * failure (no App, no install, GitHub error, malformed repo).
 */
export async function listIssues(env: Env, userId: string, githubRepo: string, opts: ListIssuesOpts = {}): Promise<IssueSummary[]> {
	const parsed = parseRepo(githubRepo);
	if (!parsed) return [];
	try {
		const token = await installationTokenForOwner(env, userId, parsed.owner);
		const state = opts.state ?? "open";
		const perPage = Math.min(Math.max(opts.limit ?? 30, 1), 100);
		const params = new URLSearchParams({ state, per_page: String(perPage), sort: "updated", direction: "desc" });
		if (opts.labels) params.set("labels", opts.labels);
		const qs = params.toString();
		const res = await githubConditionalJson<RawIssue[]>(env, {
			identity: { userId, authContext: await githubAuthContext(env, userId, parsed.owner, token) },
			repo: `${parsed.owner}/${parsed.name}`,
			resource: ISSUES_RESOURCE,
			// The query string IS the variant: "open issues" and "closed issues" are different
			// answers to different questions, and one overwriting the other in a single slot would
			// serve a closed backlog to a caller that asked for the open one.
			variant: qs,
			url: `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/issues?${qs}`,
			headers: GH_HEADERS(token),
		});
		if (!res.ok) return [];
		const data = res.data;
		if (!Array.isArray(data)) return [];
		return data.filter((i) => !i.pull_request).map(toSummary);
	} catch {
		return [];
	}
}

/** Read one issue's detail (with a capped body). Returns null if it's a PR or not found. */
export async function readIssue(env: Env, userId: string, githubRepo: string, number: number): Promise<IssueDetail | null> {
	const parsed = parseRepo(githubRepo);
	if (!parsed || !Number.isFinite(number)) return null;
	try {
		const token = await installationTokenForOwner(env, userId, parsed.owner);
		const res = await githubConditionalJson<RawIssue>(env, {
			identity: { userId, authContext: await githubAuthContext(env, userId, parsed.owner, token) },
			repo: `${parsed.owner}/${parsed.name}`,
			resource: ISSUE_RESOURCE,
			variant: String(Number(number)),
			url: `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/issues/${Number(number)}`,
			headers: GH_HEADERS(token),
		});
		if (!res.ok) return null;
		const raw = res.data;
		if (!raw || typeof raw !== "object") return null;
		if (raw.pull_request) return null; // it's a PR, not an issue
		const body = (raw.body ?? "").slice(0, BODY_CAP);
		return { ...toSummary(raw), body };
	} catch {
		return null;
	}
}
