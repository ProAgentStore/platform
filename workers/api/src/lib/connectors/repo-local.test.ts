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

import { REPO_LOCAL_TOOLS, REPO_SEARCH_MIN_CLI, repoMissingMessage, repoPathForInstance } from "./repo-local.js";
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
	it("registers all 6 tools, every one read-scoped", () => {
		const names = registryToolNameSet();
		for (const n of ["repo_tree", "repo_read_file", "repo_git", "repo_remote", "repo_find", "repo_grep"]) {
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
		// `pathApplied` is what a CURRENT runner reports (#508). Without it the tool correctly
		// appends the "your machine ignored the filter" note, which is a different test below.
		callRunner.mockResolvedValue({ cmd: "git log", output: "abc123 fix thing", pathApplied: true });
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

describe("finding a file — the capability the connector never had (#508)", () => {
	// Measured, Heartfull 2026-08-11 22:28: 18 tool calls in ONE turn, five of them repo_tree, and
	// three failed reads — two of which passed a DIRECTORY to repo_read_file. There was no grep, no
	// filename match and no content match anywhere in the connector or the runner, so locating a
	// file meant walking the tree by hand and guessing when it ran out.

	it("repo_find asks the runner for a path search and lists what it got", async () => {
		callRunner.mockResolvedValue({ matches: [{ path: "admin/lib/features/events/ui/pages/event_form_dialog.dart" }], shown: 1, total: 1, truncated: false });
		const r = await tool("repo_find").handler(ctx(), { pattern: "event_form" });
		expect(r.success).toBe(true);
		expect(r.content).toContain("event_form_dialog.dart");
		const [, path, body] = callRunner.mock.calls[0];
		expect(path).toBe("/coding/search");
		expect(body).toMatchObject({ pattern: "event_form", mode: "path" });
	});

	it("repo_grep asks for a CONTENT search and renders file:line: text", async () => {
		callRunner.mockResolvedValue({ matches: [{ path: "src/a.ts", line: 42, text: "class EventFormDialog {}" }], shown: 1, total: 1, truncated: false });
		const r = await tool("repo_grep").handler(ctx(), { pattern: "EventFormDialog" });
		expect(r.content).toContain("src/a.ts:42: class EventFormDialog {}");
		expect(callRunner.mock.calls[0][2]).toMatchObject({ mode: "content" });
	});

	it("says how much of the list it is NOT showing, rather than slicing bytes off the end", async () => {
		// #503 is how a byte cap fails: the model gets an arbitrary prefix and no statement that a
		// list was cut, so it concludes it has seen everything.
		callRunner.mockResolvedValue({ matches: [{ path: "a.ts" }], shown: 1, total: 812, truncated: true });
		const r = await tool("repo_find").handler(ctx(), { pattern: "a" });
		expect(r.content).toContain("showing 1 of 812");
		expect(r.content).toContain("narrow with");
	});

	it("an empty result is a plain, honest answer — not an error", async () => {
		callRunner.mockResolvedValue({ matches: [], shown: 0, total: 0, truncated: false });
		const r = await tool("repo_grep").handler(ctx(), { pattern: "nope" });
		expect(r.success).toBe(true);
		expect(r.content).toContain("no match");
	});

	it("requires a pattern rather than searching for everything", async () => {
		const r = await tool("repo_find").handler(ctx(), { pattern: "  " });
		expect(r.success).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("tells the owner his runner is too old instead of surfacing a raw 404", async () => {
		// The runner ships inside the published CLI, so this endpoint reaches a machine only after
		// a version bump and a CI publish. An older machine 404s, and a raw
		// "Runner /coding/search → 404" is a message nobody can act on.
		callRunner.mockRejectedValue(new Error("Runner /coding/search → 404: not found"));
		const r = await tool("repo_find").handler(ctx(), { pattern: "x" });
		expect(r.success).toBe(false);
		expect(r.content).toContain(REPO_SEARCH_MIN_CLI);
		expect(r.content).toContain("npm i -g @proagentstore/cli");
	});

	it("does NOT blame the CLI version for a real failure", async () => {
		// The half that keeps the message trustworthy: if every error said "upgrade", the one that
		// means it would be ignored.
		callRunner.mockRejectedValue(new Error("Runner /coding/search → 500: boom"));
		await expect(tool("repo_find").handler(ctx(), { pattern: "x" })).rejects.toThrow(/500/);
	});
});

describe("a depth stop and a dropped path are both VISIBLE now (#508)", () => {
	it("marks the folders repo_tree did not walk, and says the listing stopped", async () => {
		// The mechanism: `truncated` was set by the ENTRY cap only, so a directory stopped by the
		// DEPTH cap rendered exactly like an empty one — and the model read the leaf as the file it
		// was after and called repo_read_file on a directory.
		callRunner.mockResolvedValue({
			entries: [
				{ path: "admin/lib/features/events", type: "dir", deeper: true },
				{ path: "admin/lib/main.dart", type: "file", size: 10 },
			],
			truncated: false,
			truncatedByDepth: true,
		});
		const r = await tool("repo_tree").handler(ctx(), {});
		expect(r.content).toContain("contents NOT listed");
		expect(r.content).toContain("call repo_tree with path=admin/lib/features/events");
		expect(r.content).toContain("they are not empty");
	});

	it("adds no note when nothing was cut", async () => {
		callRunner.mockResolvedValue({ entries: [{ path: "a.ts", type: "file" }], truncated: false, truncatedByDepth: false });
		const r = await tool("repo_tree").handler(ctx(), {});
		expect(r.content).not.toContain("NOT listed");
		expect(r.content).not.toContain("truncated");
	});

	it("states the depth ceiling and the search tools in the tool description", async () => {
		// Step 1 of the fix, and the only step that works on the runner the owner has TODAY: the
		// schema advertised `maxDepth` with no ceiling, so a model asking for 10 silently got 4.
		const d = tool("repo_tree");
		expect(d.description).toContain("repo_find");
		expect(JSON.stringify(d.jsonSchema)).toContain("maximum 4");
		expect(d.description).toMatch(/never treat such a folder as empty/i);
	});

	it("warns when the machine's runner silently ignored `path` on repo_git", async () => {
		// An older runner returns no `pathApplied` at all. The output is then the WHOLE repository
		// while the caller asked for one folder — before this it was relayed as a correct answer.
		callRunner.mockResolvedValue({ cmd: "ls-files", output: "a.ts\nb.ts\n" });
		const r = await tool("repo_git").handler(ctx(), { cmd: "ls-files", path: "src" });
		expect(r.content).toContain("ignored the `path` filter");
		expect(r.content).toContain("WHOLE repository");
	});

	it("stays quiet on a current runner, including when it reports the path was the repo root", async () => {
		// `pathApplied:false` from a NEW runner means the requested path resolved to the root, where
		// the whole repo IS the right answer. Only an ABSENT field means "your machine is old".
		callRunner.mockResolvedValue({ cmd: "ls-files", output: "a.ts\n", pathApplied: true });
		expect((await tool("repo_git").handler(ctx(), { cmd: "ls-files", path: "src" })).content).not.toContain("ignored");
		callRunner.mockResolvedValue({ cmd: "ls-files", output: "a.ts\n", pathApplied: false });
		expect((await tool("repo_git").handler(ctx(), { cmd: "ls-files", path: "." })).content).not.toContain("ignored");
	});

	it("says `path` applies to every command, because now it does", async () => {
		expect(JSON.stringify(tool("repo_git").jsonSchema)).toContain("Applies to every command");
	});
});

describe("an unconfigured agent is told about the control it actually HAS (#513)", () => {
	// FIS coder (agent `coder-repo`), 2026-08-11 01:34 — the instance's entire history, and it has
	// not been used since. The tool result said: Set "Repository path" in the console. That is
	// `local-repo-chat`'s field label (0066). A `coder-repo` has a field labelled "Repository"
	// (0063). One hardcoded string served two agents, so the owner was sent to a setting that is
	// not on his screen — and it is the only guidance a Repo Coder with no repo can give him.

	/** A D1 stub that answers the JOIN the refusal path makes, not just the instance read. */
	const envJoin = (agentConfig: unknown, instanceConfig: unknown = { settings: {} }) =>
		({
			DB: {
				prepare: (sql: string) => ({
					bind: () => ({
						first: async () =>
							sql.includes("JOIN agents")
								? { agent_config: JSON.stringify(agentConfig), instance_config: JSON.stringify(instanceConfig) }
								: { config: JSON.stringify(instanceConfig) },
					}),
				}),
			},
		}) as unknown as Env;

	const CODER_REPO = {
		settingsSchema: [{ id: "repo", label: "Repository", type: "text" }],
		capabilities: { tools: ["repo_tree", "repo_git", "github_list_issues", "github_read_issue"] },
	};
	const LOCAL_REPO_CHAT = {
		settingsSchema: [{ id: "repo_path", label: "Repository path", type: "text" }],
		capabilities: { tools: ["repo_tree", "repo_read_file", "repo_git", "repo_remote"] },
	};

	const refuse = async (agentConfig: unknown, instanceConfig: unknown = { settings: {} }, name = "repo_tree") =>
		(await tool(name).handler({ env: envJoin(agentConfig, instanceConfig), userId: "u1", instanceId: "i1", agentId: "i1" } as never, {})).content as string;

	it("names Repository on a coder-repo and Repository path on a local-repo-chat", async () => {
		expect(await refuse(CODER_REPO)).toContain('Set "Repository"');
		expect(await refuse(CODER_REPO)).not.toContain("Repository path");
		expect(await refuse(LOCAL_REPO_CHAT)).toContain('Set "Repository path"');
	});

	it("takes the label from the agent's own settingsSchema, so a third agent needs no code change", async () => {
		const invented = { settingsSchema: [{ id: "repo_path", label: "Where the code lives" }], capabilities: { tools: ["repo_tree"] } };
		expect(await refuse(invented)).toContain('Set "Where the code lives"');
	});

	it("names no control at all rather than the wrong one, when there is no schema to read", async () => {
		// The explicitly-weaker fallback, chosen because a message naming NO control still beats one
		// naming a control that does not exist.
		expect(await refuse({ capabilities: { tools: ["repo_tree"] } })).toContain("Set the repository setting");
		expect(await refuse({ settingsSchema: [{ id: "repo", label: "   " }] })).toContain("Set the repository setting");
	});

	it("refuses identically through every local tool — the string served all four", async () => {
		for (const name of ["repo_tree", "repo_read_file", "repo_git", "repo_remote", "repo_find", "repo_grep"]) {
			expect(await refuse(CODER_REPO, { settings: {} }, name), name).toContain('Set "Repository"');
		}
	});

	it("says what still works, instead of declining GitHub work that needs no checkout", async () => {
		// The second defect in the same four lines: it told the owner it "can't ... look up issues
		// tied to a specific repo". `github_list_issues` takes `repo` as an ARGUMENT and was
		// `allowed:true` on that instance. The "but" is in the SAME string so the model cannot
		// separate it from the "no".
		const msg = await refuse(CODER_REPO);
		expect(msg).toContain("You can still answer questions about that repository's GitHub issues");
		expect(msg).toContain("need no checkout");
		// Bounded, per the ticket's own regression note: ask ONCE, and only with no coordinate.
		expect(msg).toContain("ask for it once");
	});

	it("does NOT promise GitHub work to an agent that declares no GitHub tool", async () => {
		// The correction to the ticket's proposal. local-repo-chat declares four repo tools and no
		// GitHub tool at all, so an unconditional escape hatch would move the false claim rather
		// than fix it.
		const msg = await refuse(LOCAL_REPO_CHAT);
		expect(msg).not.toContain("GitHub issues");
		expect(msg).toContain('Set "Repository path"');
	});

	it("says which repo it owns when the setting already holds owner/name", async () => {
		// The `coder-repo` field explicitly accepts "a local path (~/dev/my-repo) or owner/name".
		// repoPathForInstance skips the coordinate as "not a checkout" — honest for the LOCAL tools,
		// but the model was then made to ask for something the owner had already typed.
		const msg = await refuse(CODER_REPO, { settings: { repo: "ProAgentStore/platform" } });
		expect(msg).toContain("`ProAgentStore/platform`");
		expect(msg).toContain("has no local copy");
		expect(msg).toContain("Use `ProAgentStore/platform`.");
		expect(msg).not.toContain("ask for it once");
	});

	it("keeps a real checkout path out of the coordinate branch", async () => {
		// `~/work/my-repo` is a path, not a coordinate, and must never be offered to a GitHub tool.
		const msg = repoMissingMessage({ label: "Repository", github: true, coord: null });
		expect(msg).not.toContain("GitHub coordinate");
		expect(msg).toContain("ask for it once");
	});
});
