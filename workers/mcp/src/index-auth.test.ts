import { describe, expect, it, vi } from "vitest";

// Capture the options the worker passes to `new OAuthProvider(...)` so we can
// assert the security-critical wiring (which paths require a token, the PKCE
// policy, scopes, and token lifetime) without needing the Workers runtime.
const captured = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
	OAuthProvider: class {
		constructor(options: Record<string, unknown>) {
			captured.options = options;
		}
	},
}));

vi.mock("agents/mcp", () => ({
	// biome-ignore lint/complexity/noStaticOnlyClass: The mock must match the agents/mcp class API.
	McpAgent: class {
		static serve() {
			return {
				fetch: () => new Response("mock mcp transport"),
			};
		}
	},
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	McpServer: class {
		tool() {
			/* test double */
		}
	},
}));

await import("./index.js");
const { loginHandler } = await import("./oauth-provider.js");

describe("OAuthProvider wiring", () => {
	it("protects only the /mcp API route with the MCP transport handler", () => {
		const options = captured.options;
		expect(options).toBeDefined();
		expect(options?.apiRoute).toBe("/mcp");
		// apiHandler is the MCP transport returned by PagsMcp.serve("/mcp").
		expect(typeof (options?.apiHandler as { fetch?: unknown })?.fetch).toBe(
			"function",
		);
	});

	it("delegates consent + login + landing to the login handler", () => {
		expect(captured.options?.defaultHandler).toBe(loginHandler);
	});

	it("configures the standard OAuth endpoints and DCR", () => {
		const options = captured.options;
		expect(options?.authorizeEndpoint).toBe("/authorize");
		expect(options?.tokenEndpoint).toBe("/token");
		expect(options?.clientRegistrationEndpoint).toBe("/register");
	});

	it("advertises the MCP safety scopes", () => {
		expect(captured.options?.scopesSupported).toEqual([
			"read",
			"write",
			"runtime",
			"destructive",
		]);
	});

	it("enforces OAuth 2.1 S256-only PKCE and the 24h access-token lifetime", () => {
		expect(captured.options?.allowPlainPKCE).toBe(false);
		expect(captured.options?.accessTokenTTL).toBe(86_400);
	});
});

/**
 * A per-call `token` argument is an IDENTITY, not an anonymiser (#702).
 *
 * `safety(provided)` used to set `subject: undefined` whenever a token was supplied, and
 * `audit()` no-ops without a subject — so a scripted caller wrote no audit row from any tool,
 * mutating or not, including the ones that run code on the owner's machine. The docs steered
 * scripted callers to exactly that path, so it was the documented way to automate against the
 * platform rather than an edge case.
 *
 * These drive the REAL `PagsMcp.safety()` through the real `audit()`, so reverting the
 * resolver — or dropping the `await` on it — fails here rather than in production.
 */
const { PagsMcp } = await import("./index.js");
const { audit } = await import("./safety.js");

const SIGNING_KEY = "index-auth-test-signing-key";

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a PAGS session token in the exact `data.sig` shape `verifyMcpSession` verifies. */
async function mintToken(uid: string, expOffsetSeconds = 3600): Promise<string> {
	const payload = {
		uid,
		roles: ["user"],
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
	};
	const data = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SIGNING_KEY),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
	return `${data}.${b64url(sig)}`;
}

function kvSpy() {
	const puts: Array<{ key: string; value: string }> = [];
	return {
		puts,
		kv: {
			put: async (key: string, value: string) => {
				puts.push({ key, value });
			},
			get: async () => null,
			list: async () => ({ keys: [], list_complete: true }),
		} as unknown as KVNamespace,
	};
}

/** A PagsMcp with no OAuth grant — the shape a purely scripted caller connects as. */
function scriptedAgent(kv: KVNamespace, signingKey: string | null = SIGNING_KEY) {
	const agent = new (PagsMcp as unknown as new () => Record<string, unknown>)();
	agent.env = { OAUTH_KV: kv, SESSION_SIGNING_KEY: signingKey ?? undefined };
	agent.subject = undefined;
	agent.scopes = null;
	agent.tokenSubjectCache = { current: null };
	return agent as unknown as { safety(provided?: string): Parameters<typeof audit>[0] };
}

describe("audit coverage for a per-call `token` argument", () => {
	it("writes an audit row keyed to the token's uid", async () => {
		const { kv, puts } = kvSpy();
		const agent = scriptedAgent(kv);
		const token = await mintToken("google:1107");

		await audit(agent.safety(token), { tool: "set_instance_instructions", action: "completed" });

		expect(puts).toHaveLength(1);
		expect(puts[0]?.key.startsWith("audit:google:1107:")).toBe(true);
		expect(JSON.parse(puts[0]?.value ?? "{}").subject).toBe("google:1107");
	});

	it("keeps a token caller on the default scope set — this is coverage, not authorization", async () => {
		// `scopes: null` → `DEFAULT_SCOPES` (read/write/runtime, never destructive). If this
		// ever became the OAuth grant's scopes, a token caller would silently gain or lose
		// permissions on an issue that was only ever about the audit trail.
		const { kv } = kvSpy();
		expect(scriptedAgent(kv).safety(await mintToken("google:1107")).scopes).toBeNull();
	});

	it("verifies the token once even though one call audits more than once", async () => {
		// `audit()` runs on the denial path AND on completion. Without memoisation the same
		// HMAC is verified on every one of them.
		const { kv, puts } = kvSpy();
		const agent = scriptedAgent(kv);
		const token = await mintToken("google:1107");
		const verify = vi.spyOn(crypto.subtle, "verify");

		const ctx = agent.safety(token);
		await audit(ctx, { tool: "a", action: "denied" });
		await audit(ctx, { tool: "a", action: "completed" });

		expect(puts).toHaveLength(2);
		expect(verify).toHaveBeenCalledTimes(1);
		verify.mockRestore();
	});

	it("writes nothing, and does not throw, for a token that is not a valid session", async () => {
		const { kv, puts } = kvSpy();
		const agent = scriptedAgent(kv);

		// Wrong signature, expired, and not a token at all — the three ways this arrives.
		const expired = await mintToken("google:1107", -60);
		for (const bad of ["deadbeef.notasignature", expired, "not-a-token"]) {
			await audit(agent.safety(bad), { tool: "x", action: "completed" });
		}

		expect(puts).toEqual([]);
	});

	it("writes nothing when the signing key is unset rather than trusting the token", async () => {
		// The MCP worker's key must match the API worker's. If it is missing, an unverified
		// token must not become an identity.
		const { kv, puts } = kvSpy();
		const agent = scriptedAgent(kv, null);

		await audit(agent.safety(await mintToken("google:1107")), { tool: "x", action: "completed" });

		expect(puts).toEqual([]);
	});
});
