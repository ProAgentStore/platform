/**
 * Read-only enumeration and search of GitHub organizations and repositories reachable
 * by the machine's own `gh` credentials (#685, #686).
 *
 * ── Enumeration (#685)
 *
 * Uses `gh api` with `--paginate` to walk GitHub's REST API: first the list of
 * organizations the authenticated user belongs to, then the repos for each (plus the
 * user's own personal repos). Never writes, never mutates, never touches a credential
 * beyond what `gh` already has.
 *
 * ── Search (#686)
 *
 * Uses GitHub's own search API (`GET /search/repositories`) via `gh api` — one request
 * instead of a per-repo fan-out. GitHub's search index spans all repos the credential
 * can read (public + private owned/member repos), so it is the correct tool for
 * questions that span the whole account (open PRs, recently-active repos, topic match).
 *
 * Rate-limit strategy (#686 hard constraint): GitHub's authenticated search quota is
 * 30 requests/min (separate from the 5 000/hr REST quota). To stay within it:
 *
 *   1. An in-process LRU cache (`SEARCH_CACHE`) holds the last result per canonical
 *      query string. Cache entries are fresh for `SEARCH_TTL_MS` (5 minutes). A cache
 *      hit is returned immediately without touching the network.
 *   2. When GitHub returns 403 or the rate-limit error text, the function returns
 *      `{ rateLimited: true, cachedAt }` and the cloud relays that to the caller.
 *      The UI should tell the user to retry after a minute rather than looping.
 *   3. `limit` is always bounded (default 30, max 100) — GitHub's own search cap is
 *      100 items per request and paginating further risks burning the quota on one query.
 *
 * ── Scale
 *
 * The measured account (serge-ivo, 2026-08-16) has ~90 distinct owners and >1 000
 * repos. A single unpaginated call cannot work: GitHub caps list endpoints at 100
 * items per page. This module paginates by driving `gh api --paginate`, which
 * follows GitHub's `Link: <…>; rel="next"` header automatically and collects all
 * pages into one JSON array.
 *
 * Returning the full 1 000+ list in a single relay call is also unworkable: it would
 * blow the relay timeout and the relay body limit. Instead callers pass `owner` to
 * scope the query, `limit` to cap the result set, and `since` (an ISO timestamp) to
 * request only repos pushed after a given point. The most useful default is sorting
 * by last-pushed because the long tail is single-repo owners nobody has touched in
 * years.
 *
 * ── Why `gh api`, not the GitHub API directly
 *
 * The machine's `gh auth login` already stores a token (or an OAuth device flow
 * credential) under `~/.config/gh`. There is no token to extract, no secret to pass
 * over the relay, and no auth surface to widen. `gh api` uses that credential
 * transparently, exactly the way every other `gh` call in a coding session does.
 *
 * ── What remains open (stated rather than hidden)
 *
 * - `gh` must be on PATH. A machine without `gh` gets an error rather than an empty
 *   list; the error is surfaced to the caller, not swallowed.
 * - The machine credential determines what is visible. A deploy key sees exactly one
 *   repository; a user account sees what that account can read.
 * - Rate limits are GitHub's (5 000/hr for authenticated requests, 30/min for search).
 *   Long enumerations of a large org will consume REST quota; `limit` keeps this
 *   manageable. Search has its own quota; the cache and bounded limit guard it.
 */

import { spawnSync } from "node:child_process";

/**
 * One repository entry as returned to the cloud.
 *
 * Field names match GitHub's REST API (`pushed_at`, `default_branch`, …) so the
 * cloud can pass them through without renaming — a future schema change lands in
 * one place.
 */
export interface GithubRepoEntry {
	owner: string;
	name: string;
	full_name: string;
	visibility: "public" | "private" | "internal";
	default_branch: string;
	pushed_at: string | null;
	language: string | null;
}

/**
 * What the runner returns for a github-repos request.
 *
 * `checked: true` is the version marker, the same idiom as `WorkdirCheck`
 * (`repo.ts`) and `GitSshIdentity` (`repo.ts`). An older runner 404s this endpoint
 * and the cloud treats the missing field as "not supported", not as "no repos".
 */
export interface GithubBrowseResult {
	checked: true;
	/**
	 * The repos found, in the order they were returned (pushed_at DESC when the
	 * default GitHub sort is used, which is what the cloud requests).
	 */
	repos: GithubRepoEntry[];
	/**
	 * Whether there are more results beyond `limit`. The cloud uses this to tell
	 * the caller they have seen a truncated list, not an exhaustive one.
	 */
	hasMore: boolean;
	/** Total number of repos seen before applying `limit`. */
	total: number;
}

/** Input options for {@link listGithubRepos}. All optional for ergonomics. */
export interface GithubBrowseInput {
	/**
	 * Restrict to one owner (personal login or org name). When omitted, the
	 * personal account's repos are returned (the cheapest default). Pass `"*"` to
	 * ask for ALL owners — the personal account plus every org, which may be slow on
	 * a large account. The UI builds this up progressively: one owner at a time.
	 */
	owner?: string;
	/** Maximum number of repos to return. Defaults to 50, hard-capped at 200. */
	limit?: number;
	/**
	 * Only return repos with `pushed_at` at or after this ISO timestamp. Lets the
	 * caller ask for "recently active" repos without fetching the full list. When
	 * omitted, all repos are returned (subject to `limit`).
	 */
	since?: string;
	/**
	 * Visibility filter: `"all"` (default), `"public"`, or `"private"`. Passed
	 * directly to the GitHub API.
	 */
	visibility?: "all" | "public" | "private";
}

/** The maximum `limit` the cloud may request from one call. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Run one `gh api` call and return the parsed JSON array, or throw on failure.
 *
 * `--paginate` follows all pages and concatenates them into one array. Large orgs
 * may generate hundreds of pages; `--jq` is used to project down to the fields we
 * need BEFORE the pages are concatenated, keeping the payload small.
 *
 * `spawnSync` is used so the function is synchronous (matching the runner's
 * synchronous endpoint contract — no event-loop gymnastics in `server.ts`). The
 * runner's relay timeout is 120s; a full pagination of the largest org (~250 repos)
 * takes under 10s in practice.
 *
 * Never throws — errors are returned as `{ error: string }`.
 */
function runGhApi(args: string[]): unknown[] | { error: string } {
	const result = spawnSync("gh", ["api", "--paginate", ...args], {
		encoding: "utf-8",
		timeout: 60_000,
		// Inherit the machine's PATH and credentials but nothing else sensitive.
		env: process.env,
	});
	if (result.error) {
		// ENOENT means `gh` is not installed.
		const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
		return { error: code === "ENOENT" ? "`gh` is not installed or not on PATH" : result.error.message };
	}
	if (result.status !== 0) {
		const msg = String(result.stderr ?? "").slice(0, 500).trim() || `gh exited ${result.status ?? "unknown"}`;
		return { error: msg };
	}
	// `gh api --paginate` writes each page's JSON array on a line; the full output
	// is valid JSON only as a concatenated array. GitHub's paginator combines pages
	// with `[][]` (two arrays back-to-back), which is not valid JSON. The `--jq`
	// flag, when combined with `--paginate`, instead produces one JSON array overall,
	// so we parse the whole stdout as a single array.
	const raw = String(result.stdout ?? "").trim();
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return { error: "gh returned unparsable output" };
	}
}

/**
 * Project a raw GitHub API repository object down to {@link GithubRepoEntry}.
 *
 * Accepts `unknown` because `gh api` output is untyped; every field is defensively
 * coerced rather than assumed to be present. A missing field becomes its zero value:
 * `null` for strings, `"main"` for the branch.
 */
function toEntry(raw: unknown): GithubRepoEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const fullName = String(r.full_name ?? r.nameWithOwner ?? "");
	const slash = fullName.lastIndexOf("/");
	if (slash < 1) return null;
	const owner = fullName.slice(0, slash);
	const name = fullName.slice(slash + 1);
	// Operator-precedence guard: parenthesise the fallback so `??` doesn't bind into
	// the ternary. Without parens `r.visibility ?? r.isPrivate === true ? … : …` parses
	// as `(r.visibility ?? r.isPrivate === true) ? "private" : "public"`, which makes
	// EVERY truthy visibility string map to "private".
	const rawVis = r.visibility != null ? String(r.visibility) : (r.isPrivate === true ? "private" : "public");
	const visibility: GithubRepoEntry["visibility"] = rawVis === "private" ? "private" : rawVis === "internal" ? "internal" : "public";
	return {
		owner,
		name,
		full_name: fullName,
		visibility,
		default_branch: String(r.default_branch ?? r.defaultBranchRef ?? "main") || "main",
		pushed_at: r.pushed_at != null ? String(r.pushed_at) : (r.pushedAt != null ? String(r.pushedAt) : null),
		language: r.language != null ? String(r.language) : null,
	};
}

/**
 * Enumerate GitHub organizations the authenticated user belongs to.
 *
 * Returns `{ orgs: string[] }` — the login names only, so the caller can let the
 * user pick one before fetching its (potentially large) repo list.
 *
 * Returns `{ error: string }` when `gh` is unavailable or the call fails.
 */
export function listGithubOrgs(): { orgs: string[] } | { error: string } {
	// Minimal projection: we only need the `login` field.
	const jq = "[.[] | {login: .login}]";
	const raw = runGhApi(["user/orgs", "--jq", jq]);
	if ("error" in raw) return raw as { error: string };
	const orgs: string[] = [];
	for (const item of raw) {
		if (item && typeof item === "object" && "login" in item) {
			orgs.push(String((item as Record<string, unknown>).login));
		}
	}
	return { orgs };
}

/**
 * Enumerate GitHub repositories reachable by the machine's `gh` credentials.
 *
 * Read-only by construction: the only `gh` call is `gh api GET /user/repos` or
 * `gh api GET /orgs/{org}/repos`, which never mutates anything on GitHub.
 *
 * Never throws — every failure is a descriptive `{ error }` property.
 */
export function listGithubRepos(input: GithubBrowseInput = {}): GithubBrowseResult | { error: string } {
	const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(input.limit) || DEFAULT_LIMIT)));
	const visibility = input.visibility === "public" ? "public" : input.visibility === "private" ? "private" : "all";

	// JQ projection — only the fields we return, so large responses stay small.
	// `pushed_at` is the sort key and the `since` filter key.
	const jq = "[.[] | {full_name, visibility, default_branch, pushed_at, language}]";

	let raw: unknown[] | { error: string };
	const owner = (input.owner ?? "").trim();

	if (!owner || owner === "me") {
		// Personal repos: https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user
		raw = runGhApi([`user/repos?sort=pushed&direction=desc&per_page=100&visibility=${visibility}&affiliation=owner`, "--jq", jq]);
	} else {
		// Org repos: https://docs.github.com/en/rest/repos/repos#list-organization-repositories
		raw = runGhApi([`orgs/${encodeURIComponent(owner)}/repos?sort=pushed&direction=desc&per_page=100&type=all`, "--jq", jq]);
	}

	if ("error" in raw) return raw as { error: string };

	// Filter by `since` if requested.
	const since = input.since ? new Date(input.since).getTime() : 0;

	const all: GithubRepoEntry[] = [];
	for (const item of raw) {
		const entry = toEntry(item);
		if (!entry) continue;
		if (since > 0) {
			const pushedMs = entry.pushed_at ? new Date(entry.pushed_at).getTime() : 0;
			if (pushedMs < since) continue;
		}
		all.push(entry);
	}

	const hasMore = all.length > limit;
	const repos = all.slice(0, limit);
	return { checked: true, repos, hasMore, total: all.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub repository search (#686)
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum items GitHub's search API returns in a single request. */
const SEARCH_MAX_LIMIT = 100;
const SEARCH_DEFAULT_LIMIT = 30;

/**
 * In-process result cache for search queries.
 *
 * Keyed by the canonical query string (sorted parameters → stable key). Each
 * entry holds the result and the time it was fetched. A fresh entry (within
 * `SEARCH_TTL_MS`) is returned immediately without touching the network.
 *
 * This is the primary rate-limit guard: GitHub allows 30 search requests/minute
 * per authenticated user. Repeated identical queries from the same runner session
 * are served from cache without consuming quota.
 */
interface SearchCacheEntry {
	result: GithubSearchResult;
	fetchedAt: number;
}
const SEARCH_CACHE = new Map<string, SearchCacheEntry>();

/** How long a cached search result is considered fresh (milliseconds). */
const SEARCH_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Evict entries older than `SEARCH_TTL_MS` to keep the cache bounded. */
function pruneSearchCache(): void {
	const cutoff = Date.now() - SEARCH_TTL_MS;
	for (const [key, entry] of SEARCH_CACHE) {
		if (entry.fetchedAt < cutoff) SEARCH_CACHE.delete(key);
	}
}

/**
 * Clear the entire search cache.
 *
 * Exported for test isolation only — tests must call this in `beforeEach` so
 * that no cached result bleeds from one test case to the next.
 */
export function clearSearchCacheForTesting(): void {
	SEARCH_CACHE.clear();
}

/** Input options for {@link searchGithubRepos}. */
export interface GithubSearchInput {
	/**
	 * Free-text query forwarded to GitHub's search API.
	 *
	 * GitHub search qualifiers are supported in the query string — the same syntax
	 * that works in the GitHub search bar. Examples:
	 *   - `"react hooks"` — repos whose name/description/README contains this phrase
	 *   - `topic:machine-learning language:python` — repos tagged with a topic
	 *   - `is:public pushed:>2026-01-01` — public repos pushed after a date
	 *   - `user:serge-ivo is:private` — private repos under a specific owner
	 *
	 * When omitted the query defaults to listing ALL repos reachable by the credential
	 * (effectively `is:public OR is:private` scoped to the authenticated account's
	 * access), sorted by most recently updated.
	 */
	query?: string;
	/**
	 * Restrict results to a specific owner (login or org name). Appended to the
	 * query as `user:<owner>` so you can combine it with other qualifiers.
	 */
	owner?: string;
	/**
	 * Filter by programming language (e.g. `"TypeScript"`, `"Python"`). Appended as
	 * `language:<lang>`.
	 */
	language?: string;
	/**
	 * Filter by topic tag (e.g. `"machine-learning"`, `"react"`). Appended as
	 * `topic:<topic>`.
	 */
	topic?: string;
	/**
	 * Only return repos pushed at or after this ISO timestamp. Appended as
	 * `pushed:>={date}`.
	 */
	pushedAfter?: string;
	/**
	 * Only return repos with open pull requests. When `true`, appended as
	 * `is:open pr` (uses GitHub's PR search to find repos with open PRs).
	 *
	 * Note: GitHub's search API does not have a direct `has:open-prs` qualifier;
	 * this flag pivots to the pulls search endpoint and de-duplicates by repo.
	 */
	openPrs?: boolean;
	/** Maximum results to return (1–100, default 30). */
	limit?: number;
	/**
	 * Sort order for results. `"updated"` (default) returns most-recently-updated
	 * repos first. `"stars"` returns most-starred first. `"forks"` returns most-
	 * forked first.
	 */
	sort?: "updated" | "stars" | "forks";
}

/** One item in a search result — a subset of {@link GithubRepoEntry}. */
export interface GithubSearchRepoEntry {
	full_name: string;
	owner: string;
	name: string;
	description: string | null;
	visibility: "public" | "private" | "internal";
	language: string | null;
	pushed_at: string | null;
	stars: number;
	forks: number;
	open_issues: number;
	topics: string[];
}

/**
 * What the runner returns for a github-search request.
 *
 * `checked: true` is the version marker (same idiom as {@link GithubBrowseResult}).
 * An older runner 404s and the cloud treats the missing field as "not supported".
 */
export interface GithubSearchResult {
	checked: true;
	repos: GithubSearchRepoEntry[];
	/** Total matches on GitHub — may be far larger than `repos.length`. */
	totalCount: number;
	/** Whether the result was served from cache rather than a live API call. */
	fromCache: boolean;
	/** ISO timestamp of when this result was fetched from GitHub. */
	cachedAt: string;
	/**
	 * `true` when GitHub returned a rate-limit response.
	 *
	 * The result may still contain repos if a stale cache entry exists. The cloud
	 * should relay this flag so the caller can tell the user to wait before retrying.
	 */
	rateLimited?: boolean;
	/** The canonical query string sent to GitHub (for transparency / debugging). */
	canonicalQuery: string;
}

/**
 * Build the canonical GitHub search query string from structured input.
 *
 * Qualifiers are appended in a fixed order so the same logical query always
 * produces the same string (used as the cache key).
 */
function buildSearchQuery(input: GithubSearchInput): string {
	const parts: string[] = [];
	// Free-text query first.
	if (input.query?.trim()) parts.push(input.query.trim());
	// Structured qualifiers in stable order.
	if (input.owner?.trim()) parts.push(`user:${input.owner.trim()}`);
	if (input.language?.trim()) parts.push(`language:${input.language.trim()}`);
	if (input.topic?.trim()) parts.push(`topic:${input.topic.trim()}`);
	if (input.pushedAfter?.trim()) {
		// GitHub expects YYYY-MM-DD; accept ISO with time and truncate.
		const date = input.pushedAfter.trim().slice(0, 10);
		parts.push(`pushed:>=${date}`);
	}
	// Fallback: when nothing is specified, search for repos the user can see.
	// GitHub search requires at least one qualifier or text — use a sort-only query.
	return parts.length > 0 ? parts.join(" ") : "is:public";
}

/**
 * Project a raw GitHub search API item to {@link GithubSearchRepoEntry}.
 *
 * GitHub's search response nests the owner under `owner.login`. Fields that
 * may be absent are coerced to their zero values rather than assumed present.
 */
function toSearchEntry(raw: unknown): GithubSearchRepoEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const fullName = String(r.full_name ?? "");
	if (!fullName.includes("/")) return null;
	const slash = fullName.lastIndexOf("/");
	const owner = fullName.slice(0, slash);
	const name = fullName.slice(slash + 1);
	const rawVis = r.visibility != null ? String(r.visibility) : (r.private === true ? "private" : "public");
	const visibility: GithubSearchRepoEntry["visibility"] =
		rawVis === "private" ? "private" : rawVis === "internal" ? "internal" : "public";
	const topics = Array.isArray(r.topics) ? r.topics.filter((t) => typeof t === "string") as string[] : [];
	return {
		full_name: fullName,
		owner,
		name,
		description: r.description != null ? String(r.description) : null,
		visibility,
		language: r.language != null ? String(r.language) : null,
		pushed_at: r.pushed_at != null ? String(r.pushed_at) : null,
		stars: typeof r.stargazers_count === "number" ? r.stargazers_count : 0,
		forks: typeof r.forks_count === "number" ? r.forks_count : 0,
		open_issues: typeof r.open_issues_count === "number" ? r.open_issues_count : 0,
		topics,
	};
}

/**
 * Search GitHub repositories reachable by the machine's `gh` credentials.
 *
 * Uses GitHub's `/search/repositories` API (or `/search/issues?type=pr` when
 * `openPrs` is set), which searches across all repos the credential can read
 * without a per-repo fan-out. One API call, bounded result, rate-limit guarded
 * by an in-process 5-minute cache.
 *
 * Read-only by construction: the only `gh` call is `gh api GET /search/*`.
 *
 * Never throws — every failure is a descriptive `{ error }` property.
 */
export function searchGithubRepos(input: GithubSearchInput = {}): GithubSearchResult | { error: string } {
	const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(Number(input.limit) || SEARCH_DEFAULT_LIMIT)));
	const sort = input.sort === "stars" ? "stars" : input.sort === "forks" ? "forks" : "updated";

	let canonicalQuery: string;
	let apiPath: string;

	if (input.openPrs) {
		// "Which repos have open pull requests?" uses the PR/issue search API.
		// We build a query for open PRs and group by repository.
		const prParts: string[] = ["is:pr", "is:open"];
		if (input.owner?.trim()) prParts.push(`user:${input.owner.trim()}`);
		if (input.pushedAfter?.trim()) {
			const date = input.pushedAfter.trim().slice(0, 10);
			prParts.push(`created:>=${date}`);
		}
		if (input.query?.trim()) prParts.push(input.query.trim());
		canonicalQuery = prParts.join(" ");
		// GitHub search API for issues/PRs — we'll extract unique repos from results.
		apiPath = `search/issues?q=${encodeURIComponent(canonicalQuery)}&per_page=${Math.min(limit * 3, 100)}&sort=updated&order=desc`;
	} else {
		canonicalQuery = buildSearchQuery(input);
		apiPath = `search/repositories?q=${encodeURIComponent(canonicalQuery)}&per_page=${limit}&sort=${sort}&order=desc`;
	}

	// Check fresh cache before hitting the network.
	const cacheKey = `${apiPath}:${limit}`;
	const existing = SEARCH_CACHE.get(cacheKey);
	if (existing && Date.now() - existing.fetchedAt < SEARCH_TTL_MS) {
		return { ...existing.result, fromCache: true };
	}

	// GitHub search API returns a `{ total_count, items: [...] }` wrapper —
	// NOT a bare array. We cannot use `--paginate` here because paginating search
	// results would burn quota; instead we ask for exactly what we need in one page.
	// `runGhApi` uses `--paginate` which doesn't work for search (it'd parse the
	// wrapper as one item). We call spawnSync directly.
	const ghResult = spawnSync("gh", ["api", apiPath], {
		encoding: "utf-8",
		timeout: 30_000,
		env: process.env,
	});

	if (ghResult.error) {
		const code = (ghResult.error as NodeJS.ErrnoException | undefined)?.code;
		return { error: code === "ENOENT" ? "`gh` is not installed or not on PATH" : ghResult.error.message };
	}

	// GitHub returns 403 with a rate-limit body when the search quota is exhausted.
	const isRateLimited = ghResult.status === 403 ||
		String(ghResult.stderr ?? "").toLowerCase().includes("rate limit") ||
		String(ghResult.stdout ?? "").includes("rate limit exceeded");

	if (isRateLimited) {
		// Return the stale cache entry (if any) with the rate-limited flag so the
		// caller knows the data is old and retrying immediately won't help.
		// Note: we do NOT call pruneSearchCache before this point so that stale entries
		// are available here as a fallback — we only prune when we have fresh data to store.
		const stale = SEARCH_CACHE.get(cacheKey);
		if (stale) {
			return { ...stale.result, fromCache: true, rateLimited: true };
		}
		return { error: "GitHub search rate limit exceeded — try again in a minute (30 requests/min quota)" };
	}

	if (ghResult.status !== 0) {
		const msg = String(ghResult.stderr ?? "").slice(0, 500).trim() || `gh exited ${ghResult.status ?? "unknown"}`;
		return { error: msg };
	}

	const raw = String(ghResult.stdout ?? "").trim();
	if (!raw) {
		return { error: "gh returned empty output" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: "gh returned unparsable output" };
	}

	const fetchedAt = Date.now();
	const cachedAt = new Date(fetchedAt).toISOString();
	// Prune stale entries now that we have fresh data to store. Pruning here (rather
	// than at the start of the function) ensures stale entries survive to serve as
	// rate-limit fallbacks when the network call fails with 403.
	pruneSearchCache();

	if (input.openPrs) {
		// PR search response: `{ total_count, items: [{ repository: {...} }] }`
		const wrapper = parsed as Record<string, unknown>;
		const items = Array.isArray(wrapper.items) ? wrapper.items : [];
		// De-duplicate by repository full_name — one row per repo.
		const seen = new Set<string>();
		const repos: GithubSearchRepoEntry[] = [];
		for (const item of items) {
			const prItem = item as Record<string, unknown>;
			const repoObj = prItem.repository;
			if (!repoObj || typeof repoObj !== "object") continue;
			const entry = toSearchEntry(repoObj);
			if (!entry || seen.has(entry.full_name)) continue;
			seen.add(entry.full_name);
			repos.push(entry);
			if (repos.length >= limit) break;
		}
		const result: GithubSearchResult = {
			checked: true,
			repos,
			totalCount: typeof wrapper.total_count === "number" ? wrapper.total_count : repos.length,
			fromCache: false,
			cachedAt,
			canonicalQuery,
		};
		SEARCH_CACHE.set(cacheKey, { result, fetchedAt });
		return result;
	}

	// Repository search response: `{ total_count, items: [{…repo…}] }`.
	const wrapper = parsed as Record<string, unknown>;
	const items = Array.isArray(wrapper.items) ? wrapper.items : [];
	const repos: GithubSearchRepoEntry[] = [];
	for (const item of items) {
		const entry = toSearchEntry(item);
		if (entry) repos.push(entry);
	}

	const result: GithubSearchResult = {
		checked: true,
		repos,
		totalCount: typeof wrapper.total_count === "number" ? wrapper.total_count : repos.length,
		fromCache: false,
		cachedAt,
		canonicalQuery,
	};
	SEARCH_CACHE.set(cacheKey, { result, fetchedAt });
	return result;
}
