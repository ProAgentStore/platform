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
