import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_INSPECT_TOOL_NAMES, buildInspectTools, executeInspectTool, INSPECT_TOOL_NAMES, ISSUE_TOOL_NAMES } from "./coding-inspect.js";

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
	const issueTarget = { conn: {} as never, env: {} as never, userId: "u1", githubRepo: "acme/widget" };

	it("list_issues → github helper, no runner call, renders the backlog", async () => {
		const out = await executeInspectTool(issueTarget, { name: "list_issues", arguments: {} });
		expect(calls.length).toBe(0); // never touched the runner
		expect(out).toMatch(/#7: Broken login/);
	});

	it("read_issue → github helper, includes the body", async () => {
		const out = await executeInspectTool(issueTarget, { name: "read_issue", arguments: { number: 7 } });
		expect(calls.length).toBe(0);
		expect(out).toMatch(/Broken login/);
		expect(out).toMatch(/Login button does nothing/);
	});

	it("issue tools without a githubRepo say so (local-only repo)", async () => {
		const out = await executeInspectTool({ conn: {} as never, env: {} as never, userId: "u1" }, { name: "list_issues", arguments: {} });
		expect(out).toMatch(/connected to GitHub/i);
	});
});
