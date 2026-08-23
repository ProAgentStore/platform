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
import { getRegistryTool, registryToolNameSet, renderToolContent } from "../tool-registry.js";
// The budget both caps in this file are sized against (#534's AC 5) — asserted against the real
// constant so raising one of them without re-reading the other fails here.
import { TOOL_RESULT_MAX_CHARS, capToolResult } from "../tool-result-cap.js";
import { FENCE_TAG, unfenceUntrusted } from "../untrusted-fence.js";
import type { Env } from "../../types.js";

/**
 * The tool, with its handler wrapped the way `runRegistryTool` delivers it (#752).
 *
 * Every one of these tools declares `untrustedOutput: true` — a checkout is mostly code the owner
 * did NOT write, and a pane is whatever any command printed (#751) — so the dispatcher fences the
 * body and keeps the platform's notes ("showing 50 of 812", "this machine's runner ignored the
 * `path` filter") outside it via head/tail. Asserting on the raw handler result would test one
 * layer below where both properties now live.
 */
/**
 * Split a dispatched result into the platform's framing and the fenced body.
 *
 * The two halves are asserted separately on purpose: which side of the fence a sentence lands on IS
 * the invariant (ADR 0006 F2). A test that only searched the whole string would pass with the
 * "showing 50 of 812" note inside the block, which is the case #748 shipped in the other direction.
 */
function parts(content: string): { head: string; body: string; tail: string } {
	const open = content.indexOf(`<${FENCE_TAG}`);
	if (open === -1) return { head: content.trim(), body: "", tail: "" };
	const closeTag = `</${FENCE_TAG}>`;
	const close = content.lastIndexOf(closeTag);
	return {
		head: content.slice(0, open).trim(),
		body: unfenceUntrusted(content.slice(open, close + closeTag.length)).trim(),
		tail: content.slice(close + closeTag.length).trim(),
	};
}

const tool = (name: string) => {
	const t = REPO_LOCAL_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`no repo-local tool ${name}`);
	return {
		...t,
		handler: async (...args: Parameters<typeof t.handler>) => {
			const r = await t.handler(...args);
			return { ...r, content: renderToolContent(t, r) };
		},
	};
};

/**
 * A D1 stub answering both reads the connector makes: the instance's `config` (`.first`) and the
 * instance's `coding_repos` rows (`.all`). The rows default to EMPTY, so every pre-#520 test keeps
 * measuring the settings fallback exactly as it did.
 */
const envWith = (config: string | null, repos: Array<{ name: string; workdir: string | null; clone_status?: string }> = []) =>
	({
		DB: {
			prepare: () => ({
				bind: () => ({
					first: async () => (config === null ? null : { config }),
					all: async () => ({ results: repos }),
				}),
			}),
		},
	}) as unknown as Env;

const ctx = (config: string | null = JSON.stringify({ settings: { repo_path: "~/work/my-repo" } }), over: Record<string, unknown> = {}, repos: Array<{ name: string; workdir: string | null; clone_status?: string }> = []) =>
	({ env: envWith(config, repos), userId: "u1", instanceId: "i1", agentId: "i1", ...over }) as never;

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

/**
 * Which address wins (#520).
 *
 * Migration 0102 deleted the Repo Coder's `repo` SETTING — correctly, because #410 had made the
 * folder editable on the `coding_repos` row and two homes for one address is what produced the
 * original "I updated it and it still uses the old one". What it did not do was move the READER:
 * `repoPathForInstance` still read only the setting, and `applySettingsPatch` is schema-driven, so
 * from that migration on nothing could write the value six tools required. Every `coder-repo`
 * instance subscribed after it had no working `repo_*` tool at all.
 *
 * So the row is the source and the setting is the fallback. The three cases below are the whole
 * decision, and each one is a live instance: a Chess coder (row with a folder), a `local-repo-chat`
 * (no rows, `repo_path` still on its schema), and Chess coder's broken folder, which must still be
 * RETURNED so #405 can diagnose it rather than reporting "no repository is configured".
 */
describe("repoPathForInstance — the repo row is the address, the setting is the fallback", () => {
	it("prefers the repo row's workdir over the stored setting", async () => {
		const c = ctx(JSON.stringify({ settings: { repo: "~/stale/from-settings" } }), {}, [{ name: "chess", workdir: "~/dev/stores/pas/apps/chess-academy" }]);
		expect(await repoPathForInstance(c)).toBe("~/dev/stores/pas/apps/chess-academy");
	});

	it("falls back to the setting when no repo row carries a folder", async () => {
		// `local-repo-chat` has no repo rows at all; FIS coder has a row with no folder. Both land
		// here, and for the first of the two the setting is still the right and only answer.
		expect(await repoPathForInstance(ctx(JSON.stringify({ settings: { repo_path: "~/work/my-repo" } }), {}, []))).toBe("~/work/my-repo");
		expect(await repoPathForInstance(ctx(JSON.stringify({ settings: { repo_path: "~/work/my-repo" } }), {}, [{ name: "fis", workdir: null }]))).toBe("~/work/my-repo");
		expect(await repoPathForInstance(ctx(JSON.stringify({ settings: { repo_path: "~/work/my-repo" } }), {}, [{ name: "fis", workdir: "   " }]))).toBe("~/work/my-repo");
	});

	it("returns an UNVERIFIED workdir rather than hiding it — #405 needs the path to diagnose", async () => {
		// The tempting filter is `cloneStatus === 'ready'`. It would turn "the configured checkout
		// does not exist on the connected machine" back into "no repository is configured", which is
		// the useless sentence #405 exists to replace. Only a MEASURED fault demotes a row (below);
		// a row nobody has looked at is used, and diagnosed at call time if it turns out to be gone.
		const c = ctx(null, {}, [{ name: "chess", workdir: "~/dev/stores/pas/platform/apps/chess-academy" }]);
		expect(await repoPathForInstance(c)).toBe("~/dev/stores/pas/platform/apps/chess-academy");
	});

	it("yields to the setting when the MACHINE has faulted the row's folder", async () => {
		// Chess coder `bfc76603`, measured in production 2026-08-12: `repo_tree` works today off the
		// orphaned setting, while its row points at a folder the runner reports does not exist. A
		// flat row-first rule would take a WORKING instance to a broken one — #520 criterion 3 names
		// pre-0102 instances specifically. `needs_attention` may decide this because
		// `cloneStatusForVerdict` writes it only from a definite verdict and returns null for
		// `unverified`, so an offline or too-old runner never demotes a good row.
		const c = ctx(JSON.stringify({ settings: { repo: "~/dev/stores/pas/apps/chess-academy" } }), {}, [
			{ name: "chess", workdir: "~/dev/stores/pas/platform/apps/chess-academy", clone_status: "needs_attention" },
		]);
		expect(await repoPathForInstance(c)).toBe("~/dev/stores/pas/apps/chess-academy");
	});

	it("still returns the faulted row when it is the ONLY candidate", async () => {
		// Stepping aside is only ever in favour of something else. With no setting to fall back to,
		// swallowing the path would cost the owner #405's diagnosis AND the name of the one control
		// he can edit (#410) — he would be told nothing is configured while a repo sits on his
		// Coding tab.
		const c = ctx(null, {}, [{ name: "chess", workdir: "~/broken", clone_status: "needs_attention" }]);
		expect(await repoPathForInstance(c)).toBe("~/broken");
	});

	it("prefers a healthy row over a faulted one regardless of recency", async () => {
		const c = ctx(null, {}, [
			{ name: "newest but faulted", workdir: "~/work/gone", clone_status: "needs_attention" },
			{ name: "older, fine", workdir: "~/work/here", clone_status: "ready" },
		]);
		expect(await repoPathForInstance(c)).toBe("~/work/here");
	});

	it("takes the most recently updated row that has a folder", async () => {
		// `listRepoWorkdirs` orders `updated_at DESC` — the same ordering `listRepos` uses, so "which
		// repo" cannot depend on which function asked. A row with no folder is skipped, not chosen.
		const c = ctx(null, {}, [
			{ name: "newest, no folder", workdir: null },
			{ name: "newest with a folder", workdir: "~/work/a" },
			{ name: "older", workdir: "~/work/b" },
		]);
		expect(await repoPathForInstance(c)).toBe("~/work/a");
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
		expect(parts(r.content).body).toBe("src/\nsrc/index.ts");
		expect(r.success).toBe(true);
	});

	it("repo_tree flags truncation so the model narrows instead of assuming it saw everything", async () => {
		callRunner.mockResolvedValue({ entries: [{ path: "a.ts", type: "file" }], truncated: true });
		const r = await tool("repo_tree").handler(ctx(), {});
		expect(r.content).toContain("truncated");
	});

	it("repo_read_file asks the runner for everything it will give and labels the window with its path", async () => {
		callRunner.mockResolvedValue({ content: "export const a = 1;", size: 19 });
		const r = await tool("repo_read_file").handler(ctx(), { path: "src/a.ts" });
		expect(callRunner).toHaveBeenCalledWith(
			FAKE_CONN,
			"/coding/read-file",
			// The runner clamps at its own HARD_MAX_FILE_BYTES; the slicing is cloud-side (#534), so
			// there is no CLI release in this and no version to skew on.
			{ workDir: "~/work/my-repo", path: "src/a.ts", maxBytes: 128 * 1024 },
			expect.anything(),
		);
		expect(r.content).toContain("--- src/a.ts — lines 1-1 of 1 (the whole file) ---");
		expect(r.content).toContain("1: export const a = 1;");
	});

	// #534's acceptance test, at the tool boundary: firestore.rules is 511+ lines and the rule the
	// owner needed sits at 511 — past the old 8KB cut, and unreachable by ANY argument the model
	// could pass, which is why the agent had to fall back to repo_grep.
	it("repo_read_file returns a line range past the old 8KB cut in one call", async () => {
		const lines = Array.from({ length: 560 }, (_, i) => `// filler ${i + 1} ${"x".repeat(40)}`);
		lines[510] = "match /eventCalls/{callId} {";
		callRunner.mockResolvedValue({ content: lines.join("\n"), size: 30_000 });
		const r = await tool("repo_read_file").handler(ctx(), { path: "firestore.rules", startLine: 505, endLine: 515 });
		expect(r.success).toBe(true);
		expect(r.content).toContain("511: match /eventCalls/{callId} {");
	});

	it("repo_read_file discloses a window in the HEADER, with the call that returns the next one", async () => {
		const content = Array.from({ length: 3_000 }, (_, i) => `const line${i} = ${i};`).join("\n");
		callRunner.mockResolvedValue({ content, size: content.length });
		const r = await tool("repo_read_file").handler(ctx(), { path: "big.ts" });
		expect(r.success).toBe(true);
		// The head is what capToolResult keeps, so everything needed to ask again lives there.
		const head = r.content.slice(0, 600);
		expect(head).toContain("of 3,000");
		expect(head).toContain("were NOT returned");
		expect(head).toMatch(/startLine=\d/);
	});

	it("repo_read_file refuses a startLine past the end instead of returning an empty window", async () => {
		callRunner.mockResolvedValue({ content: "a\nb\nc\n", size: 6 });
		const r = await tool("repo_read_file").handler(ctx(), { path: "src/a.ts", startLine: 900 });
		expect(r.success).toBe(false);
		expect(r.content).toContain("has 3 lines");
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
		expect(parts(r.content).body).toBe("abc123 fix thing");
	});

	// AC 5, the sibling cap in the same shape as the one #534 is about: the handler used to
	// `.slice(0, CAPS.git)` and never read `res.truncated`, so a cut `git diff` was textually
	// indistinguishable from a complete one — at BOTH the machine's 64KB cut and this 12KB one.
	it("repo_git says when the output was cut, at either end", async () => {
		callRunner.mockResolvedValue({ cmd: "git diff", output: "x".repeat(20_000), pathApplied: false });
		const wide = await tool("repo_git").handler(ctx(), { cmd: "diff" });
		expect(wide.content.startsWith("(TRUNCATED:")).toBe(true);
		expect(wide.content).toContain("diff-stat");

		callRunner.mockResolvedValue({ cmd: "git diff", output: "short", truncated: true, pathApplied: false });
		const machine = await tool("repo_git").handler(ctx(), { cmd: "diff" });
		expect(machine.content).toContain("your machine had already cut it");
	});

	it("repo_git stays byte-for-byte unchanged when nothing was cut", async () => {
		callRunner.mockResolvedValue({ cmd: "git status", output: "## main\n M src/a.ts", pathApplied: false });
		const r = await tool("repo_git").handler(ctx(), { cmd: "status" });
		expect(parts(r.content).body).toBe("## main\n M src/a.ts");
	});

	// Same class again, and the one AC 5 calls "the better pattern". It bounded by match count at
	// the RUNNER and by characters here, so a deep-path repo lost the tail of the list: this exact
	// fixture renders to 16,229 characters and the old 12,288 slice delivered 37 matches and a
	// fragment — while the note said "showing 50 of 812". 20,000 admits all 50.
	it("repo_grep returns every match the runner sent when they fit, and counts them honestly", async () => {
		const matches = Array.from({ length: 50 }, (_, i) => ({ path: `${"deep/".repeat(30)}file${i}.ts`, line: i, text: "x".repeat(160) }));
		callRunner.mockResolvedValue({ matches, shown: 50, total: 812, truncated: true });
		const r = await tool("repo_grep").handler(ctx(), { pattern: "x" });
		expect(r.content).toContain("showing 50 of 812");
		expect(r.content.split("\n").filter((l) => l.includes("file")).length).toBe(50);
	});

	// The count is the one part of a truncated search result the model must act on, so it goes
	// where `capToolResult` keeps it — the head. As a tail note it was the FIRST thing a second cut
	// would remove, the same landmine repo_read_file's header was moved to defuse.
	it("repo_grep puts the count in the HEADER, where capToolResult keeps it", async () => {
		callRunner.mockResolvedValue({ matches: [{ path: "a.ts", line: 1, text: "x" }], shown: 1, total: 812, truncated: true });
		const r = await tool("repo_grep").handler(ctx(), { pattern: "x" });
		expect(r.content.split("\n")[0]).toContain("showing 1 of 812");
		expect(capToolResult(r.content, 60)).toContain("showing 1 of 812");
	});

	// AC 5's substance: whole matches are dropped, never characters, and the number the model is
	// told is the number it received — not the runner's, which is about a different cut.
	it("repo_grep drops whole matches when even 50 do not fit, and reports what it kept", async () => {
		// 300-character paths: 50 of these render past the 20,000 budget, so the cloud cuts too.
		const matches = Array.from({ length: 50 }, (_, i) => ({ path: `${"deep/".repeat(60)}file${i}.ts`, line: i, text: "x".repeat(160) }));
		callRunner.mockResolvedValue({ matches, shown: 50, total: 812, truncated: true });
		const r = await tool("repo_grep").handler(ctx(), { pattern: "x" });
		const { head, body: fenced } = parts(r.content);
		const body = fenced.split("\n");
		expect(body.length).toBeLessThan(50);
		expect(head).toContain(`showing ${body.length} of 812`);
		// Every delivered line is a COMPLETE match — the old slice ended one mid-path.
		for (const line of body) expect(line.endsWith("x".repeat(160))).toBe(true);
		// And the whole result still clears the ceiling it is sized against, header included.
		expect(r.content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS);
	});

	// repo_git's half of AC 5 is a JUDGEMENT, not a change: 12,288 stays, sized at half of
	// TOOL_RESULT_MAX_CHARS so a second `repo_git` fits in the same round, because a cut diff is not
	// resumable (no startLine, no offset) and a longer prefix is not a better answer. What the test
	// pins is the disclosure — the note is a header, so the outer cap can never take it.
	it("repo_git's truncation note is a header that survives the tool-result cap", async () => {
		callRunner.mockResolvedValue({ cmd: "git diff", output: "x".repeat(200_000), pathApplied: false });
		const r = await tool("repo_git").handler(ctx(), { cmd: "diff" });
		expect(capToolResult(r.content).startsWith("(TRUNCATED:")).toBe(true);
		expect(capToolResult(r.content)).toContain("diff-stat");
		// Half the ceiling, on purpose: the note names the follow-up call, so leave room to make it.
		expect(r.content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS / 2 + 1_000);
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

	/** A D1 stub that answers the JOIN the refusal path makes, the instance read, and the repo rows. */
	const envJoin = (agentConfig: unknown, instanceConfig: unknown = { settings: {} }, repos: Array<{ name: string; workdir: string | null; clone_status?: string }> = [], agentRow: { slug?: string | null; category?: string | null } = {}) =>
		({
			DB: {
				prepare: (sql: string) => ({
					bind: () => ({
						first: async () =>
							sql.includes("JOIN agents")
								? { slug: agentRow.slug ?? null, category: agentRow.category ?? null, agent_config: JSON.stringify(agentConfig), instance_config: JSON.stringify(instanceConfig) }
								: { config: JSON.stringify(instanceConfig) },
						all: async () => ({ results: repos }),
					}),
				}),
			},
		}) as unknown as Env;

	// The pre-0102 shape, kept verbatim: `local-repo-chat` still declares its field, and a
	// creator-authored agent may declare either key, so this branch is not historical.
	const CODER_REPO = {
		settingsSchema: [{ id: "repo", label: "Repository", type: "text" }],
		capabilities: { tools: ["repo_tree", "repo_git", "github_list_issues", "github_read_issue"] },
	};
	const LOCAL_REPO_CHAT = {
		settingsSchema: [{ id: "repo_path", label: "Repository path", type: "text" }],
		capabilities: { tools: ["repo_tree", "repo_read_file", "repo_git", "repo_remote"] },
	};

	const refuse = async (agentConfig: unknown, instanceConfig: unknown = { settings: {} }, name = "repo_tree", repos: Array<{ name: string; workdir: string | null; clone_status?: string }> = [], agentRow: { slug?: string | null; category?: string | null } = {}) =>
		(await tool(name).handler({ env: envJoin(agentConfig, instanceConfig, repos, agentRow), userId: "u1", instanceId: "i1", agentId: "i1" } as never, {})).content as string;

	it("names Repository on a coder-repo and Repository path on a local-repo-chat", async () => {
		expect(await refuse(CODER_REPO)).toContain('Set "Repository"');
		expect(await refuse(CODER_REPO)).not.toContain("Repository path");
		expect(await refuse(LOCAL_REPO_CHAT)).toContain('Set "Repository path"');
	});

	it("takes the label from the agent's own settingsSchema, so a third agent needs no code change", async () => {
		const invented = { settingsSchema: [{ id: "repo_path", label: "Where the code lives" }], capabilities: { tools: ["repo_tree"] } };
		expect(await refuse(invented)).toContain('Set "Where the code lives"');
	});

	it("keeps the generic label for a field declared with a blank one — the control still exists", async () => {
		// A field IS declared, so Settings → Agent settings is the right place; only the label is
		// unusable. Quoting "" would be worse than naming the setting generically.
		expect(await refuse({ settingsSchema: [{ id: "repo", label: "   " }], capabilities: { tools: ["repo_tree"] } })).toContain(
			"Set the repository setting in the console (Settings → Agent settings)",
		);
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
		const msg = repoMissingMessage({ label: "Repository", github: true, coord: null, coding: false, repoWithoutFolder: null });
		expect(msg).not.toContain("GitHub coordinate");
		expect(msg).toContain("ask for it once");
	});
});

/**
 * The control the refusal names must be one that EXISTS — after 0102 as well (#520).
 *
 * #513's fix was correct on the day it shipped and false six hours later: migration 0102 deleted
 * `coder-repo`'s `repo` field, so "Settings → Agent settings" now names a card with no such
 * control on the very agent #513 was written for. Three cases, three answers, and the pure
 * function is asserted directly so every one of them is readable in one place.
 */
describe("after 0102 the refusal points at the Coding tab, not a deleted setting (#520)", () => {
	const CODER_REPO_TODAY = {
		// What `coder-repo` declares after 0102: engine/autonomy/merge_policy, no repo field.
		settingsSchema: [{ id: "engine", label: "Coding CLI", type: "select" }, { id: "autonomy", label: "Autonomy", type: "select" }],
		capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION", tools: ["repo_tree", "repo_git", "github_list_issues"] },
	};

	/** The same D1 stub the #513 block uses, reached through a real tool handler. */
	const refuseWith = async (agentConfig: unknown, repos: Array<{ name: string; workdir: string | null; clone_status?: string }>, agentRow: { slug?: string | null; category?: string | null } = {}) => {
		const env = {
			DB: {
				prepare: (sql: string) => ({
					bind: () => ({
						first: async () =>
							sql.includes("JOIN agents")
								? { slug: agentRow.slug ?? null, category: agentRow.category ?? null, agent_config: JSON.stringify(agentConfig), instance_config: JSON.stringify({ settings: {} }) }
								: { config: JSON.stringify({ settings: {} }) },
						all: async () => ({ results: repos }),
					}),
				}),
			},
		} as unknown as Env;
		return (await tool("repo_tree").handler({ env, userId: "u1", instanceId: "i1", agentId: "i1" } as never, {})).content as string;
	};

	it("tells a Repo Coder with no repo at all to add one in the Coding tab", () => {
		const msg = repoMissingMessage({ label: null, github: false, coord: null, coding: true, repoWithoutFolder: null });
		expect(msg).toContain("Coding tab");
		expect(msg).not.toContain("Settings → Agent settings");
		expect(msg).toContain("folder on your machine");
	});

	it("names the repo whose FOLDER is missing, so the owner fixes the row he already has", () => {
		// FIS coder `5d14a2e1` exactly: one repo row, `clone_status: ready`, and no workdir. Told
		// "add a repository" the owner adds a second one; told this, he fixes the first.
		const msg = repoMissingMessage({ label: null, github: false, coord: null, coding: true, repoWithoutFolder: "～/dev/stores/fis/platform" });
		expect(msg).toContain('"～/dev/stores/fis/platform"');
		expect(msg).toContain("no folder on your machine is recorded for it");
		expect(msg).toContain("rather than adding a second one");
	});

	it("says plainly that there is no control, rather than inventing one", () => {
		// The weakest of the three answers and still the right one: an agent with no repo field and
		// no Coding tab genuinely cannot be pointed anywhere, and #513/#517's rule is that a message
		// naming nothing beats a message naming a control the owner will not find.
		const msg = repoMissingMessage({ label: null, github: false, coord: null, coding: false, repoWithoutFolder: null });
		expect(msg).toContain("no console control for a repository");
		expect(msg).not.toContain("Settings → Agent settings");
		// It may SAY there is no Coding tab; what it must never do is send the owner to one.
		expect(msg).not.toMatch(/Set "|Add the repository|Open that repository|in the Coding tab/);
	});

	it("a declared schema field still wins — local-repo-chat has no Coding tab and needs its setting", () => {
		const msg = repoMissingMessage({ label: "Repository path", github: false, coord: null, coding: false, repoWithoutFolder: null });
		expect(msg).toContain('Set "Repository path" in the console (Settings → Agent settings)');
	});

	it("resolves the coding surface end to end, from the agent row the refusal reads", async () => {
		// The pure function is only half the guarantee: `repoRefusalHint` has to READ the surface.
		const msg = await refuseWith(CODER_REPO_TODAY, [{ name: "～/dev/stores/fis/platform", workdir: null }]);
		expect(msg).toContain("Coding tab");
		expect(msg).toContain("～/dev/stores/fis/platform");
		// The escape hatch and the base sentence both survive the new branch.
		expect(msg).toContain("No repository is configured for this agent.");
		expect(msg).toContain("You can still answer questions about that repository's GitHub issues");
	});

	it("honours a legacy agent's RESOLVED surface, not just a declared one", async () => {
		// `category:'code'` resolves to `surfaces:['coding']` in agentCapabilities, so such an agent
		// really does render the Coding tab. Reading only the declaration would tell its owner no
		// control exists while one is on his screen — #513's defect with the sign flipped.
		const legacy = { capabilities: { tools: ["repo_tree"] } };
		const msg = await refuseWith(legacy, [], { slug: "legacy-coder", category: "code" });
		expect(msg).toContain("Coding tab");
	});
});

describe("the tools read the repo row's folder, not just the setting (#520)", () => {
	it("repo_tree sends the workdir from the coding_repos row", async () => {
		callRunner.mockResolvedValue({ entries: [{ path: "src/index.ts", type: "file" }] });
		await tool("repo_tree").handler(ctx(JSON.stringify({ settings: { repo: "~/stale" } }), {}, [{ name: "chess", workdir: "~/dev/chess" }]), {});
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/coding/tree", { workDir: "~/dev/chess", path: undefined, maxDepth: undefined }, expect.anything());
	});
});
