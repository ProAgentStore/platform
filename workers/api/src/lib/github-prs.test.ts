import { afterEach, describe, expect, it, vi } from "vitest";
import { attachChecks, listPulls, PULLS_ENRICH_CAP, readPull, readPullFiles, resolveReviewState, searchPulls, searchPullsQuery, toPullSummary, type PullSummary } from "./github-prs.js";
import type { Env } from "../types.js";

vi.mock("./github-cache.js", async (importOriginal) => {
	// The cache itself has its own suite; here it must simply be OUT of the way, so these tests are
	// about the PR mapping. `resolveGithubRead` is stubbed to "authenticated, uncacheable", which
	// is exactly the no-KV production path.
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		resolveGithubRead: vi.fn(async () => ({ token: "tok", authContext: null })),
	};
});

const env = {} as Env;

function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const { status, body } = handler(url);
		return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
	}) as unknown as typeof fetch;
}

const RAW_PULL = {
	number: 42,
	title: "Fix the flake",
	state: "open",
	draft: true,
	created_at: "2026-08-01T00:00:00Z",
	updated_at: "2026-08-02T00:00:00Z",
	html_url: "https://github.com/acme/widget/pull/42",
	comments: 3,
	user: { login: "coder-bot" },
	head: { ref: "fix/flake", sha: "abc123def456" },
	base: { ref: "main" },
	labels: [{ name: "bug" }, "ci"],
	requested_reviewers: [{ login: "a" }, { login: "b" }],
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("toPullSummary", () => {
	it("maps the fields the panel renders", () => {
		expect(toPullSummary(RAW_PULL)).toMatchObject({
			number: 42,
			title: "Fix the flake",
			draft: true,
			merged: false,
			author: "coder-bot",
			branch: "fix/flake",
			baseBranch: "main",
			headSha: "abc123def456",
			labels: ["bug", "ci"],
			reviewersRequested: 2,
		});
	});

	it("reports an unknown mergeability as null, never as false", () => {
		// The LIST endpoint omits `mergeable` entirely, and the DETAIL endpoint answers null until
		// GitHub's background job finishes. Both mean "not known" — and "not known" rendered as
		// `false` would tell an owner their PR conflicts when nobody has checked.
		expect(toPullSummary(RAW_PULL).mergeable).toBeNull();
		expect(toPullSummary({ ...RAW_PULL, mergeable: null }).mergeable).toBeNull();
		expect(toPullSummary({ ...RAW_PULL, mergeable: false }).mergeable).toBe(false);
		expect(toPullSummary({ ...RAW_PULL, mergeable: true }).mergeable).toBe(true);
	});

	it("treats a merged_at timestamp as merged even when `merged` is absent", () => {
		expect(toPullSummary({ ...RAW_PULL, merged_at: "2026-08-03T00:00:00Z" }).merged).toBe(true);
	});
});

describe("resolveReviewState", () => {
	it("says none when nobody has reviewed", () => {
		expect(resolveReviewState([])).toBe("none");
	});

	it("counts only each person's LATEST decision", () => {
		const reviews = [
			{ state: "CHANGES_REQUESTED", user: { login: "kim" } },
			{ state: "APPROVED", user: { login: "kim" } },
		];
		expect(resolveReviewState(reviews)).toBe("approved");
	});

	it("lets a blocking review outrank an approval from someone else", () => {
		const reviews = [
			{ state: "APPROVED", user: { login: "kim" } },
			{ state: "CHANGES_REQUESTED", user: { login: "sam" } },
		];
		expect(resolveReviewState(reviews)).toBe("changes_requested");
	});

	it("does not let a later COMMENT clear an approval — GitHub's own rule", () => {
		const reviews = [
			{ state: "APPROVED", user: { login: "kim" } },
			{ state: "COMMENTED", user: { login: "kim" } },
		];
		expect(resolveReviewState(reviews)).toBe("approved");
	});
});

describe("attachChecks", () => {
	const pull = (n: number, sha: string): PullSummary => ({ ...toPullSummary({ ...RAW_PULL, number: n, head: { ref: "b", sha } }) });

	it("matches a run to its PR by head sha — one request covers every row", () => {
		const out = attachChecks([pull(1, "sha-one"), pull(2, "sha-two")], [
			{ head_sha: "sha-two", status: "completed", conclusion: "failure", html_url: "u2", name: "ci" },
			{ head_sha: "sha-one", status: "in_progress", conclusion: null, html_url: "u1", name: "ci" },
		]);
		expect(out[0].checks).toMatchObject({ status: "in_progress", conclusion: null });
		expect(out[1].checks).toMatchObject({ status: "completed", conclusion: "failure", url: "u2" });
	});

	it("keeps the NEWEST run for a sha — the runs page is newest-first", () => {
		const out = attachChecks([pull(1, "s")], [
			{ head_sha: "s", status: "completed", conclusion: "success" },
			{ head_sha: "s", status: "completed", conclusion: "failure" },
		]);
		expect(out[0].checks).toMatchObject({ conclusion: "success" });
	});

	it("leaves checks null when no run matches, rather than implying a pass", () => {
		expect(attachChecks([pull(1, "s")], [{ head_sha: "other" }])[0].checks).toBeNull();
	});
});

describe("listPulls", () => {
	it("asks the pulls endpoint (not issues) and maps what comes back", async () => {
		const urls: string[] = [];
		mockFetch((url) => {
			urls.push(url);
			if (url.includes("/actions/runs")) return { status: 200, body: { workflow_runs: [] } };
			if (/\/pulls\/42\/reviews/.test(url)) return { status: 200, body: [{ state: "APPROVED", user: { login: "kim" } }] };
			if (/\/pulls\/42$/.test(url)) return { status: 200, body: { ...RAW_PULL, mergeable: false, mergeable_state: "dirty" } };
			return { status: 200, body: [RAW_PULL] };
		});
		const pulls = await listPulls(env, "u1", "acme/widget");
		expect(urls[0]).toContain("https://api.github.com/repos/acme/widget/pulls?");
		expect(urls[0]).toContain("state=open");
		expect(pulls).toHaveLength(1);
		// Enrichment fills in the two things the list endpoint cannot answer.
		expect(pulls[0]).toMatchObject({ number: 42, mergeable: false, mergeableState: "dirty", review: "approved" });
	});

	it("skips the per-PR enrichment when asked to, so a poll costs 2 requests not 2N", async () => {
		const urls: string[] = [];
		mockFetch((url) => {
			urls.push(url);
			if (url.includes("/actions/runs")) return { status: 200, body: { workflow_runs: [] } };
			return { status: 200, body: [RAW_PULL] };
		});
		const pulls = await listPulls(env, "u1", "acme/widget", { enrich: false });
		expect(urls.filter((u) => /\/pulls\/\d+/.test(u))).toEqual([]);
		expect(pulls[0].review).toBe("unknown");
	});

	it("returns [] for a malformed repo without fetching anything", async () => {
		const spy = vi.fn();
		globalThis.fetch = spy as unknown as typeof fetch;
		expect(await listPulls(env, "u1", "widget")).toEqual([]);
		expect(await listPulls(env, "u1", "owner/name?per_page=100")).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});

	it("returns [] on a GitHub error rather than throwing at the panel", async () => {
		mockFetch(() => ({ status: 404, body: { message: "Not Found" } }));
		expect(await listPulls(env, "u1", "acme/widget")).toEqual([]);
	});
});

describe("readPull", () => {
	it("returns the body, the diff size and the review state", async () => {
		mockFetch((url) => {
			if (url.includes("/actions/runs")) return { status: 200, body: { workflow_runs: [{ head_sha: "abc123def456", status: "completed", conclusion: "success" }] } };
			if (url.includes("/reviews")) return { status: 200, body: [{ state: "CHANGES_REQUESTED", user: { login: "sam" } }] };
			return { status: 200, body: { ...RAW_PULL, body: "why", additions: 10, deletions: 2, changed_files: 3, mergeable: true, mergeable_state: "clean" } };
		});
		const pull = await readPull(env, "u1", "acme/widget", 42);
		expect(pull).toMatchObject({
			number: 42,
			body: "why",
			additions: 10,
			deletions: 2,
			changedFiles: 3,
			mergeable: true,
			mergeableState: "clean",
			review: "changes_requested",
		});
		expect(pull?.checks).toMatchObject({ conclusion: "success" });
	});

	it("looks up the PR's checks by its head commit, not within the repo's newest runs (#898)", async () => {
		const urls: string[] = [];
		mockFetch((url) => {
			urls.push(url);
			if (url.includes("/actions/runs")) return { status: 200, body: { workflow_runs: [{ head_sha: "abc123def456", status: "completed", conclusion: "failure" }] } };
			if (url.includes("/reviews")) return { status: 200, body: [] };
			return { status: 200, body: { ...RAW_PULL, body: "b" } };
		});
		const pull = await readPull(env, "u1", "acme/widget", 42);
		expect(urls.find((u) => u.includes("/actions/runs"))).toContain("head_sha=abc123def456");
		expect(pull?.checks).toMatchObject({ conclusion: "failure" });
	});

	it("reads past the first 100 reviews, where a long PR's latest decision is (#898)", async () => {
		// GitHub lists reviews oldest first: 100 comments, then the approval on page 2.
		const comments = Array.from({ length: 100 }, () => ({ state: "COMMENTED", user: { login: "bot" } }));
		mockFetch((url) => {
			if (url.includes("/actions/runs")) return { status: 200, body: { workflow_runs: [] } };
			if (url.includes("/reviews") && url.includes("page=2")) return { status: 200, body: [{ state: "APPROVED", user: { login: "kim" } }] };
			if (url.includes("/reviews")) return { status: 200, body: comments };
			return { status: 200, body: { ...RAW_PULL, body: "b" } };
		});
		expect((await readPull(env, "u1", "acme/widget", 42))?.review).toBe("approved");
	});

	it("returns null for a missing PR and for a non-numeric number", async () => {
		mockFetch(() => ({ status: 404, body: {} }));
		expect(await readPull(env, "u1", "acme/widget", 999)).toBeNull();
		expect(await readPull(env, "u1", "acme/widget", Number.NaN)).toBeNull();
	});
});

// #954 (#898 T15): github_read_pull gave the diff's SIZE and never the diff. `files: true` pages it.
describe("readPullFiles — a PR's diff, paged so a page is never cut", () => {
	/** A PR with these files; `/files` answers 100 per page as GitHub does. */
	function prWith(files: Array<{ filename: string; patch?: string }>, changedFiles = files.length) {
		const urls: string[] = [];
		mockFetch((url) => {
			urls.push(url);
			const m = /\/files\?per_page=100&page=(\d+)/.exec(url);
			if (m) {
				const page = Number(m[1]);
				return { status: 200, body: files.slice((page - 1) * 100, page * 100).map((f) => ({ status: "modified", additions: 1, deletions: 1, ...f })) };
			}
			return { status: 200, body: { ...RAW_PULL, changed_files: changedFiles } };
		});
		return urls;
	}
	const read = (opts: { file?: number; patchOffset?: number; budget?: number } = {}) => readPullFiles(env, "u1", "acme/widget", 42, { budget: 2_000, ...opts });

	it("returns small diffs whole, and says there is nothing more", async () => {
		prWith([{ filename: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }, { filename: "b.ts", patch: "@@ -1 +1 @@\n-c\n+d" }]);
		const page = await read();
		expect(page).toMatchObject({ number: 42, changedFiles: 2, hasMore: false, next: null });
		expect(page?.files.map((f) => [f.filename, f.patch])).toEqual([["a.ts", "@@ -1 +1 @@\n-a\n+b"], ["b.ts", "@@ -1 +1 @@\n-c\n+d"]]);
		expect(page?.files[0].patchFrom).toBeUndefined();
	});

	it("ends a page BEFORE a file that would not fit, and the cursor starts the next page there", async () => {
		const mid = "x".repeat(900);
		prWith([{ filename: "a.ts", patch: mid }, { filename: "b.ts", patch: mid }, { filename: "c.ts", patch: mid }]);
		const first = await read();
		expect(first?.files.map((f) => f.filename)).toEqual(["a.ts"]);
		expect(first?.next).toEqual({ file: 1, patch_offset: 0 });
		const second = await read({ file: 1 });
		expect(second?.files[0]).toMatchObject({ filename: "b.ts", patch: mid });
	});

	it("slices ONE diff larger than the budget on line boundaries, and the slices rejoin to the whole diff", async () => {
		const huge = Array.from({ length: 400 }, (_, i) => `+line ${i} "quoted" text`).join("\n");
		prWith([{ filename: "huge.ts", patch: huge }, { filename: "after.ts", patch: "+z" }]);
		let cursor: { file: number; patch_offset: number } | null = { file: 0, patch_offset: 0 };
		let joined = "";
		let pages = 0;
		while (cursor && cursor.file === 0) {
			const page = await read({ file: cursor.file, patchOffset: cursor.patch_offset });
			const f = page?.files[0];
			expect(f?.filename).toBe("huge.ts");
			expect(f?.patchLength).toBe(huge.length);
			expect(f?.patchFrom).toBe(joined.length);
			// Measured as JSON: the escaped slice stays inside the budget.
			expect(JSON.stringify(f?.patch).length).toBeLessThanOrEqual(2_000);
			if ((f?.patchFrom ?? 0) + (f?.patch?.length ?? 0) < huge.length) expect(f?.patch?.endsWith("\n")).toBe(true);
			joined += f?.patch ?? "";
			cursor = page?.next ?? null;
			pages++;
		}
		expect(joined).toBe(huge);
		expect(pages).toBeGreaterThan(3);
		expect(cursor).toEqual({ file: 1, patch_offset: 0 });
	});

	it("names a file GitHub sends no diff for instead of returning an empty one", async () => {
		prWith([{ filename: "logo.png" }]);
		const page = await read();
		expect(page?.files[0]).toMatchObject({ filename: "logo.png", patch: null });
		expect(page?.files[0].note).toMatch(/no diff for this file/);
	});

	it("reads the files past GitHub's first page of 100", async () => {
		const urls = prWith(Array.from({ length: 150 }, (_, i) => ({ filename: `f${i}.ts`, patch: "+x" })));
		const page = await read({ file: 120 });
		expect(page?.files[0].filename).toBe("f120.ts");
		expect(urls.some((u) => u.includes("/files?per_page=100&page=2"))).toBe(true);
	});

	it("says when a PR changes more files than GitHub will list", async () => {
		prWith([{ filename: "a.ts", patch: "+a" }], 3_500);
		const page = await read({ file: 2_999 });
		expect(page?.note).toMatch(/changes 3,500 files; GitHub lists only the first 3,000/);
	});

	it("returns null for a PR it cannot read", async () => {
		mockFetch(() => ({ status: 404, body: {} }));
		expect(await read()).toBeNull();
	});
});

/** A PR as GitHub's SEARCH endpoint returns it: issue-shaped, no head/base, merge state under pull_request. */
const searchItem = (n: number, title: string, extra: Record<string, unknown> = {}) => ({
	number: n,
	title,
	state: "open",
	comments: 0,
	created_at: "2025-01-01T00:00:00Z",
	updated_at: "2025-01-02T00:00:00Z",
	html_url: `https://github.com/acme/widget/pull/${n}`,
	user: { login: "kim" },
	labels: [],
	pull_request: { merged_at: null },
	...extra,
});

describe("searchPulls — GitHub's search over every PR (#937)", () => {
	it("scopes the query to the repo, to PRs, to the state, and to title + body", () => {
		expect(searchPullsQuery("acme", "widget", "flaky test", "open")).toBe("repo:acme/widget is:pr state:open in:title,body flaky test");
		expect(searchPullsQuery("acme", "widget", "x", "all")).toBe("repo:acme/widget is:pr in:title,body x");
	});

	it("returns the matches with their total, enriched with branch, mergeable, review and CI", async () => {
		const urls: string[] = [];
		mockFetch((url) => {
			urls.push(url);
			if (url.includes("/search/issues")) return { status: 200, body: { total_count: 41, incomplete_results: false, items: [searchItem(42, "Fix the flake")] } };
			if (url.includes("/actions/runs")) return { status: 200, body: { workflow_runs: [{ head_sha: "abc123def456", status: "completed", conclusion: "success", html_url: "r", name: "CI" }] } };
			if (/\/pulls\/42\/reviews/.test(url)) return { status: 200, body: [{ state: "APPROVED", user: { login: "kim" } }] };
			if (/\/pulls\/42$/.test(url)) return { status: 200, body: { ...RAW_PULL, mergeable: true, mergeable_state: "clean" } };
			return { status: 404, body: {} };
		});
		const r = await searchPulls(env, "u1", "acme/widget", "flake", { state: "open" });
		if ("error" in r) throw new Error(r.error);
		expect(r.total_count).toBe(41);
		expect(r.pulls).toHaveLength(1);
		expect(r.pulls[0]).toMatchObject({ number: 42, branch: "fix/flake", baseBranch: "main", headSha: "abc123def456", mergeable: true, review: "approved", checks: { conclusion: "success" } });
		const search = new URL(urls[0]);
		expect(search.pathname).toBe("/search/issues");
		expect(search.searchParams.get("q")).toBe("repo:acme/widget is:pr state:open in:title,body flake");
	});

	it("enriches only the first PULLS_ENRICH_CAP matches; the rest keep honest 'not known' values", async () => {
		const items = Array.from({ length: PULLS_ENRICH_CAP + 2 }, (_, i) => searchItem(100 + i, `match ${i}`));
		const detailCalls: string[] = [];
		mockFetch((url) => {
			if (url.includes("/search/issues")) return { status: 200, body: { total_count: items.length, incomplete_results: false, items } };
			if (url.includes("/actions/runs")) return { status: 200, body: { workflow_runs: [] } };
			if (/\/pulls\/\d+$/.test(url)) {
				detailCalls.push(url);
				const n = Number(url.split("/").pop());
				return { status: 200, body: { ...RAW_PULL, number: n, mergeable: false } };
			}
			if (/\/reviews/.test(url)) return { status: 200, body: [] };
			return { status: 404, body: {} };
		});
		const r = await searchPulls(env, "u1", "acme/widget", "match");
		if ("error" in r) throw new Error(r.error);
		expect(detailCalls).toHaveLength(PULLS_ENRICH_CAP);
		const last = r.pulls[r.pulls.length - 1];
		expect(last).toMatchObject({ number: 100 + PULLS_ENRICH_CAP + 1, branch: "", headSha: "", mergeable: null, review: "unknown" });
		expect(r.pulls[0]).toMatchObject({ branch: "fix/flake", mergeable: false, review: "none" });
	});

	it("reads a merged PR's merge from the search item's pull_request.merged_at", async () => {
		const items = Array.from({ length: PULLS_ENRICH_CAP + 1 }, (_, i) => searchItem(200 + i, "m", { state: "closed", pull_request: { merged_at: "2025-02-01T00:00:00Z" } }));
		mockFetch((url) => {
			if (url.includes("/search/issues")) return { status: 200, body: { total_count: items.length, incomplete_results: false, items } };
			if (url.includes("/actions/runs")) return { status: 200, body: { workflow_runs: [] } };
			return { status: 404, body: {} };
		});
		const r = await searchPulls(env, "u1", "acme/widget", "m", { state: "closed" });
		if ("error" in r) throw new Error(r.error);
		expect(r.pulls.every((p) => p.merged)).toBe(true);
	});

	it("an empty result means nothing matched", async () => {
		mockFetch((url) => (url.includes("/search/issues") ? { status: 200, body: { total_count: 0, incomplete_results: false, items: [] } } : { status: 200, body: { workflow_runs: [] } }));
		expect(await searchPulls(env, "u1", "acme/widget", "nothing")).toEqual({ total_count: 0, incomplete_results: false, pulls: [] });
	});

	it("a GitHub refusal is an ERROR, never an empty list — a 422 with GitHub's reason, and the rate limit", async () => {
		mockFetch(() => ({ status: 422, body: { message: "Validation Failed" } }));
		expect(await searchPulls(env, "u1", "acme/widget", "bug")).toEqual({ error: "GitHub search refused the query (422): Validation Failed." });
		globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, headers: new Headers({}), json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
		expect(await searchPulls(env, "u1", "acme/widget", "bug")).toEqual({ error: expect.stringMatching(/rate limit is used up/) });
	});

	it("a malformed repo is an error, and GitHub is never called", async () => {
		const spy = vi.fn();
		globalThis.fetch = spy as unknown as typeof fetch;
		expect(await searchPulls(env, "u1", "widget", "bug")).toHaveProperty("error");
		expect(spy).not.toHaveBeenCalled();
	});
});
