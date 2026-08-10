import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_INSPECT_TOOL_NAMES, buildInspectTools, executeInspectTool, INSPECT_TOOL_NAMES, ISSUE_TOOL_NAMES } from "./coding-inspect.js";

// GitLab's client is mocked at the same level as GitHub's: the point of these tests is that
// `coding-inspect` no longer KNOWS which one it is talking to (#221) — it hands the repo to
// `hosted-repo.ts` and renders whatever comes back.
vi.mock("./gitlab-api.js", () => ({
	listGitlabIssues: vi.fn(async (_env: unknown, _uid: string, slug: string) =>
		slug === "group/sub/project" ? [{ number: 3, title: "Pipeline flakes", state: "open", labels: [], comments: 0, updatedAt: "", url: "g3" }] : [],
	),
	readGitlabIssue: vi.fn(async () => null),
	listGitlabPipelines: vi.fn(async () => null),
}));

vi.mock("./bitbucket-api.js", () => ({
	listBitbucketIssues: vi.fn(async (_env: unknown, _uid: string, slug: string) =>
		slug === "team/widget" ? [{ number: 12, title: "Deploy step flakes", state: "open", labels: ["bug"], comments: 0, updatedAt: "", url: "b12" }] : [],
	),
	readBitbucketIssue: vi.fn(async () => null),
	listBitbucketPipelines: vi.fn(async () => null),
}));

vi.mock("./github-issues.js", () => ({
	listIssues: vi.fn(async (_env: unknown, _uid: string, repo: string) =>
		repo === "acme/widget" ? [{ number: 7, title: "Broken login", state: "open", labels: ["bug"], comments: 1, updatedAt: "", url: "u7" }] : [],
	),
	readIssue: vi.fn(async (_env: unknown, _uid: string, _repo: string, n: number) =>
		n === 7 ? { number: 7, title: "Broken login", state: "open", labels: ["bug"], comments: 1, updatedAt: "", url: "u7", body: "Login button does nothing." } : null,
	),
}));

const calls: Array<{ path: string; body: unknown }> = [];
vi.mock("./runner-client.js", () => ({
	callRunner: vi.fn(async (_conn: unknown, path: string, body: unknown) => {
		calls.push({ path, body });
		if ((body as { cmd?: string }).cmd === "diff") return { output: "diff --git a/x b/x\n+changed" };
		if ((body as { cmd?: string }).cmd === "status") return { output: " M src/app.ts" };
		if (path === "/coding/read-file") return { content: "export const x = 1;" };
		if (path === "/coding/tree") return { entries: [{ path: "src", type: "dir" }, { path: "src/app.ts", type: "file" }] };
		return {};
	}),
}));

const target = { conn: {} as never, sessionId: "s1", workDir: "/repo" };

describe("buildInspectTools", () => {
	it("offers exactly the four read-only tools by default", () => {
		const names = buildInspectTools().map((t) => t.function.name);
		expect(new Set(names)).toEqual(INSPECT_TOOL_NAMES);
	});

	it("adds the issue tools when issues:true", () => {
		const names = buildInspectTools({ issues: true }).map((t) => t.function.name);
		expect(new Set(names)).toEqual(ALL_INSPECT_TOOL_NAMES);
	});

	it("offers only issue tools when code:false (runner offline, GitHub repo)", () => {
		const names = buildInspectTools({ code: false, issues: true }).map((t) => t.function.name);
		expect(new Set(names)).toEqual(ISSUE_TOOL_NAMES);
	});
});

describe("executeInspectTool", () => {
	afterEach(() => {
		calls.length = 0;
	});

	it("git_diff → /coding/git {cmd:'diff'} and reports the change", async () => {
		const out = await executeInspectTool(target, { name: "git_diff", arguments: {} });
		expect(calls[0]).toMatchObject({ path: "/coding/git", body: { cmd: "diff", sessionId: "s1", workDir: "/repo" } });
		expect(out).toMatch(/changed/);
	});

	it("read_file → /coding/read-file with the path", async () => {
		const out = await executeInspectTool(target, { name: "read_file", arguments: { path: "src/app.ts" } });
		expect(calls[0]).toMatchObject({ path: "/coding/read-file", body: { path: "src/app.ts" } });
		expect(out).toMatch(/export const x/);
	});

	it("list_files → /coding/tree, rendered as a path list", async () => {
		const out = await executeInspectTool(target, { name: "list_files", arguments: {} });
		expect(calls[0].path).toBe("/coding/tree");
		expect(out).toMatch(/src\//);
		expect(out).toMatch(/src\/app\.ts/);
	});

	it("read_file without a path is refused cleanly (no runner call)", async () => {
		const out = await executeInspectTool(target, { name: "read_file", arguments: {} });
		expect(out).toMatch(/needs a `path`/);
		expect(calls.length).toBe(0);
	});

	it("degrades honestly when the runner endpoint 404s (old runner)", async () => {
		const rc = await import("./runner-client.js");
		(rc.callRunner as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error("Runner /coding/git → 404 Not found"));
		const out = await executeInspectTool(target, { name: "git_status", arguments: {} });
		expect(out).toMatch(/isn't available on this runner/i);
		expect(out).toMatch(/say you couldn't check/i);
	});

	// ── Issue tools: cloud-side (no runner call), work on any runner ──
	const issueTarget = { conn: {} as never, env: {} as never, userId: "u1", repo: { provider: "github", githubRepo: "acme/widget", repoSlug: "acme/widget" } };

	it("list_issues → the repo's host, no runner call, renders the backlog", async () => {
		const out = await executeInspectTool(issueTarget, { name: "list_issues", arguments: {} });
		expect(calls.length).toBe(0); // never touched the runner
		expect(out).toMatch(/#7: Broken login/);
	});

	it("read_issue → the repo's host, includes the body", async () => {
		const out = await executeInspectTool(issueTarget, { name: "read_issue", arguments: { number: 7 } });
		expect(calls.length).toBe(0);
		expect(out).toMatch(/Broken login/);
		expect(out).toMatch(/Login button does nothing/);
	});

	it("issue tools without a readable repo say so (local-only repo)", async () => {
		const out = await executeInspectTool({ conn: {} as never, env: {} as never, userId: "u1" }, { name: "list_issues", arguments: {} });
		expect(out).toMatch(/needs a repo on a host PAGS can read/i);
	});

	/**
	 * The bug this closes: the Issues PANEL listed a GitLab repo's backlog while the Co-pilot,
	 * reading the same repo, answered "not connected to GitHub". Two mechanisms for one question
	 * is the half-migration #221 must not ship, so the brain reads through the same dispatcher.
	 */
	it("list_issues reads a GITLAB repo — the brain and the panel agree", async () => {
		const out = await executeInspectTool(
			{ conn: {} as never, env: {} as never, userId: "u1", repo: { provider: "gitlab", repoSlug: "group/sub/project" } },
			{ name: "list_issues", arguments: {} },
		);
		expect(calls.length).toBe(0); // still cloud-side; no runner needed
		expect(out).toMatch(/#3: Pipeline flakes/);
	});

	it("list_issues reads a BITBUCKET repo too — same dispatcher, same agreement", async () => {
		// Phase 4 (#221). The half-migration to avoid is the one where a provider is added to the
		// panel and not to the brain: the Issues tab would list this backlog while the Co-pilot,
		// asked about the same repo, said there wasn't one.
		const out = await executeInspectTool(
			{ conn: {} as never, env: {} as never, userId: "u1", repo: { provider: "bitbucket", repoSlug: "team/widget" } },
			{ name: "list_issues", arguments: {} },
		);
		expect(calls.length).toBe(0);
		expect(out).toMatch(/#12: Deploy step flakes/);
	});

	it("a repo on an UNINTEGRATED host is refused rather than answered emptily", async () => {
		// `[]` would read to the brain as "the backlog is empty", which is a confident false
		// statement about a repo we simply have no client for.
		const out = await executeInspectTool(
			{ conn: {} as never, env: {} as never, userId: "u1", repo: { provider: "other", repoSlug: "team/thing" } },
			{ name: "list_issues", arguments: {} },
		);
		expect(out).toMatch(/needs a repo on a host PAGS can read/i);
	});
});
