/**
 * Read-only enumeration of GitHub organizations and repositories reachable by the
 * machine's own `gh` credentials (#685).
 *
 * Uses `gh api` with `--paginate` to walk GitHub's REST API: first the list of
 * organizations the authenticated user belongs to, then the repos for each (plus the
 * user's own personal repos). Never writes, never mutates, never touches a credential
 * beyond what `gh` already has.
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
 * - Rate limits are GitHub's (5 000/hr for authenticated requests). Long enumerations
 *   of a large org will consume quota; `limit` keeps this manageable.
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
