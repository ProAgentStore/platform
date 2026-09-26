/**
 * `coding_repo_add` — both halves of a coding repo in one call, or nothing (#849).
 *
 * One `path` used to mean EITHER a folder OR an owner/repo, so a binding made over MCP was always
 * half a binding: GitHub-aware but never checked out, or checked out but anonymous. The tool now
 * takes the checkout folder as `path` and an optional `github_repo`, refuses a call missing the
 * folder before anything reaches the API, and asks the API for the strict paired add.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";

const env: McpEnv = { API_BASE: "https://api.test" };

type ToolResult = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function setup(reply: unknown = { repo: { id: "repo_1" } }, status = 201) {
	const calls: { url: string; method: string; body: string | null }[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: (init?.body as string | undefined) ?? null });
		return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, { schema: Record<string, unknown>; handler: Handler }>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as coding-repo-remove.test.ts
		{ tool: (n: string, _d: string, schema: Record<string, unknown>, handler: Handler) => tools.set(n, { schema, handler }) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: ["read", "write", "runtime", "destructive"] }),
	);
	const tool = tools.get("coding_repo_add");
	expect(tool, "coding_repo_add is not registered by registerCodingSessionTools").toBeDefined();
	return { calls, tool: tool as NonNullable<typeof tool> };
}

const textOf = (r: ToolResult) => r.content[0].text;
const posts = (calls: { method: string }[]) => calls.filter((c) => c.method === "POST");

afterEach(() => vi.unstubAllGlobals());

describe("coding_repo_add — both halves or nothing (#849)", () => {
	it("sends the folder AND the asserted GitHub repo in one strict add", async () => {
		const { calls, tool } = setup();
		await tool.handler({ instance_id: "i1", path: "~/dev/stash", github_repo: "proappstore-online/stash" });
		const [post] = posts(calls);
		expect(post.url).toBe("https://api.test/v1/instances/i1/coding/repos");
		expect(JSON.parse(post.body ?? "{}")).toEqual({ localPath: "~/dev/stash", requireGithub: true, githubRepo: "proappstore-online/stash" });
	});

	it("leaves the GitHub half to the checkout's origin when github_repo is omitted — still strict", async () => {
		const { calls, tool } = setup();
		await tool.handler({ instance_id: "i1", path: "/Users/me/dev/stash" });
		expect(JSON.parse(posts(calls)[0].body ?? "{}")).toEqual({ localPath: "/Users/me/dev/stash", requireGithub: true });
	});

	it("REFUSES an owner/repo with no folder, naming the missing workdir, and calls nothing", async () => {
		const { calls, tool } = setup();
		const out = textOf(await tool.handler({ instance_id: "i1", path: "proappstore-online/stash" }));
		expect(out).toMatch(/^Error: missing the local workdir/);
		expect(out).toContain("pass `proappstore-online/stash` as `github_repo`");
		expect(posts(calls)).toHaveLength(0);
	});

	it("REFUSES a clone URL with no folder", async () => {
		const { calls, tool } = setup();
		const out = textOf(await tool.handler({ instance_id: "i1", path: "https://github.com/o/r.git" }));
		expect(out).toMatch(/missing the local workdir/);
		expect(posts(calls)).toHaveLength(0);
	});

	it("REFUSES a github_repo that is not owner/repo", async () => {
		const { calls, tool } = setup();
		const out = textOf(await tool.handler({ instance_id: "i1", path: "~/dev/stash", github_repo: "https://github.com/o/r" }));
		expect(out).toMatch(/github_repo must be a GitHub owner\/repo/);
		expect(posts(calls)).toHaveLength(0);
	});

	it("relays the API's refusal of a folder with no GitHub origin", async () => {
		const { tool } = setup({ error: "Missing the GitHub origin: `~/dev/x` has no readable `origin` remote." }, 400);
		const out = textOf(await tool.handler({ instance_id: "i1", path: "~/dev/x" }));
		expect(out).toContain("Missing the GitHub origin");
	});
});

describe("coding_repo_add — cold start: clone is opt-in (#857)", () => {
	it("sends clone:true with the folder and the repository", async () => {
		const { calls, tool } = setup();
		await tool.handler({ instance_id: "i1", path: "~/dev/grass-karma", github_repo: "acme/grass-karma", clone: true });
		expect(JSON.parse(posts(calls)[0].body ?? "{}")).toEqual({ localPath: "~/dev/grass-karma", requireGithub: true, githubRepo: "acme/grass-karma", clone: true });
	});

	it("sends no clone flag at all when the caller did not opt in — the request is byte-for-byte what it was", async () => {
		const { calls, tool } = setup();
		await tool.handler({ instance_id: "i1", path: "~/dev/grass-karma", github_repo: "acme/grass-karma" });
		expect(JSON.parse(posts(calls)[0].body ?? "{}")).toEqual({ localPath: "~/dev/grass-karma", requireGithub: true, githubRepo: "acme/grass-karma" });
	});

	it("REFUSES clone without github_repo — there is nothing to clone — and calls nothing", async () => {
		const { calls, tool } = setup();
		const out = textOf(await tool.handler({ instance_id: "i1", path: "~/dev/grass-karma", clone: true }));
		expect(out).toMatch(/^Error: clone needs github_repo/);
		expect(posts(calls)).toHaveLength(0);
	});
});
