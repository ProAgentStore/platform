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

export interface IssueComment {
	id: number;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	url: string;
}

export interface ListIssuesOpts {
	state?: "open" | "closed" | "all";
	labels?: string;
	limit?: number;
	/** 1-based page of GitHub's listing (#898) — without it only the newest page was reachable. */
	page?: number;
	/**
	 * `"oldest"` lists by creation, oldest first — the backlog order the issues-mode picker wants
	 * (#898): it took the lowest number among the 30 most recently UPDATED issues, so an old,
	 * untouched issue was never picked. Default is most recently updated first.
	 */
	order?: "updated" | "oldest";
}

/** One page of a listing, and whether GitHub has another (#898). */
export interface IssuesPage {
	issues: IssueSummary[];
	page: number;
	/** True when GitHub returned a full page, so a next one may exist. A page can hold FEWER than
	 *  `per_page` issues and still have more: GitHub's issue listing includes pull requests, which
	 *  are removed after the fetch. */
	hasMore: boolean;
	/** True when GitHub could not be read (no access, rate limit, network) — the empty `issues` is
	 *  then NOT "no issues", and a caller that reports a count must say so (#961). */
	unreadable?: boolean;
}

const pageOf = (page: unknown): number => Math.max(1, Math.trunc(Number(page)) || 1);

export interface ListIssueCommentsOpts {
	page?: number;
	perPage?: number;
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

interface RawIssueComment {
	id: number;
	body: string | null;
	created_at: string;
	updated_at: string;
	html_url: string;
	user?: { login?: string } | null;
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

/** The cache resources this module owns — named once so the write path can drop the right one. */
export const ISSUES_RESOURCE = "issues";
export const ISSUE_RESOURCE = "issue";
export const ISSUE_COMMENTS_RESOURCE = "issue-comments";

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
 * Forget this user's cached issue list AND the cached read of every individual issue in a repo.
 *
 * `invalidateIssuesCache` above drops ONE of the two resources this module caches, which was the
 * complete answer while the only write we performed was opening an issue: a brand-new number has
 * no `ISSUE_RESOURCE` entry to be stale. Commenting on and updating an existing issue (#507) makes
 * it incomplete in the more damaging direction — `github_read_issue` caches per issue under
 * `ISSUE_RESOURCE` with the number as its variant, so an agent that closes #128 and then reads
 * #128 back would be shown `state: open` and would report, accurately as far as it could tell,
 * that the close did not take.
 *
 * Both entries go, not just the one for the issue that changed: variants live INSIDE an entry
 * precisely so invalidation can drop a resource with one delete (see `github-cache.ts`
 * MAX_VARIANTS), and there is no per-variant delete. Dropping a sibling issue's cached read costs
 * that issue one ordinary conditional request — which is a 304 with no body and no primary
 * rate-limit charge if it really is unchanged. That is the cheaper mistake by a wide margin.
 */
export async function invalidateIssueCaches(env: Env, userId: string, githubRepo: string): Promise<void> {
	await Promise.all([
		invalidateGithubCache(env, userId, githubRepo, ISSUES_RESOURCE),
		invalidateGithubCache(env, userId, githubRepo, ISSUE_RESOURCE),
		invalidateGithubCache(env, userId, githubRepo, ISSUE_COMMENTS_RESOURCE),
	]);
}

/**
 * List a repo's issues (PRs filtered out). Public repos work unauthenticated;
 * private repos need the GitHub App installed for the owner. Returns [] on any
 * failure (no App, no install, GitHub error, malformed repo).
 */
export async function listIssues(env: Env, userId: string, githubRepo: string, opts: ListIssuesOpts = {}): Promise<IssueSummary[]> {
	return (await listIssuesPage(env, userId, githubRepo, opts)).issues;
}

/** {@link listIssues}, with the page it read and whether there is another. */
export async function listIssuesPage(env: Env, userId: string, githubRepo: string, opts: ListIssuesOpts = {}): Promise<IssuesPage> {
	const page = pageOf(opts.page);
	const none: IssuesPage = { issues: [], page, hasMore: false, unreadable: true };
	const parsed = parseRepo(githubRepo);
	if (!parsed) return none;
	try {
		const token = await installationTokenForOwner(env, userId, parsed.owner);
		const state = opts.state ?? "open";
		const perPage = Math.min(Math.max(opts.limit ?? 30, 1), 100);
		const params = new URLSearchParams({ state, per_page: String(perPage), ...(opts.order === "oldest" ? { sort: "created", direction: "asc" } : { sort: "updated", direction: "desc" }) });
		if (page > 1) params.set("page", String(page));
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
		if (!res.ok) return none;
		const data = res.data;
		if (!Array.isArray(data)) return none;
		return { issues: data.filter((i) => !i.pull_request).map(toSummary), page, hasMore: data.length === perPage };
	} catch {
		return none;
	}
}

/** What `searchIssues` returns: the matches GitHub sent, and how many there are in all. */
export interface SearchIssuesResult {
	/** Every issue in the repo matching the query — may exceed `issues.length`. */
	total_count: number;
	/** GitHub's own flag: the search timed out and the matches may be incomplete. */
	incomplete_results: boolean;
	issues: IssueSummary[];
}

/** Quote a qualifier value so a label with a space or a quote stays one value. */
const quoted = (v: string) => `"${v.replace(/"/g, "")}"`;

/** The `q` for GitHub's issue search, scoped to one repo and to issues only (#936). */
export function searchIssuesQuery(owner: string, name: string, search: string, opts: Pick<ListIssuesOpts, "state" | "labels"> = {}): string {
	const state = opts.state ?? "open";
	const labels = (opts.labels ?? "").split(",").map((l) => l.trim()).filter(Boolean);
	return [
		`repo:${owner}/${name}`,
		"is:issue",
		state === "all" ? "" : `state:${state}`,
		...labels.map((l) => `label:${quoted(l)}`),
		"in:title,body",
		search.trim(),
	].filter(Boolean).join(" ");
}

/**
 * Search a repo's issues — title AND body, across EVERY issue, not just the recent page (#936).
 *
 * `listIssues` reads one page: the 30 most recently updated. Filtering that page for a term would
 * silently miss every matching issue nobody has touched lately — the silent-truncation class #898
 * catalogues. GitHub's own search covers the whole repo, and says how many matched in all.
 *
 * A refusal is an ERROR, never `[]`, unlike `listIssues`: an empty search result has to mean "nothing
 * matched", or a rate-limited search reads as "there is no such issue". The search API allows 30
 * requests a minute authenticated (10 without), and answers 403/429 past that. Not routed through
 * the conditional cache: search does not honour ETags reliably, and the cache answers a failed
 * request with its stale copy, which is the refusal this must surface.
 */
export async function searchIssues(env: Env, userId: string, githubRepo: string, search: string, opts: ListIssuesOpts = {}): Promise<SearchIssuesResult | { error: string }> {
	const parsed = parseRepo(githubRepo);
	if (!parsed) return { error: `"${githubRepo}" is not an "owner/name" repository.` };
	const token = await installationTokenForOwner(env, userId, parsed.owner).catch(() => null);
	const found = await fetchGithubSearch<RawIssue>(searchIssuesQuery(parsed.owner, parsed.name, search, opts), token, opts.limit, opts.page);
	if ("error" in found) return found;
	return { total_count: found.total_count, incomplete_results: found.incomplete_results, issues: found.items.filter((i) => !i.pull_request).map(toSummary) };
}

/**
 * One page of GitHub's issue search, newest activity first — or the refusal, as an ERROR (#936, #937).
 *
 * Shared by `searchIssues` and `searchPulls` (github-prs.ts), because the part that must not drift
 * is the refusal: a rate-limited, invalid or unauthorised search has to read as an error, never as
 * "nothing matched". The search API allows 30 requests a minute authenticated (10 without) and
 * answers 403/429 past that. Not routed through the conditional cache, which answers a failed
 * request with its stale copy — the very refusal this must surface.
 */
export async function fetchGithubSearch<T>(q: string, token: string | null, limit = 30, page = 1): Promise<{ total_count: number; incomplete_results: boolean; items: T[] } | { error: string }> {
	const perPage = Math.min(Math.max(limit, 1), 100);
	const params = new URLSearchParams({ q, per_page: String(perPage), sort: "updated", order: "desc" });
	if (pageOf(page) > 1) params.set("page", String(pageOf(page)));
	const url = `https://api.github.com/search/issues?${params}`;
	let res: Response;
	try {
		res = await fetch(url, { headers: GH_HEADERS(token) });
	} catch (e) {
		return { error: `GitHub search could not be reached (${e instanceof Error ? e.message : String(e)}).` };
	}
	if (res.status === 429 || (res.status === 403 && res.headers?.get?.("x-ratelimit-remaining") === "0")) {
		const reset = Number(res.headers?.get?.("x-ratelimit-reset"));
		const wait = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : 60;
		return { error: `GitHub's search rate limit is used up (30 searches a minute) — try again in about ${wait}s. This is not "no matches".` };
	}
	const body = (await res.json().catch(() => null)) as { total_count?: number; incomplete_results?: boolean; items?: T[]; message?: string } | null;
	if (!res.ok) {
		// 422: an invalid query, or a repo this token cannot see (GitHub says the same for both).
		return { error: `GitHub search refused the query (${res.status})${body?.message ? `: ${body.message}` : ""}.` };
	}
	const items = Array.isArray(body?.items) ? body.items : [];
	return { total_count: typeof body?.total_count === "number" ? body.total_count : items.length, incomplete_results: body?.incomplete_results === true, items };
}

/** Read one issue's detail, body whole. Returns null if it's a PR or not found. */
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
		// Whole (#898): GitHub caps a body at 65,536 chars itself; an 8 KiB slice here cut comments mid-word.
		return { ...toSummary(raw), body: raw.body ?? "" };
	} catch {
		return null;
	}
}

function toComment(raw: RawIssueComment): IssueComment {
	return {
		id: raw.id,
		author: raw.user?.login ?? "",
		body: raw.body ?? "",
		createdAt: raw.created_at ?? "",
		updatedAt: raw.updated_at ?? "",
		url: raw.html_url ?? "",
	};
}

/**
 * List comments on one GitHub issue. Returns [] on any failure, matching `listIssues`'s
 * graceful-degradation contract.
 */
export async function listIssueComments(
	env: Env,
	userId: string,
	githubRepo: string,
	number: number,
	opts: ListIssueCommentsOpts = {},
): Promise<IssueComment[]> {
	const parsed = parseRepo(githubRepo);
	if (!parsed || !Number.isFinite(number) || number <= 0) return [];
	try {
		const token = await installationTokenForOwner(env, userId, parsed.owner);
		const perPage = Math.min(Math.max(Math.trunc(opts.perPage ?? 30) || 30, 1), 50);
		const page = Math.max(Math.trunc(opts.page ?? 1) || 1, 1);
		const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
		const qs = params.toString();
		const res = await githubConditionalJson<RawIssueComment[]>(env, {
			identity: { userId, authContext: await githubAuthContext(env, userId, parsed.owner, token) },
			repo: `${parsed.owner}/${parsed.name}`,
			resource: ISSUE_COMMENTS_RESOURCE,
			variant: `${Number(number)}?${qs}`,
			url: `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/issues/${Number(number)}/comments?${qs}`,
			headers: GH_HEADERS(token),
		});
		if (!res.ok) return [];
		const data = res.data;
		if (!Array.isArray(data)) return [];
		return data.map(toComment);
	} catch {
		return [];
	}
}
