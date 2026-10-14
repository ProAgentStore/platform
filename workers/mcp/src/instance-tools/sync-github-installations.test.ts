/**
 * #1081 — `sync_github_installations`, the MCP half of the console's "Sync installations". The handler
 * is a thin proxy, so these pin what it SENDS: the owner it was asked about, `check_only` as the
 * server's dry run, nothing on its own dry run, and nothing at all without the write scope.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerConnectorGrantTools } from "./connectors.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function tools(scopes: SafetyContext["scopes"] = ["read", "write", "runtime"]) {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(JSON.stringify({ orgs: [], bound: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const handlers = new Map<string, Handler>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	registerConnectorGrantTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never, {
		env,
		tokenFor: (p?: string) => p || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes }),
	} as never);
	return { seen, call: (args: Record<string, unknown>) => (handlers.get("sync_github_installations") as Handler)(args).then((r) => r.content[0].text) };
}

afterEach(() => vi.unstubAllGlobals());

const SYNC = "https://api.test/v1/github/installations/sync";

describe("sync_github_installations (#1081)", () => {
	it("posts the owner it was asked about to the console's own route", async () => {
		const { seen, call } = tools();
		await call({ owner: "chessclubs-online" });
		expect(seen).toEqual([{ url: SYNC, method: "POST", body: { owner: "chessclubs-online" } }]);
	});

	it("check_only is the SERVER's dry run — it reads GitHub and binds nothing", async () => {
		const { seen, call } = tools();
		await call({ owner: "chessclubs-online", check_only: true });
		expect(seen).toEqual([{ url: SYNC, method: "POST", body: { owner: "chessclubs-online", dry_run: true } }]);
	});

	it("with no owner it syncs every installation", async () => {
		const { seen, call } = tools();
		await call({});
		expect(seen[0]).toMatchObject({ url: SYNC, method: "POST", body: {} });
	});

	it("its own dry run describes and sends nothing", async () => {
		const { seen, call } = tools();
		expect(await call({ owner: "acme", dry_run: true })).toMatch(/dryRun/);
		expect(seen).toEqual([]);
	});

	it("needs the write scope — a read-only connection is refused before any call", async () => {
		const { seen, call } = tools(["read"]);
		expect(await call({ owner: "acme" })).toMatch(/write/);
		expect(seen).toEqual([]);
	});
});
