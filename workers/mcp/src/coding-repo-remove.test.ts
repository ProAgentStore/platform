/**
 * `coding_repo_remove` — the counterpart `coding_repo_add` never had (#692, comment 1).
 *
 * ── What the gap was
 *
 * The MCP surface could ATTACH a repo to a coding instance and had no way to detach one, so a
 * binding created by automation could only be removed by a human in the console. The issue names
 * three live examples that were stuck: a GitHub binding to an org the owner does not own, and two
 * local bindings whose absolute workdirs no longer exist on disk.
 *
 * ── What is asserted here, and why each arm exists
 *
 * The handler is driven for real against a stubbed `fetch`, so what is measured is the request that
 * would go on the wire and the text a caller would get back — not a mock of our own shape. Three
 * properties carry the risk:
 *
 *   the CONFIRM gate      a destructive call must not fire without it, and the gate must sit AFTER
 *                         name resolution so the caller is confirming a repo that exists
 *   name AMBIGUITY        two repos can share a name; deleting the wrong one is not recoverable, so
 *                         an ambiguous name is refused rather than resolved to the first match
 *   the ORPHANED-ENGINE   the API returns a `warning` when a runner did not confirm its engine
 *   warning               stopped. Swallowing it would recreate, one layer up, exactly the
 *                         unreachable-process problem the endpoint's own comment exists to prevent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";

const env: McpEnv = { API_BASE: "https://api.test" };

type ToolResult = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Call {
	url: string;
	method: string;
	body: string | null;
}

/** Registers the real tools and returns the one under test, plus the wire log. */
function setup(opts: { repos?: unknown[]; deleteBody?: unknown; deleteStatus?: number; listStatus?: number } = {}) {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method || "GET").toUpperCase();
		calls.push({ url, method, body: (init?.body as string | undefined) ?? null });
		if (method === "DELETE") {
			return new Response(JSON.stringify(opts.deleteBody ?? { ok: true }), {
				status: opts.deleteStatus ?? 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ repos: opts.repos ?? [] }), {
			status: opts.listStatus ?? 200,
			headers: { "content-type": "application/json" },
		});
	});

	const tools = new Map<string, { description: string; schema: Record<string, unknown>; handler: Handler }>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as tool-routing.test.ts
		{ tool: (n: string, d: string, schema: Record<string, unknown>, handler: Handler) => tools.set(n, { description: d, schema, handler }) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: ["read", "write", "runtime", "destructive"] }),
	);
	// G1: assert the harness before reading anything out of it. A registrar that registered nothing
	// would make every arm below pass against `undefined`.
	const tool = tools.get("coding_repo_remove");
	expect(tool, "coding_repo_remove is not registered by registerCodingSessionTools").toBeDefined();
	return { calls, tool: tool as NonNullable<typeof tool>, tools };
}

const textOf = (r: ToolResult) => r.content[0].text;
const repo = (over: Record<string, unknown> = {}) => ({ id: "repo_1", instanceId: "i1", name: "platform", ...over });

afterEach(() => vi.unstubAllGlobals());

describe("the confirm gate", () => {
	it("does NOT delete without the confirm string", async () => {
		const { calls, tool } = setup();
		const out = await tool.handler({ instance_id: "i1", repo_id: "repo_1" });
		expect(textOf(out)).toContain('requires confirm="coding_repo_remove"');
		expect(calls.some((c) => c.method === "DELETE"), "an unconfirmed call must reach no DELETE").toBe(false);
	});

	it("deletes when confirmed, against the endpoint the console has always used", async () => {
		const { calls, tool } = setup();
		const out = await tool.handler({ instance_id: "i1", repo_id: "repo_1", confirm: "coding_repo_remove" });
		const del = calls.find((c) => c.method === "DELETE");
		expect(del?.url).toBe("https://api.test/v1/instances/i1/coding/repos/repo_1");
		expect(JSON.parse(textOf(out))).toMatchObject({ ok: true, repoId: "repo_1" });
	});

	it("declares the confirm value in its own schema, so a caller can find it", async () => {
		// The gate is only usable if the string is discoverable from `tools/list`.
		const { tool } = setup();
		expect(JSON.stringify(tool.schema)).toContain("coding_repo_remove");
	});
});

describe("resolving a repo by name", () => {
	it("resolves a unique name to its id and deletes that", async () => {
		const { calls, tool } = setup({ repos: [repo({ id: "repo_a", name: "platform" }), repo({ id: "repo_b", name: "website" })] });
		await tool.handler({ instance_id: "i1", repo_name: "platform", confirm: "coding_repo_remove" });
		expect(calls.find((c) => c.method === "DELETE")?.url).toContain("/coding/repos/repo_a");
	});

	it("matches case-insensitively and ignores surrounding space", async () => {
		const { calls, tool } = setup({ repos: [repo({ id: "repo_a", name: "Platform" })] });
		await tool.handler({ instance_id: "i1", repo_name: "  platform ", confirm: "coding_repo_remove" });
		expect(calls.find((c) => c.method === "DELETE")?.url).toContain("/coding/repos/repo_a");
	});

	it("REFUSES an ambiguous name instead of picking one", async () => {
		// Two bindings can carry one name — the issue's own instance holds three stale local repos.
		// Deleting the wrong one is not recoverable, so this must never guess.
		const { calls, tool } = setup({ repos: [repo({ id: "repo_a", name: "platform" }), repo({ id: "repo_b", name: "platform" })] });
		const out = await tool.handler({ instance_id: "i1", repo_name: "platform", confirm: "coding_repo_remove" });
		expect(textOf(out)).toContain("matches 2 repos");
		// The ids are named, so the caller can act on the answer rather than go back to the listing.
		expect(textOf(out)).toContain("repo_a");
		expect(textOf(out)).toContain("repo_b");
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("says so when no repo carries that name", async () => {
		const { calls, tool } = setup({ repos: [repo({ name: "website" })] });
		const out = await tool.handler({ instance_id: "i1", repo_name: "platform", confirm: "coding_repo_remove" });
		expect(textOf(out)).toContain('no repo named "platform"');
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("resolves through filterReposByInstance, so a mis-routed listing cannot select a foreign repo", async () => {
		// #692's OTHER half, load-bearing here: under concurrent mis-routing the listing can carry
		// another instance's repos. Resolving a name against them would delete a binding on an
		// instance the caller never named — the same fault as fault 1, with a destructive verb.
		const { calls, tool } = setup({ repos: [repo({ id: "repo_other", instanceId: "i-OTHER", name: "platform" })] });
		const out = await tool.handler({ instance_id: "i1", repo_name: "platform", confirm: "coding_repo_remove" });
		expect(textOf(out)).toContain('no repo named "platform"');
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("needs one of repo_id or repo_name, and says which", async () => {
		const { calls, tool } = setup();
		const out = await tool.handler({ instance_id: "i1", confirm: "coding_repo_remove" });
		expect(textOf(out)).toContain("needs repo_id or repo_name");
		expect(textOf(out)).toContain("coding_repos_list");
		expect(calls).toHaveLength(0);
	});
});

describe("the orphaned-engine warning", () => {
	it("passes the API's warning through verbatim", async () => {
		// The endpoint removes the binding even when a runner does not confirm its engine stopped —
		// a flaky runner must not trap an owner with a repo they cannot remove — and reports how many
		// may still be running. That sentence is the half the caller has to act on.
		const warning = "The repo was removed, but 2 engine process(es) did not confirm they stopped and may still be running on your machine.";
		const { tool } = setup({ deleteBody: { ok: true, enginesStopped: false, warning } });
		const out = await tool.handler({ instance_id: "i1", repo_id: "repo_1", confirm: "coding_repo_remove" });
		expect(JSON.parse(textOf(out)).warning).toBe(warning);
	});
});

describe("errors are reported as errors", () => {
	it("does not report a 404 as a completed removal", async () => {
		// `authedCall` RETURNS a non-2xx as `{error}` rather than throwing — the trap #788 names on
		// `coding_loop_start`, and the one #692's fault 1 hit when 404s collapsed to `{repos:[]}`.
		const { tool } = setup({ deleteStatus: 404, deleteBody: { error: "Repo not found" } });
		const out = await tool.handler({ instance_id: "i1", repo_id: "nope", confirm: "coding_repo_remove" });
		expect(JSON.parse(textOf(out)).error).toBe("Repo not found");
		expect(JSON.parse(textOf(out)).ok).toBeUndefined();
	});

	it("surfaces a listing error rather than reporting the name as missing", async () => {
		// "no repo named X" and "we could not read your repos" send a caller to different places.
		const { tool } = setup({ listStatus: 403, repos: undefined });
		const out = await tool.handler({ instance_id: "i1", repo_name: "platform", confirm: "coding_repo_remove" });
		expect(textOf(out)).not.toContain("no repo named");
	});
});

describe("dry_run", () => {
	it("resolves the name and reports the target without deleting", async () => {
		const { calls, tool } = setup({ repos: [repo({ id: "repo_a", name: "platform" })] });
		const out = await tool.handler({ instance_id: "i1", repo_name: "platform", dry_run: true });
		const body = JSON.parse(textOf(out));
		expect(body.dryRun).toBe(true);
		expect(body.wouldDo.repoId).toBe("repo_a");
		expect(body.wouldDo.method).toBe("DELETE");
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("needs no confirm — a preview that demanded one could not preview anything", async () => {
		const { tool } = setup({ repos: [repo({ id: "repo_a", name: "platform" })] });
		const out = await tool.handler({ instance_id: "i1", repo_name: "platform", dry_run: true });
		expect(textOf(out)).not.toContain("requires confirm");
	});

	it("states that the repository itself is untouched", async () => {
		// The single most likely misreading of a tool called "remove". A caller must be able to see,
		// before acting, that this detaches a binding and deletes no code.
		const { tool } = setup();
		const out = await tool.handler({ instance_id: "i1", repo_id: "repo_1", dry_run: true });
		expect(JSON.parse(textOf(out)).wouldDo.effect).toMatch(/repository itself.*untouched/i);
	});
});

describe("the description tells a caller what it will and will not do", () => {
	it("names the counterpart, the engine stop, and what it does NOT delete", async () => {
		const { tool } = setup();
		expect(tool.description).toContain("coding_repo_add");
		expect(tool.description).toMatch(/does NOT delete the repository itself/i);
		expect(tool.description).toContain("warning");
		// The confusion the issue calls out by name: `remove_repo` is repo-chat vector ingestion, a
		// different object with a different lifecycle.
		expect(tool.description).toContain("remove_repo");
	});
});
