import { afterEach, describe, expect, it, vi } from "vitest";
import { listIssueComments, listIssues, listIssuesPage, readIssue, searchIssues, searchIssuesQuery } from "./github-issues.js";
import type { Env } from "../types.js";

vi.mock("./github-app.js", () => ({
	installationTokenForOwner: vi.fn(async () => "tok_abc"),
}));

const env = {} as Env;

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const { status, body } = handler(url, init);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as Response;
	}) as unknown as typeof fetch;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("listIssues", () => {
	it("filters out pull requests and maps fields", async () => {
		mockFetch(() => ({
			status: 200,
			body: [
				{ number: 5, title: "Real bug", state: "open", comments: 2, updated_at: "2026-07-01T00:00:00Z", html_url: "u5", labels: [{ name: "bug" }, "ui"] },
				{ number: 6, title: "A PR", state: "open", comments: 0, updated_at: "2026-07-02T00:00:00Z", html_url: "u6", pull_request: { url: "x" } },
			],
		}));
		const issues = await listIssues(env, "user1", "acme/widget");
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ number: 5, title: "Real bug", labels: ["bug", "ui"], comments: 2, url: "u5" });
	});

	it("hits the issues endpoint with the auth header", async () => {
		let seenUrl = "";
		let seenAuth: string | undefined;
		mockFetch((url, init) => {
			seenUrl = url;
			seenAuth = (init?.headers as Record<string, string>)?.Authorization;
			return { status: 200, body: [] };
		});
		await listIssues(env, "user1", "acme/widget");
		expect(seenUrl).toContain("https://api.github.com/repos/acme/widget/issues");
		expect(seenAuth).toBe("token tok_abc");
	});

	it("returns [] on a malformed repo (no owner/repo)", async () => {
		mockFetch(() => ({ status: 200, body: [] }));
		expect(await listIssues(env, "user1", "widget")).toEqual([]);
	});

	it("returns [] on a GitHub error", async () => {
		mockFetch(() => ({ status: 404, body: { message: "Not Found" } }));
		expect(await listIssues(env, "user1", "acme/widget")).toEqual([]);
	});

	it("returns [] when fetch throws", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		expect(await listIssues(env, "user1", "acme/widget")).toEqual([]);
	});
});

describe("readIssue", () => {
	it("returns the detail with a body", async () => {
		mockFetch(() => ({
			status: 200,
			body: { number: 5, title: "Real bug", state: "open", comments: 0, updated_at: "", html_url: "u5", body: "Steps to reproduce", labels: [] },
		}));
		const issue = await readIssue(env, "user1", "acme/widget", 5);
		expect(issue).toMatchObject({ number: 5, title: "Real bug", body: "Steps to reproduce" });
	});

	it("returns null when the item is a PR", async () => {
		mockFetch(() => ({
			status: 200,
			body: { number: 6, title: "A PR", pull_request: { url: "x" }, body: "", labels: [] },
		}));
		expect(await readIssue(env, "user1", "acme/widget", 6)).toBeNull();
	});

	it("returns null on a GitHub error", async () => {
		mockFetch(() => ({ status: 404, body: {} }));
		expect(await readIssue(env, "user1", "acme/widget", 99)).toBeNull();
	});
});

describe("bodies arrive whole (#898)", () => {
	// The reported symptom: a comment that ended at "…4. O" because an 8 KiB slice cut it, with
	// nothing in the result to say so. GitHub's own limit is 65,536, so a body is returned as is.
	const long = `${"step\n".repeat(3000)}4. Ordering matters — the end of the comment.`;

	it("readIssue returns a body past 8 KiB in full", async () => {
		mockFetch(() => ({ status: 200, body: { number: 5, title: "t", state: "open", comments: 0, updated_at: "", html_url: "u", body: long, labels: [] } }));
		expect((await readIssue(env, "user1", "acme/widget", 5))?.body).toBe(long);
	});

	it("listIssueComments returns every comment body in full", async () => {
		mockFetch(() => ({ status: 200, body: [{ id: 1, user: { login: "a" }, body: long, created_at: "", updated_at: "", html_url: "c1" }] }));
		const [c] = await listIssueComments(env, "user1", "acme/widget", 5);
		expect(c.body).toBe(long);
		expect(c.body.endsWith("the end of the comment.")).toBe(true);
	});
});

describe("listIssueComments", () => {
	it("maps comment fields and sends pagination", async () => {
		let seenUrl = "";
		mockFetch((url) => {
			seenUrl = url;
			return {
				status: 200,
				body: [
					{
						id: 11,
						user: { login: "octocat" },
						body: "I can reproduce this.",
						created_at: "2026-08-01T00:00:00Z",
						updated_at: "2026-08-02T00:00:00Z",
						html_url: "https://github.com/acme/widget/issues/5#issuecomment-11",
					},
				],
			};
		});
		const comments = await listIssueComments(env, "user1", "acme/widget", 5, { page: 2, perPage: 5 });
		expect(seenUrl).toContain("/repos/acme/widget/issues/5/comments");
		expect(seenUrl).toContain("page=2");
		expect(seenUrl).toContain("per_page=5");
		expect(comments).toEqual([
			{
				id: 11,
				author: "octocat",
				body: "I can reproduce this.",
				createdAt: "2026-08-01T00:00:00Z",
				updatedAt: "2026-08-02T00:00:00Z",
				url: "https://github.com/acme/widget/issues/5#issuecomment-11",
			},
		]);
	});

	it("clamps per_page and rejects a malformed issue number without fetching", async () => {
		let seenUrl = "";
		mockFetch((url) => {
			seenUrl = url;
			return { status: 200, body: [] };
		});
		await listIssueComments(env, "user1", "acme/widget", 5, { page: -2, perPage: 500 });
		expect(seenUrl).toContain("page=1");
		expect(seenUrl).toContain("per_page=50");

		expect(await listIssueComments(env, "user1", "acme/widget", 0)).toEqual([]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("returns [] on a GitHub error", async () => {
		mockFetch(() => ({ status: 404, body: { message: "Not Found" } }));
		expect(await listIssueComments(env, "user1", "acme/widget", 99)).toEqual([]);
	});
});

/** A fetch stub that also answers headers — the rate-limit refusal is read from them (#936). */
function mockSearch(status: number, body: unknown, headers: Record<string, string> = {}) {
	const seen: string[] = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		seen.push(String(input));
		return { ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers(headers) } as Response;
	}) as unknown as typeof fetch;
	return seen;
}

const issue = (n: number, title: string, updated: string, extra: Record<string, unknown> = {}) => ({ number: n, title, state: "open", comments: 0, updated_at: updated, html_url: `u${n}`, body: "", ...extra });

describe("listIssues without a search — unchanged (#936)", () => {
	it("still lists the recent page from /issues and never touches /search", async () => {
		const seen: string[] = [];
		mockFetch((url) => {
			seen.push(url);
			return { status: 200, body: [issue(1, "a", "2026-07-01T00:00:00Z"), issue(2, "b", "2026-07-02T00:00:00Z")] };
		});
		const issues = await listIssues(env, "user1", "acme/widget", { state: "open", limit: 30 });
		expect(issues.map((i) => i.number)).toEqual([1, 2]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("/repos/acme/widget/issues?");
		expect(seen[0]).not.toContain("/search/");
	});
});

describe("searchIssues — GitHub's search over every issue (#936)", () => {
	it("scopes the query to the repo, to issues, to the state and labels, and to title + body", () => {
		expect(searchIssuesQuery("acme", "widget", "flaky deploy", { state: "open", labels: "p1, needs triage" })).toBe(
			'repo:acme/widget is:issue state:open label:"p1" label:"needs triage" in:title,body flaky deploy',
		);
		expect(searchIssuesQuery("acme", "widget", "x", { state: "all" })).toBe("repo:acme/widget is:issue in:title,body x");
	});

	it("returns only the matches, with the total — including one older than the newest 30", async () => {
		const seen = mockSearch(200, {
			total_count: 45,
			incomplete_results: false,
			items: [issue(3, "Flaky deploy on Fridays", "2025-01-02T00:00:00Z"), issue(9, "A PR about it", "2026-07-01T00:00:00Z", { pull_request: {} })],
		});
		const r = await searchIssues(env, "user1", "acme/widget", "flaky deploy", { state: "open", limit: 30 });
		expect(r).toEqual({ total_count: 45, incomplete_results: false, issues: [expect.objectContaining({ number: 3, title: "Flaky deploy on Fridays" })] });
		const url = new URL(seen[0]);
		expect(url.pathname).toBe("/search/issues");
		expect(url.searchParams.get("q")).toBe("repo:acme/widget is:issue state:open in:title,body flaky deploy");
		expect(url.searchParams.get("per_page")).toBe("30");
	});

	it("an empty result means nothing matched", async () => {
		mockSearch(200, { total_count: 0, incomplete_results: false, items: [] });
		expect(await searchIssues(env, "user1", "acme/widget", "nothing")).toEqual({ total_count: 0, incomplete_results: false, issues: [] });
	});

	it("a rate-limit refusal is an ERROR, never an empty list — 429 and 403-with-no-remaining alike", async () => {
		mockSearch(429, { message: "rate limited" }, { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 40) });
		const a = await searchIssues(env, "user1", "acme/widget", "bug");
		expect(a).toEqual({ error: expect.stringMatching(/rate limit is used up .* try again in about \d+s\. This is not "no matches"\./) });
		mockSearch(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
		expect(await searchIssues(env, "user1", "acme/widget", "bug")).toHaveProperty("error");
	});

	it("an invalid query or an unseen repo is an error that carries GitHub's reason", async () => {
		mockSearch(422, { message: "The listed users and repositories cannot be searched" });
		expect(await searchIssues(env, "user1", "acme/secret", "bug")).toEqual({ error: "GitHub search refused the query (422): The listed users and repositories cannot be searched." });
	});

	it("rejects a malformed repo without calling GitHub", async () => {
		const seen = mockSearch(200, {});
		expect(await searchIssues(env, "user1", "not-a-repo", "bug")).toHaveProperty("error");
		expect(seen).toHaveLength(0);
	});
});

describe("listIssuesPage (#898)", () => {
	it("asks GitHub for the page, and a full raw page means there may be more even after PRs are removed", async () => {
		let seen = "";
		mockFetch((url) => {
			seen = url;
			return { status: 200, body: [
				{ number: 5, title: "issue", state: "open", comments: 0, updated_at: "", html_url: "u5", labels: [] },
				{ number: 6, title: "a PR", state: "open", comments: 0, updated_at: "", html_url: "u6", labels: [], pull_request: { url: "x" } },
			] };
		});
		const out = await listIssuesPage(env, "user1", "acme/widget", { page: 3, limit: 2 });
		expect(seen).toContain("page=3");
		expect(out).toMatchObject({ page: 3, hasMore: true });
		expect(out.issues.map((i) => i.number)).toEqual([5]);
	});

	it("a short page is the last one", async () => {
		mockFetch(() => ({ status: 200, body: [{ number: 5, title: "issue", state: "open", comments: 0, updated_at: "", html_url: "u5", labels: [] }] }));
		expect((await listIssuesPage(env, "user1", "acme/widget", { limit: 30 })).hasMore).toBe(false);
	});
});

describe("the issues-mode backlog order (#898)", () => {
	it('order "oldest" lists by creation, oldest first — not the 30 most recently updated', async () => {
		let seen = "";
		mockFetch((url) => {
			seen = url;
			return { status: 200, body: [] };
		});
		await listIssues(env, "user1", "acme/widget", { state: "open", order: "oldest", limit: 100 });
		expect(seen).toContain("sort=created");
		expect(seen).toContain("direction=asc");
		expect(seen).toContain("per_page=100");
	});
});
