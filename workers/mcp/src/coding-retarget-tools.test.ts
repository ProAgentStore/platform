/**
 * `retarget_repository_binding` (#1012), driven for real against a stubbed `fetch`.
 *
 * Invariants protected: the tool sends exactly one POST to the retarget route with the caller's
 * explicit expected-current and destination (snake_case → the API's camelCase, nothing derived or
 * defaulted), it enforces the `write` scope before any request, and it returns the API's refusal
 * verbatim instead of reporting success.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";

const env: McpEnv = { API_BASE: "https://api.test" };
type ToolResult = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function setup(opts: { scopes?: string[]; status?: number; reply?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify(opts.reply ?? { dryRun: true, ready: true, blockers: [] }), { status: opts.status ?? 200, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, Handler>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as coding-repo-remove.test.ts
		{ tool: (n: string, _d: string, _s: unknown, handler: Handler) => tools.set(n, handler) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: (opts.scopes ?? ["read", "write"]) as SafetyContext["scopes"] }),
	);
	const handler = tools.get("retarget_repository_binding");
	expect(handler, "retarget_repository_binding is not registered by registerCodingSessionTools").toBeDefined();
	return { calls, handler: handler as Handler };
}

const ARGS = {
	instance_id: "i1",
	repo_id: "repo_1",
	expected_current: { owner: "acme", name: "platform", github_id: 100, version: 1 },
	destination: { owner: "acme", name: "platform-archive", github_id: 100 },
};

afterEach(() => vi.unstubAllGlobals());

describe("retarget_repository_binding (#1012)", () => {
	it("posts the explicit identities to the retarget route", async () => {
		const { calls, handler } = setup();
		const out = await handler({ ...ARGS, dry_run: true });
		expect(calls).toEqual([
			{
				url: "https://api.test/v1/instances/i1/coding/repos/repo_1/retarget",
				method: "POST",
				body: {
					expectedCurrent: { owner: "acme", name: "platform", githubId: 100, version: 1 },
					destination: { owner: "acme", name: "platform-archive", githubId: 100 },
					dryRun: true,
				},
			},
		]);
		expect(JSON.parse(out.content[0].text)).toMatchObject({ dryRun: true, ready: true });
	});

	it("is refused without the write scope, before any request", async () => {
		const { calls, handler } = setup({ scopes: ["read"] });
		const out = await handler(ARGS);
		expect(calls).toEqual([]);
		expect(out.content[0].text).toMatch(/write/);
	});

	it("returns the API's refusal rather than a success", async () => {
		const { handler } = setup({ status: 409, reply: { error: "The binding cannot be retargeted yet.", blockers: ["queued_work"] } });
		const text = (await handler(ARGS)).content[0].text;
		expect(text).toMatch(/cannot be retargeted/);
		expect(text).toMatch(/queued_work/);
	});
});
