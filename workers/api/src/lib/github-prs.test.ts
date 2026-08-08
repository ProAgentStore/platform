import { afterEach, describe, expect, it, vi } from "vitest";
import { attachChecks, listPulls, readPull, resolveReviewState, toPullSummary, type PullSummary } from "./github-prs.js";
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

	it("returns null for a missing PR and for a non-numeric number", async () => {
		mockFetch(() => ({ status: 404, body: {} }));
		expect(await readPull(env, "u1", "acme/widget", 999)).toBeNull();
		expect(await readPull(env, "u1", "acme/widget", Number.NaN)).toBeNull();
	});
});
