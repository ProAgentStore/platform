import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBranchTools } from "./branch-tools.js";

// #1700: the branch tools' seam with the API — a read never POSTs, a mutation needs the exact confirm and is refused before the
// network without it, a preview is the read tool's, and a completed mutation (or a refusal the API reports) is audited.
type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: (init?.body as string | undefined) ?? null });
		return new Response(JSON.stringify(opts.body ?? { ok: true }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
	});
	const store = new Map<string, string>();
	const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }) } as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, Handler>();
	registerBranchTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal MCP registrar for the real handlers
		{ tool: (name: string, _d: string, _s: Record<string, z.ZodTypeAny>, handler: Handler) => tools.set(name, handler) } as any,
		{ env, tokenFor: (t?: string) => t || "session-token", safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime", "destructive"]) as SafetyContext["scopes"] }), groups: new Set<string>() },
	);
	const run = (name: string, args: Record<string, unknown>) => tools.get(name)!(args);
	const events = () => [...store.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string });
	return { calls, run, events };
}

afterEach(() => vi.unstubAllGlobals());
const TIP = "a".repeat(40);
const base = { instance_id: "i1", repo_id: "r1", runner_node: "Macmini.modem" };

describe("coding_branches", () => {
	it("inventory and compare are GETs of the repo's branches route", async () => {
		const { calls, run } = setup({ scopes: ["read"] });
		await run("coding_branches", { instance_id: "i1", repo_id: "r1" });
		await run("coding_branches", { ...base, compare: "feature", base: "main" });
		expect(calls.map((c) => [c.method, c.url])).toEqual([
			["GET", "https://api.test/v1/instances/i1/coding/repos/r1/branches"],
			["GET", "https://api.test/v1/instances/i1/coding/repos/r1/branches?runner_node=Macmini.modem&compare=feature&base=main"],
		]);
	});

	it("a preview is a GET too (a read-only grant can have it) and needs the machine and the branch", async () => {
		const { calls, run } = setup({ scopes: ["read"] });
		expect(JSON.parse((await run("coding_branches", { ...base, preview: "delete_remote" })).content[0].text).error).toMatch(/needs both/);
		expect(calls).toHaveLength(0);
		await run("coding_branches", { ...base, preview: "integrate", branch: "feature" });
		expect(calls).toEqual([{ method: "GET", body: null, url: "https://api.test/v1/instances/i1/coding/repos/r1/branches?runner_node=Macmini.modem&preview=integrate&branch=feature" }]);
	});
});

describe("coding_stashes", () => {
	it("lists and inspects with GETs; inspect carries the sha", async () => {
		const { calls, run } = setup({ scopes: ["read"] });
		await run("coding_stashes", { instance_id: "i1", repo_id: "r1" });
		await run("coding_stashes", { ...base, sha: TIP });
		expect(calls.map((c) => [c.method, c.url])).toEqual([
			["GET", "https://api.test/v1/instances/i1/coding/repos/r1/stashes"],
			["GET", `https://api.test/v1/instances/i1/coding/repos/r1/stashes?runner_node=Macmini.modem&sha=${TIP}`],
		]);
	});
});

describe.each([
	["coding_stash_drop", { sha: TIP }, "stashes/drop"],
	["coding_branch_integrate", { branch: "feature", expected_tip: TIP }, "branches/integrate"],
	["coding_branch_delete", { branch: "feature", expected_tip: TIP, scope: "remote" }, "branches/delete"],
])("%s", (tool, extra, route) => {
	const args = { ...base, ...extra };

	it("is refused without the destructive scope or the exact confirm, before any network call", async () => {
		const readOnly = setup({ scopes: ["read", "write", "runtime"] });
		expect((await readOnly.run(tool, { ...args, confirm: tool })).content[0].text).toMatch(/destructive/i);
		const s = setup();
		await s.run(tool, args);
		await s.run(tool, { ...args, confirm: "yes" });
		expect(readOnly.calls).toHaveLength(0);
		expect(s.calls).toHaveLength(0);
	});

	it("a dry run never touches the network", async () => {
		const s = setup();
		const out = JSON.parse((await s.run(tool, { ...args, dry_run: true })).content[0].text);
		expect(out.dryRun).toBe(true);
		expect(s.calls).toHaveLength(0);
	});

	it("with the confirm it POSTs the exact tip, never a dry run, and audits the result", async () => {
		const s = setup();
		await s.run(tool, { ...args, confirm: tool });
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0]).toMatchObject({ method: "POST", url: `https://api.test/v1/instances/i1/coding/repos/r1/${route}` });
		expect(JSON.parse(s.calls[0].body ?? "{}")).toMatchObject({ runner_node: "Macmini.modem", ...("sha" in extra ? { sha: TIP } : { expected_tip: TIP }), dry_run: false });
		expect(s.events().some((e) => e.tool === tool && e.action === "completed")).toBe(true);
	});

	it("passes a refusal through whole and audits it as failed, not completed", async () => {
		const s = setup({ status: 409, body: { ok: true, result: { ok: false, reason: "stale_tip" } } });
		const out = JSON.parse((await s.run(tool, { ...args, confirm: tool })).content[0].text);
		expect(out.result.reason).toBe("stale_tip");
		expect(s.events().some((e) => e.tool === tool && e.action === "failed")).toBe(true);
		expect(s.events().some((e) => e.tool === tool && e.action === "completed")).toBe(false);
	});
});

// #1709: the owner's two endings for a run.
describe("coding_branches preview discard_worktree", () => {
	it("is a read-scope GET for the session's worktree and needs the machine and the session", async () => {
		const { calls, run } = setup({ scopes: ["read"] });
		expect(JSON.parse((await run("coding_branches", { ...base, preview: "discard_worktree" })).content[0].text).error).toMatch(/needs both/);
		expect(calls).toHaveLength(0);
		await run("coding_branches", { ...base, preview: "discard_worktree", session_id: "csess_x" });
		expect(calls).toEqual([{ method: "GET", body: null, url: "https://api.test/v1/instances/i1/coding/repos/r1/worktrees/discard?runner_node=Macmini.modem&session_id=csess_x" }]);
	});
});

describe.each([
	["coding_worktree_discard", { ...base, session_id: "csess_x", expected_head: TIP }, "/v1/instances/i1/coding/repos/r1/worktrees/discard", { runner_node: "Macmini.modem", session_id: "csess_x", expected_head: TIP, dry_run: false }],
	["coding_run_abandon", { instance_id: "i1", run_id: "run-1" }, "/v1/instances/i1/coding/runs/run-1/abandon", {}],
])("%s", (tool, args, path, sent) => {
	it("is refused without the destructive scope or the exact confirm, before any network call", async () => {
		const readOnly = setup({ scopes: ["read", "write", "runtime"] });
		expect((await readOnly.run(tool, { ...args, confirm: tool })).content[0].text).toMatch(/destructive/i);
		const s = setup();
		await s.run(tool, args);
		await s.run(tool, { ...args, confirm: "yes" });
		expect(readOnly.calls).toHaveLength(0);
		expect(s.calls).toHaveLength(0);
	});

	it("a dry run never touches the network", async () => {
		const s = setup();
		expect(JSON.parse((await s.run(tool, { ...args, dry_run: true })).content[0].text).dryRun).toBe(true);
		expect(s.calls).toHaveLength(0);
	});

	it("with the confirm it POSTs the exact request and audits it", async () => {
		const s = setup();
		await s.run(tool, { ...args, confirm: tool });
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0]).toMatchObject({ method: "POST", url: `https://api.test${path}` });
		expect(JSON.parse(s.calls[0].body ?? "{}")).toEqual(sent);
		expect(s.events().some((e) => e.tool === tool && e.action === "completed")).toBe(true);
	});

	it("audits a refusal as failed, not completed", async () => {
		const s = setup({ status: 409, body: { ok: true, result: { ok: false, reason: "stale_head" } } });
		await s.run(tool, { ...args, confirm: tool });
		expect(s.events().some((e) => e.tool === tool && e.action === "failed")).toBe(true);
		expect(s.events().some((e) => e.tool === tool && e.action === "completed")).toBe(false);
	});
});
