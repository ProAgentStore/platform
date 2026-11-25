/**
 * #1710 — the repo's checkout/publishing preset is READABLE through coding_repos_list and writable
 * through NO tool: it is the owner's console decision (#1670), so an agent cannot move a repo between
 * pushing to main and opening pull requests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";

const env: McpEnv = { API_BASE: "https://api.test" };
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function setup() {
	vi.stubGlobal("fetch", async () =>
		new Response(JSON.stringify({ repos: [{ id: "r1", instanceId: "i1", name: "a/b", effectiveStrategy: "isolated-pr" }] }), { status: 200, headers: { "content-type": "application/json" } }),
	);
	const tools = new Map<string, { description: string; schema: Record<string, unknown>; handler: Handler }>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (n: string, d: string, schema: Record<string, unknown>, handler: Handler) => tools.set(n, { description: d, schema, handler }) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: ["read", "write", "runtime", "destructive"] }),
	);
	return tools;
}

afterEach(() => vi.unstubAllGlobals());

describe("repo checkout preset on the MCP surface", () => {
	it("coding_repos_list passes the effective preset through", async () => {
		const out = await setup().get("coding_repos_list")?.handler({ instance_id: "i1" });
		expect(JSON.parse(out?.content[0].text ?? "{}").repos[0].effectiveStrategy).toBe("isolated-pr");
	});

	it("documents it as read-only", () => {
		expect(setup().get("coding_repos_list")?.description).toMatch(/effectiveStrategy[^.]*READ-ONLY/);
	});

	it("no coding tool accepts a strategy argument", () => {
		for (const [name, t] of setup()) expect(Object.keys(t.schema), name).not.toContain("strategy");
	});
});
