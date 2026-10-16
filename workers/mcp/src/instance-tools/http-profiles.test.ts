/**
 * #1123 from the WIRE: the real `PagsMcp.init()` and a real `Client`. The secret passes through
 * `create_http_profile` and `rotate_http_profile_secret` to the API, and nowhere else — not into the
 * per-call audit ledger (#1089), the handler's own audit, a dry-run preview, or a reply. Only the
 * API's network edge is simulated; the body it receives is asserted so the test cannot pass by
 * dropping the secret altogether.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));

const { PagsMcp } = await import("../index.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const SECRET = "sk_live_WIRE_never_leaks_0123456789";
const ROTATED = "sk_live_WIRE_rotated_never_leaks_42";
const PROFILE = { id: "hcp_1", name: "discord-bot", strategy: "unspecified", allowedOrigins: ["https://discord.com"], secret: { set: true, version: 1, rotatedAt: null }, bindings: [] };

let store: Map<string, string>;
let apiBodies: string[];

beforeEach(() => {
	store = new Map();
	apiBodies = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		if (typeof init?.body === "string") apiBodies.push(init.body);
		const body = url.pathname === "/v1/instances/my/instances" ? { instances: [] } : { profile: PROFILE };
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
});

async function connect() {
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async ({ prefix = "" }: { prefix?: string } = {}) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore" };
	inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
	await inst.init();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "http-profiles-wire", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);
	return async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
}

describe("HTTP credential profile tools never echo or record the secret (#1123)", () => {
	it("create, rotate and their dry runs: the API gets the secret; the audit ledger, previews and replies never do", async () => {
		const call = await connect();
		const replies = [
			await call("create_http_profile", { name: "discord-bot", secret: SECRET, allowed_origins: ["https://discord.com"], dry_run: true }),
			await call("create_http_profile", { name: "discord-bot", secret: SECRET, allowed_origins: ["https://discord.com"] }),
			await call("rotate_http_profile_secret", { profile_id: "hcp_1", secret: ROTATED, dry_run: true }),
			await call("rotate_http_profile_secret", { profile_id: "hcp_1", secret: ROTATED }),
			await call("mcp_audit_log", {}),
		];
		// The secret did reach the API — once per real call, never on a dry run.
		expect(apiBodies.filter((b) => b.includes(SECRET))).toHaveLength(1);
		expect(apiBodies.filter((b) => b.includes(ROTATED))).toHaveLength(1);
		const ledger = [...store.values()].join("\n");
		expect(ledger).toMatch(/create_http_profile/); // the audit ran — this is not an empty-set pass
		for (const s of [ledger, ...replies]) {
			expect(s).not.toContain("never_leaks");
		}
	});
});
