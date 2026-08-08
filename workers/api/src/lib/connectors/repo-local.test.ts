import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the runner transport BEFORE importing the connector — every repo-local tool reaches
// the machine via getBoundRunnerConn + callRunner over the relay, exactly like tmux.
const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({
	getBoundRunnerConn: vi.fn(),
	callRunner: vi.fn(),
}));
vi.mock("../runner-client.js", () => ({
	getBoundRunnerConn,
	callRunner,
	READ_TIMEOUT_MS: 30_000,
}));

import { REPO_LOCAL_TOOLS, repoPathForInstance } from "./repo-local.js";
import { CONNECTORS } from "./registry.js";
import { getRegistryTool, registryToolNameSet } from "../tool-registry.js";
import type { Env } from "../../types.js";

const tool = (name: string) => {
	const t = REPO_LOCAL_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`no repo-local tool ${name}`);
	return t;
};

/** A D1 stub whose single row carries `config` — what repoPathForInstance parses. */
const envWith = (config: string | null) =>
	({
		DB: {
			prepare: () => ({
				bind: () => ({ first: async () => (config === null ? null : { config }) }),
			}),
		},
	}) as unknown as Env;

const ctx = (config: string | null = JSON.stringify({ settings: { repo_path: "~/work/my-repo" } }), over: Record<string, unknown> = {}) =>
	({ env: envWith(config), userId: "u1", instanceId: "i1", agentId: "i1", ...over }) as never;

const FAKE_CONN = { kind: "relay" } as never;

beforeEach(() => {
	getBoundRunnerConn.mockReset();
	callRunner.mockReset();
	getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
	callRunner.mockResolvedValue({});
});

describe("repo-local — registration", () => {
	it("registers all 4 tools, every one read-scoped", () => {
		const names = registryToolNameSet();
		for (const n of ["repo_tree", "repo_read_file", "repo_git", "repo_remote"]) {
			expect(names.has(n)).toBe(true);
			expect(getRegistryTool(n)?.scope).toBe("read");
			expect(getRegistryTool(n)?.connector).toBe("repo-local");
		}
	});

	// The whole reason this is a separate connector rather than more tmux tools: a connector
	// with scopes.write:false can never be write-consented, so this agent has no path to
	// running a command on the machine even if the model is talked into trying.
	it("declares no write scope at all", () => {
		const c = CONNECTORS.find((x) => x.id === "repo-local");
		expect(c).toBeDefined();
		expect(c?.scopes.write).toBe(false);
		expect(c?.auth).toBe("none");
		expect(REPO_LOCAL_TOOLS.every((t) => t.scope === "read")).toBe(true);
	});

	// Name collision guard: the DO file-storage tools are already called list_files/read_file
	// (agent-do-tools FILES). Reusing those names here would silently shadow one surface with
	// the other, so the repo_* prefix is load-bearing, not cosmetic.
	it("does not collide with the DO file-storage tool names", () => {
		const names = REPO_LOCAL_TOOLS.map((t) => t.name);
		expect(names).not.toContain("list_files");
		expect(names).not.toContain("read_file");
	});
});

describe("repoPathForInstance", () => {
	it("reads the repo_path setting off the instance config", async () => {
		expect(await repoPathForInstance(ctx())).toBe("~/work/my-repo");
	});

	it("returns null for a missing row, absent setting, blank value, or unparseable config", async () => {
		expect(await repoPathForInstance(ctx(null))).toBeNull();
		expect(await repoPathForInstance(ctx(JSON.stringify({ settings: {} })))).toBeNull();
		expect(await repoPathForInstance(ctx(JSON.stringify({ settings: { repo_path: "   " } })))).toBeNull();
		expect(await repoPathForInstance(ctx("{not json"))).toBeNull();
	});

	it("returns null without an instance/user context rather than reading anything", async () => {
		expect(await repoPathForInstance(ctx(null, { instanceId: undefined }))).toBeNull();
		expect(await repoPathForInstance(ctx(null, { userId: undefined }))).toBeNull();
	});
});

describe("repo-local — preconditions", () => {
	it("asks the user to configure a path before touching the runner", async () => {
		const r = await tool("repo_tree").handler(ctx(JSON.stringify({ settings: {} })), {});
		expect(r.success).toBe(false);
		expect(r.content).toContain("No repository is configured");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("tells the user to run `pags up` when no runner is connected", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const r = await tool("repo_read_file").handler(ctx(), { path: "src/index.ts" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("pags up");
		expect(callRunner).not.toHaveBeenCalled();
	});
});

describe("repo-local — tool behaviour", () => {
	it("repo_tree sends the configured workDir and renders dirs with a trailing slash", async () => {
		callRunner.mockResolvedValue({
			entries: [
				{ path: "src", type: "dir" },
				{ path: "src/index.ts", type: "file", size: 120 },
			],
		});
		const r = await tool("repo_tree").handler(ctx(), { path: "src", maxDepth: 2 });
		expect(callRunner).toHaveBeenCalledWith(
			FAKE_CONN,
			"/coding/tree",
			{ workDir: "~/work/my-repo", path: "src", maxDepth: 2 },
			expect.anything(),
		);
		expect(r.content).toBe("src/\nsrc/index.ts");
		expect(r.success).toBe(true);
	});

	it("repo_tree flags truncation so the model narrows instead of assuming it saw everything", async () => {
		callRunner.mockResolvedValue({ entries: [{ path: "a.ts", type: "file" }], truncated: true });
		const r = await tool("repo_tree").handler(ctx(), {});
		expect(r.content).toContain("truncated");
	});

	it("repo_read_file caps the byte budget and labels the excerpt with its path", async () => {
		callRunner.mockResolvedValue({ content: "export const a = 1;", size: 19 });
		const r = await tool("repo_read_file").handler(ctx(), { path: "src/a.ts" });
		expect(callRunner).toHaveBeenCalledWith(
			FAKE_CONN,
			"/coding/read-file",
			{ workDir: "~/work/my-repo", path: "src/a.ts", maxBytes: 8 * 1024 },
			expect.anything(),
		);
		expect(r.content).toContain("--- src/a.ts ---");
		expect(r.content).toContain("export const a = 1;");
	});

	it("repo_read_file requires a path and reports a binary file instead of dumping bytes", async () => {
		expect((await tool("repo_read_file").handler(ctx(), { path: "  " })).success).toBe(false);
		callRunner.mockResolvedValue({ binary: true, size: 4096 });
		const r = await tool("repo_read_file").handler(ctx(), { path: "logo.png" });
		expect(r.content).toContain("binary file");
	});

	// The runner whitelists the git command via gitArgv, but rejecting here too means a bad
	// enum never becomes a relay round-trip.
	it("repo_git rejects a command outside the read-only whitelist without calling the runner", async () => {
		const r = await tool("repo_git").handler(ctx(), { cmd: "push" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("must be one of");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("repo_git passes a whitelisted command through with its path/n options", async () => {
		callRunner.mockResolvedValue({ cmd: "git log", output: "abc123 fix thing" });
		const r = await tool("repo_git").handler(ctx(), { cmd: "log", n: 5, path: "src" });
		expect(callRunner).toHaveBeenCalledWith(
			FAKE_CONN,
			"/coding/git",
			{ workDir: "~/work/my-repo", cmd: "log", path: "src", n: 5 },
			expect.anything(),
		);
		expect(r.content).toBe("abc123 fix thing");
	});

	it("repo_remote reports the origin, and says so plainly when there isn't one", async () => {
		callRunner.mockResolvedValue({ remote: "git@github.com:acme/thing.git" });
		expect((await tool("repo_remote").handler(ctx(), {})).content).toContain("acme/thing");
		callRunner.mockResolvedValue({ remote: null });
		expect((await tool("repo_remote").handler(ctx(), {})).content).toContain("no git origin remote");
	});

	// The runner answers a rejected read (traversal, missing file) as HTTP 400 {error} rather
	// than throwing, so a handler that ignored `error` would report failure as success.
	it("surfaces a runner-side error as a failed result", async () => {
		callRunner.mockResolvedValue({ error: "path escapes the repo: ../../.ssh/id_rsa" });
		const r = await tool("repo_read_file").handler(ctx(), { path: "../../.ssh/id_rsa" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("escapes the repo");
	});
});

/**
 * The reason an agent invents a repository (#405).
 *
 * Every tool here used to report the ABSENCE of a checkout as a success with a true, useless
 * sentence — "(no files found at that path)", "(no git origin remote)". An agent handed no
 * problem, and still asked about the code, has nothing to relay and fills the gap (#395).
 *
 * The pair of expectations below is the whole ticket, and neither half is safe on its own:
 * a missing WORKDIR must become a named failure, and an empty SUBFOLDER of a healthy checkout
 * must stay exactly the success it was.
 */
describe("repo-local — an empty answer is diagnosed, not shrugged at (#405)", () => {
	const HEALTHY = { checked: true, path: "/home/u/work/my-repo", exists: true, isDirectory: true, entryCount: 87, insideWorkTree: true, gitChecked: true };
	const EMPTY = { checked: true, path: "/home/u/work/my-repo", exists: true, isDirectory: true, entryCount: 0, insideWorkTree: false, gitChecked: true };
	const GONE = { checked: true, path: "/home/u/work/my-repo", exists: false, isDirectory: false, entryCount: 0, insideWorkTree: false, gitChecked: true };

	/** Answer `/coding/repo-check` with `check`, and every other runner path with `rest`. */
	const runner = (check: unknown, rest: unknown) =>
		callRunner.mockImplementation(async (_conn: unknown, path: string) => (path === "/coding/repo-check" ? check : rest));

	it("repo_tree FAILS, naming the path and the condition, when the workdir is empty", async () => {
		runner(EMPTY, { entries: [] });
		const r = await tool("repo_tree").handler(ctx(), {});
		expect(r.success).toBe(false);
		expect(r.content).toContain("/home/u/work/my-repo");
		expect(r.content).toMatch(/EMPTY/);
	});

	it("repo_tree KEEPS its success for an empty subfolder of a real checkout", async () => {
		runner(HEALTHY, { entries: [] });
		const r = await tool("repo_tree").handler(ctx(), { path: "src/components" });
		expect(r.success).toBe(true);
		expect(r.content).toBe("(no files found at that path)");
	});

	// The two cases above are told apart ONLY by asking about the root. Asking about the tool's
	// `path` would make every empty subfolder look like a missing checkout.
	it("checks the workdir ROOT, never the sub-path being listed", async () => {
		runner(HEALTHY, { entries: [] });
		await tool("repo_tree").handler(ctx(), { path: "src/components" });
		const call = callRunner.mock.calls.find((c: unknown[]) => c[1] === "/coding/repo-check");
		expect(call?.[2]).toEqual({ workDir: "~/work/my-repo" });
	});

	it("repo_remote FAILS with the diagnosis when the folder is not a checkout at all", async () => {
		runner({ ...HEALTHY, insideWorkTree: false }, { remote: null });
		const r = await tool("repo_remote").handler(ctx(), {});
		expect(r.success).toBe(false);
		expect(r.content).toContain("/home/u/work/my-repo");
		expect(r.content).toMatch(/not inside a git working tree/);
	});

	it("repo_remote KEEPS its success for a real checkout that simply has no origin", async () => {
		runner(HEALTHY, { remote: null });
		const r = await tool("repo_remote").handler(ctx(), {});
		expect(r.success).toBe(true);
		expect(r.content).toContain("no git origin remote");
	});

	it("repo_git replaces the runner's anonymous 'not a git repo' with the path", async () => {
		runner(GONE, { error: "not a git repo" });
		const r = await tool("repo_git").handler(ctx(), { cmd: "status" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("/home/u/work/my-repo");
		expect(r.content).toMatch(/does not exist/);
	});

	it("repo_read_file keeps the file's own error AND names the vanished checkout", async () => {
		runner(GONE, { error: "ENOENT: no such file or directory" });
		const r = await tool("repo_read_file").handler(ctx(), { path: "src/auth.ts" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("/home/u/work/my-repo");
		expect(r.content).toContain("src/auth.ts");
	});

	// A CLI that predates /coding/repo-check 404s it, and the relay hands back {error}. That is a
	// version skew, not a broken repo — the old wording must survive it untouched.
	it("changes nothing when the machine is running an older runner", async () => {
		runner({ error: "Not found" }, { entries: [] });
		const r = await tool("repo_tree").handler(ctx(), {});
		expect(r.success).toBe(true);
		expect(r.content).toBe("(no files found at that path)");
	});

	it("costs nothing on the answers that worked — a non-empty tree asks no second question", async () => {
		runner(HEALTHY, { entries: [{ path: "src/index.ts", type: "file" }] });
		const r = await tool("repo_tree").handler(ctx(), {});
		expect(r.success).toBe(true);
		expect(callRunner.mock.calls.some((c: unknown[]) => c[1] === "/coding/repo-check")).toBe(false);
	});
});
