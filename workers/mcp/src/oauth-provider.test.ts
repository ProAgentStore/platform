import type {
	AuthRequest,
	ClientInfo,
	CompleteAuthorizationOptions,
	OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { type LoginEnv, loginHandler } from "./oauth-provider.js";

function makeKv(seed: Record<string, string> = {}): KVNamespace {
	const data = new Map(Object.entries(seed));
	return {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string) => {
			data.set(key, value);
		},
		delete: async (key: string) => {
			data.delete(key);
		},
	} as unknown as KVNamespace;
}

const DEFAULT_AUTH_REQ: AuthRequest = {
	responseType: "code",
	clientId: "client-1",
	redirectUri: "http://127.0.0.1:9876/callback",
	scope: [],
	state: "",
	codeChallenge: "abc",
	codeChallengeMethod: "S256",
};

function makeOAuthHelpers(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
	return {
		parseAuthRequest: async () => DEFAULT_AUTH_REQ,
		lookupClient: async (clientId: string): Promise<ClientInfo> => ({
			clientId,
			redirectUris: [DEFAULT_AUTH_REQ.redirectUri],
			clientName: "Codex",
			tokenEndpointAuthMethod: "none",
		}),
		completeAuthorization: async (_opts: CompleteAuthorizationOptions) => ({
			redirectTo: "http://127.0.0.1:9876/callback?code=xyz",
		}),
		...overrides,
	} as unknown as OAuthHelpers;
}

function makeEnv(
	overrides: Partial<LoginEnv> = {},
	helpers?: Partial<OAuthHelpers>,
): LoginEnv {
	return {
		API_BASE: "https://api.proagentstore.online",
		AUTH_START: "https://api.proagentstore.online/v1/auth/github/start",
		SESSION_SIGNING_KEY: "test-key",
		OAUTH_KV: makeKv(),
		OAUTH_PROVIDER: makeOAuthHelpers(helpers),
		...overrides,
	} as LoginEnv;
}

const ctx = {} as ExecutionContext;

async function run(env: LoginEnv, url: string, init?: RequestInit): Promise<Response> {
	const res = await loginHandler.fetch?.(new Request(url, init), env, ctx);
	if (!res) throw new Error("Expected a Response from loginHandler");
	return res;
}

describe("loginHandler health + root", () => {
	it("serves a health probe", async () => {
		const res = await run(makeEnv(), "https://mcp.proagentstore.online/health");
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({
			ok: true,
			service: "proagentstore-mcp",
			tools: 41,
		});
	});

	it("serves the human-readable landing page for unknown paths", async () => {
		const res = await run(makeEnv(), "https://mcp.proagentstore.online/");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/plain");
		const body = await res.text();
		expect(body).toContain("ProAgentStore MCP Server");
		expect(body).toContain("npx mcp-remote");
	});
});

describe("loginHandler /authorize", () => {
	it("shows a consent page with GitHub and Google buttons", async () => {
		const kv = makeKv();
		const env = makeEnv({ OAUTH_KV: kv });

		const res = await run(
			env,
			"https://mcp.proagentstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256",
		);

		expect(res.status).toBe(200);
		// Browser-binding cookie ties this flow to the authenticating browser.
		const setCookie = res.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain("pags_authnonce=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		const html = await res.text();
		expect(html).toContain("Connect ProAgentStore MCP");
		expect(html).toContain("Codex wants to use ProAgentStore MCP tools");
		expect(html).toContain("/authorize/continue?nonce=");
		expect(html).toContain("provider=github");
		expect(html).toContain("provider=google");
	});

	it("stashes the parsed auth request under the consent nonce", async () => {
		const stored: Record<string, string> = {};
		const kv = {
			get: async (key: string) => stored[key] ?? null,
			put: async (key: string, value: string) => {
				stored[key] = value;
			},
			delete: async (key: string) => {
				delete stored[key];
			},
		} as unknown as KVNamespace;

		await run(
			makeEnv({ OAUTH_KV: kv }),
			"https://mcp.proagentstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256",
		);

		const keys = Object.keys(stored).filter((k) => k.startsWith("authreq:"));
		expect(keys).toHaveLength(1);
		expect(JSON.parse(stored[keys[0]])).toMatchObject({
			clientId: "client-1",
			redirectUri: "http://127.0.0.1:9876/callback",
			codeChallenge: "abc",
		});
	});

	it("returns 400 when the auth request is invalid", async () => {
		const env = makeEnv({}, {
			parseAuthRequest: async () => {
				throw new Error("Invalid client. The clientId provided does not match to this client.");
			},
		});

		const res = await run(
			env,
			"https://mcp.proagentstore.online/authorize?response_type=code&client_id=bogus",
		);

		expect(res.status).toBe(400);
		await expect(res.text()).resolves.toContain("Invalid client");
	});
});

describe("loginHandler /authorize/continue", () => {
	it("redirects to GitHub OAuth after the user continues", async () => {
		const kv = makeKv({
			"authreq:nonce-1": JSON.stringify(DEFAULT_AUTH_REQ),
		});

		const res = await run(
			makeEnv({ OAUTH_KV: kv }),
			"https://mcp.proagentstore.online/authorize/continue?nonce=nonce-1&provider=github",
		);

		expect(res.status).toBe(302);
		const location = res.headers.get("Location") ?? "";
		expect(location).toContain(
			"https://api.proagentstore.online/v1/auth/github/start",
		);
		expect(location).toContain("app_id=pags-mcp");
		expect(location).toContain("response_mode=query");
		expect(decodeURIComponent(location)).toContain(
			"return_to=https://mcp.proagentstore.online/oauth/callback?nonce=nonce-1",
		);
	});

	it("redirects to Google OAuth when provider=google", async () => {
		const kv = makeKv({
			"authreq:nonce-1": JSON.stringify(DEFAULT_AUTH_REQ),
		});

		const res = await run(
			makeEnv({ OAUTH_KV: kv }),
			"https://mcp.proagentstore.online/authorize/continue?nonce=nonce-1&provider=google",
		);

		expect(res.status).toBe(302);
		const location = res.headers.get("Location") ?? "";
		expect(location).toContain(
			"https://api.proagentstore.online/v1/auth/google/start",
		);
		expect(location).toContain("app_id=pags-mcp");
	});

	it("defaults to GitHub when no provider is given", async () => {
		const kv = makeKv({
			"authreq:nonce-1": JSON.stringify(DEFAULT_AUTH_REQ),
		});

		const res = await run(
			makeEnv({ OAUTH_KV: kv }),
			"https://mcp.proagentstore.online/authorize/continue?nonce=nonce-1",
		);

		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain(
			"https://api.proagentstore.online/v1/auth/github/start",
		);
	});

	it("rejects an unknown or expired nonce", async () => {
		const res = await run(
			makeEnv(),
			"https://mcp.proagentstore.online/authorize/continue?nonce=missing",
		);
		expect(res.status).toBe(400);
		await expect(res.text()).resolves.toContain("invalid or expired nonce");
	});
});

describe("loginHandler /oauth/callback", () => {
	it("validates the session, then completes the authorization grant", async () => {
		const kv = makeKv({
			"authreq:nonce-1": JSON.stringify({
				...DEFAULT_AUTH_REQ,
				scope: ["read", "runtime"],
			}),
		});
		const completeAuthorization = vi.fn(
			async (_opts: CompleteAuthorizationOptions) => ({
				redirectTo: "http://127.0.0.1:9876/callback?code=xyz&state=",
			}),
		);
		const env = makeEnv({ OAUTH_KV: kv }, { completeAuthorization });

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		const res = await run(
			env,
			"https://mcp.proagentstore.online/oauth/callback?nonce=nonce-1&session=pags-session",
			{ headers: { Cookie: "pags_authnonce=nonce-1" } },
		);

		fetchSpy.mockRestore();

		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(
			"http://127.0.0.1:9876/callback?code=xyz&state=",
		);
		expect(completeAuthorization).toHaveBeenCalledTimes(1);
		const opts = completeAuthorization.mock.calls[0][0];
		// Granted scope + wrapped grant props mirror the legacy token-wrapping shape.
		expect(opts.scope).toEqual(["read", "runtime"]);
		expect(opts.props).toMatchObject({
			authToken: "pags-session",
			mcpScopes: ["read", "runtime"],
		});
		// The consent nonce is single-use.
		await expect(kv.get("authreq:nonce-1")).resolves.toBeNull();
	});

	it("rejects a session that fails platform validation", async () => {
		const kv = makeKv({
			"authreq:nonce-1": JSON.stringify(DEFAULT_AUTH_REQ),
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("nope", { status: 401 }));

		const res = await run(
			makeEnv({ OAUTH_KV: kv }),
			"https://mcp.proagentstore.online/oauth/callback?nonce=nonce-1&session=bad-session",
			{ headers: { Cookie: "pags_authnonce=nonce-1" } },
		);

		fetchSpy.mockRestore();

		expect(res.status).toBe(400);
		await expect(res.text()).resolves.toContain("invalid session");
	});

	it("rejects a callback whose nonce is not bound to the browser cookie", async () => {
		const kv = makeKv({
			"authreq:nonce-1": JSON.stringify(DEFAULT_AUTH_REQ),
		});
		// Attacker's nonce in the URL, but the victim's browser has no matching cookie
		// (or a different one) — must be rejected before any session is honored.
		const res = await run(
			makeEnv({ OAUTH_KV: kv }),
			"https://mcp.proagentstore.online/oauth/callback?nonce=nonce-1&session=pags-session",
			{ headers: { Cookie: "pags_authnonce=someone-elses-nonce" } },
		);
		expect(res.status).toBe(400);
		await expect(res.text()).resolves.toContain("not bound to this browser");
	});

	it("rejects a callback that is missing the session", async () => {
		const kv = makeKv({
			"authreq:nonce-1": JSON.stringify(DEFAULT_AUTH_REQ),
		});
		const res = await run(
			makeEnv({ OAUTH_KV: kv }),
			"https://mcp.proagentstore.online/oauth/callback?nonce=nonce-1",
		);
		expect(res.status).toBe(400);
		await expect(res.text()).resolves.toContain("missing nonce or session");
	});
});
