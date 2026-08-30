/**
 * Unit tests for `github-browse.ts` (#685, #686, #687).
 *
 * `listGithubRepos`, `listGithubOrgs`, `searchGithubRepos`, and `getGithubRepoDetail`
 * are pure in the sense that they take input and call `gh api` — the test harness
 * stubs `spawnSync` so no network call is made and no real `gh` binary is needed.
 *
 * What is verified:
 *   - The `gh` arguments (endpoint, sort, pagination, jq projection).
 *   - Projection (`toEntry`) handles missing fields, wrong types, and GitHub's REST
 *     shape defensively.
 *   - `limit` is honoured and `hasMore` reflects whether the list was truncated.
 *   - `since` filters by `pushed_at`.
 *   - `visibility` is forwarded to the API.
 *   - Errors from `gh` (non-zero exit, missing binary, unparsable output) surface as
 *     `{ error }` rather than throwing.
 *   - Read-only: the `gh` command is ALWAYS `gh api` (never a write verb).
 *   - Search (#686): GitHub search API used (no per-repo fan-out), caching, rate-limit
 *     handling, qualifier building, openPrs pivot to issue search, isolation between cases.
 *   - Detail (#687): issues, PRs, branches fetched per-repo; PR/issue filter; draft flag;
 *     merged PR detection; label projection; caching; invalid slug rejection; isolation.
 */
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertReadOnlyGhApiArgs, clearDetailCacheForTesting, clearSearchCacheForTesting, getGithubCredentialScope, getGithubRepoDetail, listGithubOrgs, listGithubRepos, searchGithubRepos } from "./github-browse.js";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

const mockSpawn = vi.mocked(spawnSync);

/** Build a synthetic `spawnSync` return for a successful `gh api --paginate` call. */
function success(repos: object[]) {
	return {
		status: 0,
		stdout: JSON.stringify(repos),
		stderr: "",
		error: undefined,
	};
}

function fail(stderr: string, status = 1) {
	return { status, stdout: "", stderr, error: undefined };
}

function noGh() {
	return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) };
}

/** A minimal repo object as GitHub returns it. */
function ghRepo(overrides: Partial<{
	full_name: string;
	visibility: string;
	default_branch: string;
	pushed_at: string;
	language: string;
}> = {}) {
	return {
		full_name: "serge-ivo/my-app",
		visibility: "public",
		default_branch: "main",
		pushed_at: "2026-08-01T10:00:00Z",
		language: "TypeScript",
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	// Clear the in-process caches so no cached result bleeds between test cases.
	clearSearchCacheForTesting();
	clearDetailCacheForTesting();
});

describe("listGithubRepos — personal repos", () => {
	it("calls gh api for the authenticated user's repos when no owner is given", () => {
		mockSpawn.mockReturnValue(success([ghRepo()]));
		listGithubRepos({});
		expect(mockSpawn).toHaveBeenCalledOnce();
		const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("gh");
		// Must be a read-only API call
		expect(args[0]).toBe("api");
		expect(args[1]).toBe("--paginate");
		// Must target the user/repos endpoint
		expect(args.some((a) => String(a).includes("user/repos"))).toBe(true);
		// Must sort by pushed, descending
		expect(args.some((a) => String(a).includes("sort=pushed"))).toBe(true);
		expect(args.some((a) => String(a).includes("direction=desc"))).toBe(true);
	});

	it("calls gh api for a specific org when owner is given", () => {
		mockSpawn.mockReturnValue(success([ghRepo({ full_name: "my-org/repo-a" })]));
		listGithubRepos({ owner: "my-org" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args.some((a) => String(a).includes("orgs/my-org/repos"))).toBe(true);
	});

	it("returns repos with the expected fields", () => {
		mockSpawn.mockReturnValue(success([
			ghRepo({ full_name: "serge-ivo/alpha", visibility: "public", language: "TypeScript", pushed_at: "2026-08-10T00:00:00Z" }),
			ghRepo({ full_name: "serge-ivo/beta", visibility: "private", language: null, pushed_at: "2026-07-01T00:00:00Z" }),
		]));
		const result = listGithubRepos({ limit: 10 });
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.checked).toBe(true);
		expect(result.repos).toHaveLength(2);
		expect(result.repos[0]).toMatchObject({
			owner: "serge-ivo",
			name: "alpha",
			full_name: "serge-ivo/alpha",
			visibility: "public",
			default_branch: "main",
			pushed_at: "2026-08-10T00:00:00Z",
			language: "TypeScript",
		});
		expect(result.repos[1].visibility).toBe("private");
		expect(result.repos[1].language).toBeNull();
	});

	it("honours limit and sets hasMore when the list is truncated", () => {
		const many = Array.from({ length: 80 }, (_, i) => ghRepo({ full_name: `org/repo-${i}` }));
		mockSpawn.mockReturnValue(success(many));
		const result = listGithubRepos({ limit: 25 });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(25);
		expect(result.hasMore).toBe(true);
		expect(result.total).toBe(80);
	});

	it("sets hasMore=false when the list fits within limit", () => {
		mockSpawn.mockReturnValue(success([ghRepo(), ghRepo({ full_name: "org/b" })]));
		const result = listGithubRepos({ limit: 50 });
		if ("error" in result) throw new Error("expected success");
		expect(result.hasMore).toBe(false);
		expect(result.repos).toHaveLength(2);
	});

	it("applies the since filter by pushed_at", () => {
		const recent = ghRepo({ full_name: "org/new", pushed_at: "2026-08-15T00:00:00Z" });
		const old = ghRepo({ full_name: "org/old", pushed_at: "2025-01-01T00:00:00Z" });
		mockSpawn.mockReturnValue(success([recent, old]));
		const result = listGithubRepos({ since: "2026-01-01T00:00:00Z", limit: 50 });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(1);
		expect(result.repos[0].name).toBe("new");
	});

	it("forwards the visibility=private filter to the API", () => {
		mockSpawn.mockReturnValue(success([]));
		listGithubRepos({ visibility: "private" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args.some((a) => String(a).includes("visibility=private"))).toBe(true);
	});

	it("defaults visibility to all", () => {
		mockSpawn.mockReturnValue(success([]));
		listGithubRepos({});
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args.some((a) => String(a).includes("visibility=all"))).toBe(true);
	});

	it("applies a hard cap of 200 on limit", () => {
		const many = Array.from({ length: 300 }, (_, i) => ghRepo({ full_name: `org/r${i}` }));
		mockSpawn.mockReturnValue(success(many));
		const result = listGithubRepos({ limit: 999 });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(200);
	});

	it("defaults to limit=50 when not specified", () => {
		const many = Array.from({ length: 100 }, (_, i) => ghRepo({ full_name: `org/r${i}` }));
		mockSpawn.mockReturnValue(success(many));
		const result = listGithubRepos({});
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(50);
	});

	it("skips malformed items and carries on", () => {
		mockSpawn.mockReturnValue(success([
			null,
			{ full_name: 123 }, // no slash in full_name → filtered
			ghRepo({ full_name: "org/ok" }),
		]));
		const result = listGithubRepos({ limit: 10 });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(1);
		expect(result.repos[0].name).toBe("ok");
	});

	it("returns an error when gh is not installed", () => {
		mockSpawn.mockReturnValue(noGh());
		const result = listGithubRepos({});
		expect(result).toHaveProperty("error");
		if (!("error" in result)) return;
		expect(result.error).toMatch(/not installed/i);
	});

	it("returns an error when gh exits non-zero", () => {
		mockSpawn.mockReturnValue(fail("authentication required: please run `gh auth login`"));
		const result = listGithubRepos({});
		expect(result).toHaveProperty("error");
	});

	it("returns an error when gh produces unparsable output", () => {
		mockSpawn.mockReturnValue({ status: 0, stdout: "not json at all", stderr: "", error: undefined });
		const result = listGithubRepos({});
		expect(result).toHaveProperty("error");
	});

	it("returns empty list when gh returns an empty array", () => {
		mockSpawn.mockReturnValue(success([]));
		const result = listGithubRepos({});
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(0);
		expect(result.hasMore).toBe(false);
		expect(result.total).toBe(0);
	});
});

describe("listGithubOrgs", () => {
	it("calls gh api for the user's orgs", () => {
		mockSpawn.mockReturnValue(success([{ login: "my-org" }]));
		listGithubOrgs();
		const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("gh");
		expect(args[0]).toBe("api");
		expect(args.some((a) => String(a).includes("user/orgs"))).toBe(true);
	});

	it("returns an array of org login names", () => {
		mockSpawn.mockReturnValue(success([{ login: "org-a" }, { login: "org-b" }]));
		const result = listGithubOrgs();
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.orgs).toEqual(["org-a", "org-b"]);
	});

	it("returns an error when gh fails", () => {
		mockSpawn.mockReturnValue(fail("gh: Not Found (HTTP 404)"));
		const result = listGithubOrgs();
		expect(result).toHaveProperty("error");
	});

	it("returns an empty list when the user is in no orgs", () => {
		mockSpawn.mockReturnValue(success([]));
		const result = listGithubOrgs();
		if ("error" in result) throw new Error("expected success");
		expect(result.orgs).toEqual([]);
	});
});

describe("read-only invariant", () => {
	it("only ever calls `gh api` — never a write verb", () => {
		mockSpawn.mockReturnValue(success([]));
		listGithubRepos({});
		listGithubRepos({ owner: "some-org" });
		listGithubOrgs();
		for (const call of mockSpawn.mock.calls) {
			const [cmd, args] = call as [string, string[]];
			expect(cmd).toBe("gh");
			// The second arg must be "api" (the read-only subcommand). Write verbs
			// are two-word ("pr create", "issue close", etc.) — never a bare "api".
			expect(args[0]).toBe("api");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// searchGithubRepos — #686
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a synthetic `spawnSync` return for a successful `gh api` search call.
 *
 * GitHub's search API returns `{ total_count, items: [...] }` rather than a bare
 * array, so this helper wraps the items in the correct envelope.
 */
function searchSuccess(items: object[], totalCount = items.length) {
	return {
		status: 0,
		stdout: JSON.stringify({ total_count: totalCount, items }),
		stderr: "",
		error: undefined,
	};
}

/** A minimal search result item as GitHub returns it from `/search/repositories`. */
function ghSearchRepo(overrides: Partial<{
	full_name: string;
	visibility: string;
	language: string | null;
	pushed_at: string;
	description: string | null;
	stargazers_count: number;
	forks_count: number;
	open_issues_count: number;
	topics: string[];
	private: boolean;
}> = {}) {
	return {
		full_name: "serge-ivo/my-repo",
		visibility: "public",
		language: "TypeScript",
		pushed_at: "2026-08-20T10:00:00Z",
		description: "A test repo",
		stargazers_count: 42,
		forks_count: 5,
		open_issues_count: 3,
		topics: ["typescript", "testing"],
		private: false,
		...overrides,
	};
}

describe("searchGithubRepos — basic", () => {
	it("calls gh api search/repositories (no --paginate) with the query", () => {
		mockSpawn.mockReturnValue(searchSuccess([ghSearchRepo()]));
		searchGithubRepos({ query: "react hooks" });
		expect(mockSpawn).toHaveBeenCalledOnce();
		const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("gh");
		// Must be a read-only API call — no --paginate (search is one page)
		expect(args[0]).toBe("api");
		expect(args[1]).not.toBe("--paginate");
		// Must target the search/repositories endpoint
		expect(args[1]).toMatch(/search\/repositories/);
		// Must include the query
		expect(args[1]).toMatch(/react/);
	});

	it("returns repos with the expected search fields", () => {
		mockSpawn.mockReturnValue(searchSuccess([
			ghSearchRepo({ full_name: "serge-ivo/alpha", language: "TypeScript", stargazers_count: 10 }),
		]));
		const result = searchGithubRepos({ query: "alpha" });
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.checked).toBe(true);
		expect(result.repos).toHaveLength(1);
		const repo = result.repos[0];
		expect(repo.full_name).toBe("serge-ivo/alpha");
		expect(repo.owner).toBe("serge-ivo");
		expect(repo.name).toBe("alpha");
		expect(repo.language).toBe("TypeScript");
		expect(typeof repo.stars).toBe("number");
		expect(typeof repo.forks).toBe("number");
		expect(typeof repo.open_issues).toBe("number");
		expect(Array.isArray(repo.topics)).toBe(true);
	});

	it("returns totalCount from the search envelope", () => {
		mockSpawn.mockReturnValue(searchSuccess([ghSearchRepo()], 999));
		const result = searchGithubRepos({ query: "test" });
		if ("error" in result) throw new Error("expected success");
		expect(result.totalCount).toBe(999);
		expect(result.repos).toHaveLength(1);
	});

	it("honours limit (default 30) — does not pass --paginate", () => {
		// 50 items in response but limit is 30 (default)
		const items = Array.from({ length: 50 }, (_, i) => ghSearchRepo({ full_name: `org/repo-${i}` }));
		mockSpawn.mockReturnValue(searchSuccess(items, 50));
		const result = searchGithubRepos({});
		if ("error" in result) throw new Error("expected success");
		// GitHub caps search to what we asked for (per_page=30); runner returns all items
		// from the response — if GitHub returned 50 despite per_page=30, the runner returns all 50.
		// What matters is that the API was called with per_page=30.
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args[1]).toMatch(/per_page=30/);
	});

	it("applies a hard cap of 100 on limit", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		searchGithubRepos({ limit: 999 });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args[1]).toMatch(/per_page=100/);
	});

	it("appends user: qualifier when owner is given", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		searchGithubRepos({ owner: "my-org" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(decodeURIComponent(args[1])).toMatch(/user:my-org/);
	});

	it("appends language: qualifier", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		searchGithubRepos({ language: "Python" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(decodeURIComponent(args[1])).toMatch(/language:Python/);
	});

	it("appends topic: qualifier", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		searchGithubRepos({ topic: "machine-learning" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(decodeURIComponent(args[1])).toMatch(/topic:machine-learning/);
	});

	it("appends pushed: qualifier for pushedAfter", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		searchGithubRepos({ pushedAfter: "2026-01-15T00:00:00Z" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		// Date part only (time stripped)
		expect(decodeURIComponent(args[1])).toMatch(/pushed:>=2026-01-15/);
	});

	it("forwards the sort parameter", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		searchGithubRepos({ sort: "stars" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args[1]).toMatch(/sort=stars/);
	});

	it("defaults sort to updated", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		searchGithubRepos({});
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args[1]).toMatch(/sort=updated/);
	});

	it("returns an error when gh is not installed", () => {
		mockSpawn.mockReturnValue({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) });
		const result = searchGithubRepos({ query: "test" });
		expect(result).toHaveProperty("error");
		if (!("error" in result)) return;
		expect(result.error).toMatch(/not installed/i);
	});

	it("returns an error when gh exits non-zero", () => {
		mockSpawn.mockReturnValue({ status: 1, stdout: "", stderr: "authentication required", error: undefined });
		const result = searchGithubRepos({ query: "test" });
		expect(result).toHaveProperty("error");
	});

	it("returns an error when gh produces unparsable output", () => {
		mockSpawn.mockReturnValue({ status: 0, stdout: "not json", stderr: "", error: undefined });
		const result = searchGithubRepos({ query: "test" });
		expect(result).toHaveProperty("error");
	});

	it("returns an error when gh returns empty output", () => {
		mockSpawn.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined });
		const result = searchGithubRepos({ query: "test" });
		expect(result).toHaveProperty("error");
	});

	it("handles response with no items gracefully", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		const result = searchGithubRepos({ query: "very-obscure-thing" });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(0);
		expect(result.totalCount).toBe(0);
	});

	it("skips malformed items and carries on", () => {
		mockSpawn.mockReturnValue(searchSuccess([
			null as unknown as object,
			{ full_name: 123 } as object, // no slash → filtered
			ghSearchRepo({ full_name: "org/ok" }),
		]));
		const result = searchGithubRepos({ query: "test" });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(1);
		expect(result.repos[0].name).toBe("ok");
	});

	it("handles private repos correctly", () => {
		mockSpawn.mockReturnValue(searchSuccess([ghSearchRepo({ visibility: "private", private: true })]));
		const result = searchGithubRepos({ query: "private" });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos[0].visibility).toBe("private");
	});
});

describe("searchGithubRepos — caching", () => {
	it("returns fromCache:false on first call", () => {
		mockSpawn.mockReturnValue(searchSuccess([ghSearchRepo()]));
		const result = searchGithubRepos({ query: "test" });
		if ("error" in result) throw new Error("expected success");
		expect(result.fromCache).toBe(false);
	});

	it("returns fromCache:true and does not call gh on a cache hit", () => {
		mockSpawn.mockReturnValue(searchSuccess([ghSearchRepo()]));
		// First call — populates cache
		const first = searchGithubRepos({ query: "cached-query" });
		if ("error" in first) throw new Error("expected success on first call");
		expect(first.fromCache).toBe(false);

		// Second call with the same query — should hit cache
		const second = searchGithubRepos({ query: "cached-query" });
		if ("error" in second) throw new Error("expected success on second call");
		expect(second.fromCache).toBe(true);
		// gh should only have been called once total
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	it("makes a fresh call when the query differs", () => {
		mockSpawn.mockReturnValue(searchSuccess([ghSearchRepo()]));
		searchGithubRepos({ query: "query-a" });
		searchGithubRepos({ query: "query-b" });
		expect(mockSpawn).toHaveBeenCalledTimes(2);
	});

	it("returns cachedAt as an ISO string", () => {
		mockSpawn.mockReturnValue(searchSuccess([ghSearchRepo()]));
		const result = searchGithubRepos({ query: "timestamp-test" });
		if ("error" in result) throw new Error("expected success");
		expect(result.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("searchGithubRepos — rate limiting", () => {
	it("returns an error when gh exits 403 and no cache exists", () => {
		mockSpawn.mockReturnValue({ status: 403, stdout: "", stderr: "rate limit exceeded", error: undefined });
		const result = searchGithubRepos({ query: "rate-limited-query-no-cache" });
		expect(result).toHaveProperty("error");
		if (!("error" in result)) return;
		expect(result.error).toMatch(/rate limit/i);
	});

	it("returns stale cache with rateLimited:true when 403 and stale cache exists", () => {
		vi.useFakeTimers();
		try {
			// First call succeeds and populates cache.
			mockSpawn.mockReturnValueOnce(searchSuccess([ghSearchRepo()]));
			const first = searchGithubRepos({ query: "rate-then-limit-stale" });
			if ("error" in first) throw new Error("expected success on first call");

			// Advance time past the 5-minute TTL so the cache is stale but the entry
			// is still in the Map (pruneSearchCache only removes entries when a new
			// search runs — we haven't run a different query yet to trigger pruning).
			// The SEARCH_CACHE still holds the old entry; Date.now() is now > fetchedAt + TTL.
			vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes

			// Second call — cache is stale, so we call gh again; it returns 403.
			// The stale entry is still in the Map and gets returned with rateLimited:true.
			mockSpawn.mockReturnValueOnce({ status: 403, stdout: "", stderr: "rate limit exceeded", error: undefined });
			const second = searchGithubRepos({ query: "rate-then-limit-stale" });
			if ("error" in second) throw new Error("expected success with stale cache");
			expect(second.rateLimited).toBe(true);
			expect(second.fromCache).toBe(true);
			// Data is still there from the first call
			expect(second.repos).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("searchGithubRepos — openPrs pivot", () => {
	it("calls search/issues (not search/repositories) when openPrs is true", () => {
		// PR search response has items with a `repository` field
		const prItem = {
			id: 1,
			title: "Fix bug",
			state: "open",
			repository: ghSearchRepo({ full_name: "org/repo-with-prs" }),
		};
		mockSpawn.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({ total_count: 1, items: [prItem] }),
			stderr: "",
			error: undefined,
		});
		searchGithubRepos({ openPrs: true });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args[1]).toMatch(/search\/issues/);
		expect(decodeURIComponent(args[1])).toMatch(/is:pr/);
		expect(decodeURIComponent(args[1])).toMatch(/is:open/);
	});

	it("de-duplicates repos when multiple PRs belong to the same repo", () => {
		const sharedRepo = ghSearchRepo({ full_name: "org/shared-repo" });
		const items = [
			{ id: 1, title: "PR 1", state: "open", repository: sharedRepo },
			{ id: 2, title: "PR 2", state: "open", repository: sharedRepo },
			{ id: 3, title: "PR 3", state: "open", repository: ghSearchRepo({ full_name: "org/other-repo" }) },
		];
		mockSpawn.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({ total_count: 3, items }),
			stderr: "",
			error: undefined,
		});
		const result = searchGithubRepos({ openPrs: true });
		if ("error" in result) throw new Error("expected success");
		// Two distinct repos despite three PRs
		expect(result.repos).toHaveLength(2);
		const names = result.repos.map((r) => r.full_name);
		expect(names).toContain("org/shared-repo");
		expect(names).toContain("org/other-repo");
	});
});

describe("searchGithubRepos — read-only invariant", () => {
	it("only ever calls `gh api` — never a write verb", () => {
		mockSpawn.mockReturnValue(searchSuccess([]));
		searchGithubRepos({ query: "test" });
		searchGithubRepos({ owner: "my-org", language: "Go" });
		searchGithubRepos({ openPrs: true });
		for (const call of mockSpawn.mock.calls) {
			const [cmd, args] = call as [string, string[]];
			expect(cmd).toBe("gh");
			expect(args[0]).toBe("api");
			// Must not use --paginate (search is bounded)
			expect(args).not.toContain("--paginate");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getGithubRepoDetail — #687
// ─────────────────────────────────────────────────────────────────────────────

/** Build a synthetic `spawnSync` return for a successful single-page `gh api` call. */
function detailSuccess(payload: object) {
	return { status: 0, stdout: JSON.stringify(payload), stderr: "", error: undefined };
}

/** A minimal GitHub issue object. */
function ghIssue(overrides: Partial<{
	number: number; title: string; state: string; created_at: string; updated_at: string;
	labels: object[]; assignee: object | null; user: object; pull_request: object;
}> = {}) {
	return {
		number: 1,
		title: "Fix the bug",
		state: "open",
		created_at: "2026-08-01T00:00:00Z",
		updated_at: "2026-08-20T00:00:00Z",
		labels: [{ name: "bug" }],
		assignee: null,
		user: { login: "dev-user" },
		...overrides,
	};
}

/** A minimal GitHub pull request object. */
function ghPull(overrides: Partial<{
	number: number; title: string; state: string; created_at: string; updated_at: string;
	head: object; base: object; draft: boolean; labels: object[]; user: object; merged_at: string | null;
}> = {}) {
	return {
		number: 10,
		title: "Add feature",
		state: "open",
		created_at: "2026-08-05T00:00:00Z",
		updated_at: "2026-08-21T00:00:00Z",
		head: { ref: "feat/my-feature" },
		base: { ref: "main" },
		draft: false,
		labels: [],
		user: { login: "pr-author" },
		merged_at: null,
		...overrides,
	};
}

/** A minimal GitHub branch object. */
function ghBranch(overrides: Partial<{ name: string; commit: object; protected: boolean }> = {}) {
	return {
		name: "main",
		commit: { sha: "abc1234567890" },
		protected: false,
		...overrides,
	};
}

/**
 * Set up `mockSpawn` to return three successive detail responses: issues, then PRs, then branches.
 * The runner calls gh three times for one detail request (one per list).
 */
function setupDetailMocks(issues: object[], pulls: object[], branches: object[]) {
	mockSpawn
		.mockReturnValueOnce(detailSuccess(issues))
		.mockReturnValueOnce(detailSuccess(pulls))
		.mockReturnValueOnce(detailSuccess(branches));
}

describe("getGithubRepoDetail — basic", () => {
	it("returns checked:true with the expected shape", () => {
		setupDetailMocks([ghIssue()], [ghPull()], [ghBranch()]);
		const result = getGithubRepoDetail({ repo: "serge-ivo/my-app" });
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.checked).toBe(true);
		expect(result.repo).toBe("serge-ivo/my-app");
		expect(Array.isArray(result.issues)).toBe(true);
		expect(Array.isArray(result.pulls)).toBe(true);
		expect(Array.isArray(result.branches)).toBe(true);
		expect(typeof result.cachedAt).toBe("string");
		expect(result.fromCache).toBe(false);
	});

	it("calls gh api for issues, pulls, and branches — three separate requests", () => {
		setupDetailMocks([], [], []);
		getGithubRepoDetail({ repo: "org/repo" });
		expect(mockSpawn).toHaveBeenCalledTimes(3);
		const paths = mockSpawn.mock.calls.map(([, args]) => (args as string[])[1]);
		expect(paths[0]).toMatch(/repos\/org\/repo\/issues/);
		expect(paths[1]).toMatch(/repos\/org\/repo\/pulls/);
		expect(paths[2]).toMatch(/repos\/org\/repo\/branches/);
	});

	it("never calls gh api with --paginate (bounded to per_page)", () => {
		setupDetailMocks([], [], []);
		getGithubRepoDetail({ repo: "org/repo" });
		for (const [, args] of mockSpawn.mock.calls) {
			expect(args as string[]).not.toContain("--paginate");
		}
	});

	it("projects an issue to the expected fields", () => {
		setupDetailMocks([ghIssue({ number: 42, title: "Crash on startup", state: "open",
			labels: [{ name: "critical" }, { name: "bug" }], assignee: { login: "assignee-user" } })], [], []);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		const issue = result.issues[0];
		expect(issue.number).toBe(42);
		expect(issue.title).toBe("Crash on startup");
		expect(issue.state).toBe("open");
		expect(issue.author).toBe("dev-user");
		expect(issue.labels).toEqual(["critical", "bug"]);
		expect(issue.assignee).toBe("assignee-user");
	});

	it("projects a pull request to the expected fields", () => {
		setupDetailMocks([], [ghPull({ number: 99, title: "Big refactor", head: { ref: "refactor/big" },
			base: { ref: "develop" }, draft: true })], []);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		const pull = result.pulls[0];
		expect(pull.number).toBe(99);
		expect(pull.title).toBe("Big refactor");
		expect(pull.head_branch).toBe("refactor/big");
		expect(pull.base_branch).toBe("develop");
		expect(pull.draft).toBe(true);
	});

	it("marks a PR as merged when merged_at is set", () => {
		setupDetailMocks([], [ghPull({ state: "closed", merged_at: "2026-08-10T12:00:00Z" })], []);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		expect(result.pulls[0].state).toBe("merged");
	});

	it("marks a PR as closed when state is closed and merged_at is null", () => {
		setupDetailMocks([], [ghPull({ state: "closed", merged_at: null })], []);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		expect(result.pulls[0].state).toBe("closed");
	});

	it("projects a branch to the expected fields", () => {
		setupDetailMocks([], [], [ghBranch({ name: "release/v2", commit: { sha: "deadbeef" }, protected: true })]);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		const branch = result.branches[0];
		expect(branch.name).toBe("release/v2");
		expect(branch.sha).toBe("deadbeef");
		expect(branch.protected).toBe(true);
	});

	it("excludes pull requests from the issues list (GitHub returns PRs in /issues)", () => {
		// An issue item with a `pull_request` key — should be excluded from issues
		const issueWithPr = ghIssue({ pull_request: { url: "https://api.github.com/repos/org/repo/pulls/5" } });
		const realIssue = ghIssue({ number: 2, title: "Real issue" });
		setupDetailMocks([issueWithPr, realIssue], [], []);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].title).toBe("Real issue");
	});

	it("includes the state filter in the issues and pulls requests", () => {
		setupDetailMocks([], [], []);
		getGithubRepoDetail({ repo: "org/repo", state: "all" });
		const issuePath = (mockSpawn.mock.calls[0][1] as string[])[1];
		const pullsPath = (mockSpawn.mock.calls[1][1] as string[])[1];
		expect(issuePath).toMatch(/state=all/);
		expect(pullsPath).toMatch(/state=all/);
	});

	it("defaults to state=open", () => {
		setupDetailMocks([], [], []);
		getGithubRepoDetail({ repo: "org/repo" });
		const issuePath = (mockSpawn.mock.calls[0][1] as string[])[1];
		expect(issuePath).toMatch(/state=open/);
	});

	it("honours the limit and includes it in the per_page param", () => {
		setupDetailMocks([], [], []);
		getGithubRepoDetail({ repo: "org/repo", limit: 10 });
		for (const [, args] of mockSpawn.mock.calls) {
			expect((args as string[])[1]).toMatch(/per_page=10/);
		}
	});

	it("caps limit at 100", () => {
		setupDetailMocks([], [], []);
		getGithubRepoDetail({ repo: "org/repo", limit: 999 });
		for (const [, args] of mockSpawn.mock.calls) {
			expect((args as string[])[1]).toMatch(/per_page=100/);
		}
	});

	it("skips malformed issue/PR/branch items and carries on", () => {
		setupDetailMocks(
			[null as unknown as object, { number: "not-a-number" }, ghIssue({ number: 3 })],
			[null as unknown as object, ghPull()],
			[null as unknown as object, ghBranch()],
		);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		expect(result.issues).toHaveLength(1);
		expect(result.pulls).toHaveLength(1);
		expect(result.branches).toHaveLength(1);
	});

	it("handles empty lists gracefully", () => {
		setupDetailMocks([], [], []);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		expect(result.issues).toHaveLength(0);
		expect(result.pulls).toHaveLength(0);
		expect(result.branches).toHaveLength(0);
	});
});

describe("getGithubRepoDetail — input validation", () => {
	it("returns an error when repo is empty", () => {
		const result = getGithubRepoDetail({ repo: "" });
		expect(result).toHaveProperty("error");
		// Must not call gh at all
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("returns an error when repo has no slash", () => {
		const result = getGithubRepoDetail({ repo: "noslash" });
		expect(result).toHaveProperty("error");
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("returns an error when repo has too many slashes", () => {
		const result = getGithubRepoDetail({ repo: "org/owner/repo" });
		expect(result).toHaveProperty("error");
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

describe("getGithubRepoDetail — error handling", () => {
	it("returns an error when gh is not installed", () => {
		mockSpawn.mockReturnValue({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) });
		const result = getGithubRepoDetail({ repo: "org/repo" });
		expect(result).toHaveProperty("error");
		if (!("error" in result)) return;
		expect(result.error).toMatch(/not installed/i);
	});

	it("returns an error when gh exits non-zero on issues", () => {
		mockSpawn.mockReturnValue({ status: 1, stdout: "", stderr: "Not Found", error: undefined });
		const result = getGithubRepoDetail({ repo: "org/missing" });
		expect(result).toHaveProperty("error");
	});

	it("returns an error when gh exits non-zero on pulls", () => {
		mockSpawn
			.mockReturnValueOnce(detailSuccess([]))
			.mockReturnValueOnce({ status: 1, stdout: "", stderr: "Not Found", error: undefined });
		const result = getGithubRepoDetail({ repo: "org/repo" });
		expect(result).toHaveProperty("error");
	});

	it("returns an error when gh exits non-zero on branches", () => {
		mockSpawn
			.mockReturnValueOnce(detailSuccess([]))
			.mockReturnValueOnce(detailSuccess([]))
			.mockReturnValueOnce({ status: 1, stdout: "", stderr: "Not Found", error: undefined });
		const result = getGithubRepoDetail({ repo: "org/repo" });
		expect(result).toHaveProperty("error");
	});

	it("returns an error when gh produces unparsable output", () => {
		mockSpawn.mockReturnValue({ status: 0, stdout: "not json", stderr: "", error: undefined });
		const result = getGithubRepoDetail({ repo: "org/repo" });
		expect(result).toHaveProperty("error");
	});
});

describe("getGithubRepoDetail — caching", () => {
	it("returns fromCache:false on first call", () => {
		setupDetailMocks([ghIssue()], [ghPull()], [ghBranch()]);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		expect(result.fromCache).toBe(false);
	});

	it("returns fromCache:true and does not call gh on a cache hit", () => {
		setupDetailMocks([ghIssue()], [ghPull()], [ghBranch()]);
		const first = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in first) throw new Error("expected success on first call");
		expect(first.fromCache).toBe(false);
		expect(mockSpawn).toHaveBeenCalledTimes(3); // three gh calls

		const second = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in second) throw new Error("expected success on second call");
		expect(second.fromCache).toBe(true);
		// No additional gh calls
		expect(mockSpawn).toHaveBeenCalledTimes(3);
	});

	it("makes fresh calls when the repo slug differs", () => {
		setupDetailMocks([], [], []);
		getGithubRepoDetail({ repo: "org/repo-a" });
		setupDetailMocks([], [], []);
		getGithubRepoDetail({ repo: "org/repo-b" });
		// 3 + 3 = 6 calls total
		expect(mockSpawn).toHaveBeenCalledTimes(6);
	});

	it("returns cachedAt as an ISO string", () => {
		setupDetailMocks([], [], []);
		const result = getGithubRepoDetail({ repo: "org/repo" });
		if ("error" in result) throw new Error("expected success");
		expect(result.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("getGithubRepoDetail — read-only invariant", () => {
	it("only ever calls `gh api` — never a write verb", () => {
		setupDetailMocks([ghIssue()], [ghPull()], [ghBranch()]);
		getGithubRepoDetail({ repo: "org/repo" });
		for (const [cmd, args] of mockSpawn.mock.calls) {
			expect(cmd).toBe("gh");
			expect((args as string[])[0]).toBe("api");
			expect(args as string[]).not.toContain("--paginate");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// assertReadOnlyGhApiArgs — #688 runtime read-only guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The guard is the single enforcement mechanism for the read-only invariant of this
 * module (#688). These tests pin that it:
 *
 *   - Returns `{ error }` for every write HTTP method.
 *   - Returns `undefined` for GET and HEAD (safe) and for no method at all (gh defaults GET).
 *   - Is case-insensitive (a lowercase "post" is also refused).
 *   - Handles all three forms: `-X POST`, `--method POST`, `--method=POST`.
 *   - Does not refuse a path that happens to contain a method word (e.g. "repos/post-repo").
 */
describe("assertReadOnlyGhApiArgs — runtime read-only guard (#688)", () => {
	it("returns undefined when no method flag is present", () => {
		expect(assertReadOnlyGhApiArgs(["user/repos?sort=pushed"])).toBeUndefined();
		expect(assertReadOnlyGhApiArgs(["--paginate", "user/orgs", "--jq", "[.[]]"])).toBeUndefined();
		expect(assertReadOnlyGhApiArgs([])).toBeUndefined();
	});

	it("returns undefined for GET (explicit)", () => {
		expect(assertReadOnlyGhApiArgs(["-X", "GET", "user/repos"])).toBeUndefined();
		expect(assertReadOnlyGhApiArgs(["--method", "GET", "user/repos"])).toBeUndefined();
		expect(assertReadOnlyGhApiArgs(["--method=GET", "user/repos"])).toBeUndefined();
	});

	it("returns undefined for HEAD", () => {
		expect(assertReadOnlyGhApiArgs(["-X", "HEAD", "user/repos"])).toBeUndefined();
	});

	it("returns { error } for POST via -X", () => {
		const result = assertReadOnlyGhApiArgs(["-X", "POST", "repos/org/repo/issues", "-f", "title=x"]);
		expect(result).toHaveProperty("error");
		expect(result?.error).toMatch(/POST/);
		expect(result?.error).toMatch(/read-only/);
	});

	it("returns { error } for POST via --method", () => {
		const result = assertReadOnlyGhApiArgs(["--method", "POST", "repos/org/repo/issues"]);
		expect(result).toHaveProperty("error");
		expect(result?.error).toMatch(/POST/);
	});

	it("returns { error } for POST via --method=", () => {
		const result = assertReadOnlyGhApiArgs(["--method=POST", "repos/org/repo/issues"]);
		expect(result).toHaveProperty("error");
		expect(result?.error).toMatch(/POST/);
	});

	it("returns { error } for PATCH, PUT, DELETE", () => {
		for (const method of ["PATCH", "PUT", "DELETE"]) {
			const result = assertReadOnlyGhApiArgs(["-X", method, "repos/org/repo"]);
			expect(result, method).toHaveProperty("error");
			expect(result?.error).toMatch(new RegExp(method));
		}
	});

	it("is case-insensitive — lowercase write methods are also refused", () => {
		const result = assertReadOnlyGhApiArgs(["-X", "post", "repos/org/repo/issues"]);
		expect(result).toHaveProperty("error");
		expect(result?.error).toMatch(/POST/);
	});

	it("does not refuse a path containing a method word as a substring", () => {
		// "repos/delete-me" — the path contains "delete" but no method flag is present.
		expect(assertReadOnlyGhApiArgs(["repos/delete-me"])).toBeUndefined();
		expect(assertReadOnlyGhApiArgs(["repos/post-hook/branches"])).toBeUndefined();
	});

	it("reads the last --method flag when multiple are supplied (last-wins)", () => {
		// An unusual case, but the guard must not refuse based on an earlier safe flag
		// when a later write flag overrides it (and vice versa).
		const result = assertReadOnlyGhApiArgs(["--method=GET", "--method=POST", "path"]);
		expect(result).toHaveProperty("error"); // POST wins
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getGithubCredentialScope — #688 credential scope surface
// ─────────────────────────────────────────────────────────────────────────────

describe("getGithubCredentialScope (#688)", () => {
	it("returns the authenticated login and org list", () => {
		// First call: gh api user → returns the user object
		mockSpawn.mockReturnValueOnce({
			status: 0,
			stdout: JSON.stringify({ login: "serge-ivo", id: 12345, type: "User" }),
			stderr: "",
			error: undefined,
		});
		// Second call: gh api --paginate user/orgs --jq ... → returns org list
		mockSpawn.mockReturnValueOnce({
			status: 0,
			stdout: JSON.stringify([{ login: "ProAgentStore" }, { login: "my-org" }]),
			stderr: "",
			error: undefined,
		});
		const result = getGithubCredentialScope();
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.checked).toBe(true);
		expect(result.login).toBe("serge-ivo");
		expect(result.orgs).toEqual(["ProAgentStore", "my-org"]);
	});

	it("returns login with empty orgs when the user belongs to no orgs", () => {
		mockSpawn.mockReturnValueOnce({
			status: 0,
			stdout: JSON.stringify({ login: "solo-dev" }),
			stderr: "",
			error: undefined,
		});
		mockSpawn.mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "", error: undefined });
		const result = getGithubCredentialScope();
		if ("error" in result) throw new Error("expected success");
		expect(result.login).toBe("solo-dev");
		expect(result.orgs).toEqual([]);
	});

	it("returns { error } when gh api user fails (not authenticated)", () => {
		mockSpawn.mockReturnValueOnce({
			status: 1,
			stdout: "",
			stderr: "Not Found (HTTP 404)",
			error: undefined,
		});
		const result = getGithubCredentialScope();
		expect(result).toHaveProperty("error");
	});

	it("returns { error } when gh is not installed", () => {
		mockSpawn.mockReturnValue({
			status: null, stdout: "", stderr: "",
			error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
		});
		const result = getGithubCredentialScope();
		expect(result).toHaveProperty("error");
		if (!("error" in result)) return;
		expect(result.error).toMatch(/not installed/i);
	});

	it("returns { error } when the orgs call fails", () => {
		mockSpawn.mockReturnValueOnce({
			status: 0,
			stdout: JSON.stringify({ login: "dev" }),
			stderr: "",
			error: undefined,
		});
		mockSpawn.mockReturnValueOnce({
			status: 1,
			stdout: "",
			stderr: "authentication required",
			error: undefined,
		});
		const result = getGithubCredentialScope();
		expect(result).toHaveProperty("error");
	});

	it("only calls gh api (read-only) — no write method is ever used", () => {
		mockSpawn.mockReturnValueOnce({
			status: 0,
			stdout: JSON.stringify({ login: "dev" }),
			stderr: "",
			error: undefined,
		});
		mockSpawn.mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "", error: undefined });
		getGithubCredentialScope();
		for (const [cmd, args] of mockSpawn.mock.calls) {
			expect(cmd).toBe("gh");
			expect((args as string[])[0]).toBe("api");
		}
	});
});
