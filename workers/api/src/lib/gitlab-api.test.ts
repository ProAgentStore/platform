/**
 * The GitLab read client (#221 phase 3).
 *
 * Two things here are decisions rather than transcription, and both are the kind that look
 * correct in review and are wrong in production, so each has a test that fails on the obvious
 * mistake: the issue number is `iid` (not the globally unique `id`), and a pipeline's single
 * status is widened into GitHub's `(status, conclusion)` pair rather than the console being
 * taught a second vocabulary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitlabProjectId, listGitlabIssues, listGitlabPipelines, mapPipelineStatus, readGitlabIssue } from "./gitlab-api.js";
import type { Env } from "../types.js";

// No KEY_ENCRYPTION_KEY and no DB: `readConnectorRefreshToken` throws, the client swallows it,
// and the read goes out UNAUTHENTICATED — which is the ordinary path for a public project and
// the one that must not become an exception.
const env = {} as Env;

function stubFetch(body: unknown, status = 200) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
			return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		}),
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("gitlabProjectId", () => {
	it("URL-encodes a nested namespace into one path segment", () => {
		// The whole reason `repo_slug` exists beside `github_repo`: GitHub's column is
		// `owner/name` and cannot hold this without lying about which part is the owner.
		expect(gitlabProjectId("group/sub/project")).toBe("group%2Fsub%2Fproject");
		expect(gitlabProjectId("group/project")).toBe("group%2Fproject");
	});

	it("refuses anything that is not a project path", () => {
		expect(gitlabProjectId("project")).toBeNull(); // no namespace
		expect(gitlabProjectId("")).toBeNull();
		expect(gitlabProjectId(Array(25).fill("a").join("/"))).toBeNull(); // deeper than GitLab allows
	});

	it("refuses a segment that could smuggle a query or path into the request", () => {
		// Defence in depth, matching `github-issues.ts`. The slug is interpolated into an
		// authenticated URL; a charset check means no upstream caller's mistake becomes one.
		expect(gitlabProjectId("group/project?per_page=100")).toBeNull();
		expect(gitlabProjectId("group/../../admin")).toBeNull();
		expect(gitlabProjectId("group/pro ject")).toBeNull();
		expect(gitlabProjectId("-group/project")).toBeNull(); // GitLab paths start alphanumeric
	});
});

describe("listGitlabIssues", () => {
	const raw = [{ iid: 3, id: 99001, title: "Pipeline flakes", state: "opened", labels: ["ci", "bug"], user_notes_count: 2, updated_at: "2026-08-08T00:00:00Z", web_url: "https://gitlab.com/g/p/-/issues/3", description: "long" }];

	it("maps iid — NOT the globally unique id — to the issue number", async () => {
		// `id` is unique across the whole instance and appears nowhere a human looks. Using it
		// would produce links and "work on #99001" objectives pointing at another project.
		stubFetch(raw);
		const [issue] = await listGitlabIssues(env, "u1", "group/sub/project");
		expect(issue.number).toBe(3);
	});

	it("normalises `opened` to `open`, the word every caller already filters on", async () => {
		stubFetch(raw);
		const [issue] = await listGitlabIssues(env, "u1", "group/p");
		expect(issue.state).toBe("open");
		expect(issue).toEqual({ number: 3, title: "Pipeline flakes", state: "open", labels: ["ci", "bug"], comments: 2, updatedAt: "2026-08-08T00:00:00Z", url: "https://gitlab.com/g/p/-/issues/3" });
	});

	it("sends GitLab's word for open, and OMITS the filter for `all`", async () => {
		// `state=all` is a 400 from GitLab, which would arrive as a silently empty backlog.
		let calls = stubFetch(raw);
		await listGitlabIssues(env, "u1", "group/p", { state: "open" });
		expect(calls[0].url).toContain("state=opened");
		calls = stubFetch(raw);
		await listGitlabIssues(env, "u1", "group/p", { state: "all" });
		expect(calls[0].url).not.toContain("state=");
	});

	it("asks unauthenticated when there is no stored token, rather than not asking", async () => {
		const calls = stubFetch(raw);
		await listGitlabIssues(env, "u1", "group/p");
		expect(calls[0].url.startsWith("https://gitlab.com/api/v4/projects/group%2Fp/issues")).toBe(true);
		expect(calls[0].headers["PRIVATE-TOKEN"]).toBeUndefined();
	});

	it("degrades to [] on a 404, a non-array body, and a network error", async () => {
		stubFetch([], 404);
		expect(await listGitlabIssues(env, "u1", "group/p")).toEqual([]);
		stubFetch({ message: "403 Forbidden" });
		expect(await listGitlabIssues(env, "u1", "group/p")).toEqual([]);
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
		expect(await listGitlabIssues(env, "u1", "group/p")).toEqual([]);
	});

	it("makes no request at all for a malformed slug", async () => {
		const calls = stubFetch(raw);
		expect(await listGitlabIssues(env, "u1", "project")).toEqual([]);
		expect(calls).toEqual([]);
	});
});

describe("readGitlabIssue", () => {
	it("caps the body and keeps the iid", async () => {
		stubFetch({ iid: 7, title: "T", state: "opened", labels: [], user_notes_count: 0, updated_at: "", web_url: "u", description: "x".repeat(20_000) });
		const issue = await readGitlabIssue(env, "u1", "group/p", 7);
		expect(issue?.number).toBe(7);
		expect(issue?.body.length).toBe(8 * 1024);
	});

	it("returns null for a body with no iid, rather than an issue numbered 0", async () => {
		stubFetch({ message: "404 Not found" });
		expect(await readGitlabIssue(env, "u1", "group/p", 7)).toBeNull();
	});
});

describe("mapPipelineStatus", () => {
	it("carries a verdict only for the TERMINAL states", () => {
		expect(mapPipelineStatus("success")).toEqual({ status: "completed", conclusion: "success" });
		expect(mapPipelineStatus("failed")).toEqual({ status: "completed", conclusion: "failure" });
		expect(mapPipelineStatus("canceled")).toEqual({ status: "completed", conclusion: "cancelled" });
	});

	it("gives unfinished work a NULL conclusion, so the panel can't paint it as failed", () => {
		for (const s of ["created", "pending", "waiting_for_resource", "preparing", "scheduled"]) {
			expect(mapPipelineStatus(s), s).toEqual({ status: "queued", conclusion: null });
		}
		expect(mapPipelineStatus("running")).toEqual({ status: "in_progress", conclusion: null });
	});

	it("degrades an UNKNOWN status to in-progress with no verdict", () => {
		// GitLab adds statuses. Asserting a result we do not recognise is the failure worth
		// designing against; "still going" is the honest default.
		expect(mapPipelineStatus("some_future_state")).toEqual({ status: "in_progress", conclusion: null });
		expect(mapPipelineStatus(undefined)).toEqual({ status: "in_progress", conclusion: null });
	});
});

describe("listGitlabPipelines", () => {
	it("maps a pipeline into the BuildRun the console already reads", async () => {
		stubFetch([{ iid: 12, id: 88, status: "success", source: "push", ref: "main", sha: "abcdef1234567", web_url: "w", updated_at: "t" }]);
		const runs = await listGitlabPipelines(env, "u1", "group/p");
		expect(runs).toEqual([{ status: "completed", conclusion: "success", name: "push", runNumber: 12, url: "w", branch: "main", sha: "abcdef1", updatedAt: "t" }]);
	});

	it("distinguishes 'no pipelines yet' from 'could not ask'", async () => {
		// `[]` is a true, useful answer the Builds panel renders as available-with-nothing.
		// `null` is the different answer that becomes `available:false`. Collapsing them would
		// show a healthy project as permanently unavailable, or a broken one as empty.
		stubFetch([]);
		expect(await listGitlabPipelines(env, "u1", "group/p")).toEqual([]);
		stubFetch({ message: "404" }, 404);
		expect(await listGitlabPipelines(env, "u1", "group/p")).toBeNull();
	});
});
