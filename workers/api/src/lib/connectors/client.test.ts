import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types.js";
import type { Connector } from "./registry.js";

// Mock the collaborators so we can assert connectorClient's dispatch + enforcement in
// isolation from real GitHub/OAuth/DB. Each auth type routes to a distinct collaborator.
vi.mock("./registry.js", () => ({ getConnector: (id: string) => FIXTURES[id] }));
vi.mock("../github-app.js", () => ({ resolveGithubAccess: vi.fn() }));
vi.mock("../connector-oauth.js", () => ({ readConnectorRefreshToken: vi.fn() }));
vi.mock("../connector-grants.js", () => ({ requireConnectorGrant: vi.fn() }));

import { connectorClient } from "./client.js";
import { resolveGithubAccess } from "../github-app.js";
import { readConnectorRefreshToken } from "../connector-oauth.js";
import { requireConnectorGrant } from "../connector-grants.js";

const FIXTURES: Record<string, Connector> = {
	app_conn: { id: "app_conn", label: "App Conn", auth: "app", scopes: { read: true, write: true }, grantModel: "user", tools: [] },
	// The oauth config is DECLARED (#352 Stage 1) — `resolveOauthConfig` has no per-connector
	// branch any more, so a fixture that omits it now resolves to no credentials, which is the
	// correct answer for a connector that declares none.
	oauth_conn: {
		id: "google_drive",
		label: "Drive",
		auth: "oauth",
		scopes: { read: true, write: false },
		grantModel: "user",
		oauth: { authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", clientIdEnv: "GOOGLE_CLIENT_ID", secretEnv: "GOOGLE_CLIENT_SECRET" },
		tools: [],
	},
	env_token_conn: { id: "env_token_conn", label: "Env Token", auth: "token", scopes: { read: false, write: true }, grantModel: "user", tokenEnv: "META_ACCESS_TOKEN", tools: [] },
	user_token_conn: { id: "user_token_conn", label: "User Token", auth: "token", scopes: { read: true, write: false }, grantModel: "user", tools: [] },
	none_conn: { id: "none_conn", label: "None", auth: "none", scopes: { read: true, write: true }, grantModel: "user", tools: [] },
	readonly_conn: { id: "readonly_conn", label: "Read Only", auth: "app", scopes: { read: true, write: false }, grantModel: "user", tools: [] },
	granted_conn: { id: "granted_conn", label: "Granted", auth: "app", scopes: { read: true, write: true }, grantModel: "instance-resource", tools: [] },
};
// Point the oauth fixture at the real Drive endpoint key used by client.ts.
FIXTURES.google_drive = FIXTURES.oauth_conn;

const caller = { userId: "u1", instanceId: "i1" };

/** The minter's two answers (#321): a token, or a CLASSIFIED denial. */
const grants = (token: string) => vi.mocked(resolveGithubAccess).mockResolvedValue({ ok: true, token });
const denies = (state: "app-not-configured" | "owner-unknown" | "not-installed" | "not-authorized" | "transient", owner = "acme") =>
	vi.mocked(resolveGithubAccess).mockResolvedValue({
		ok: false,
		state,
		owner,
		retryable: state === "transient",
		message: `denied: ${state}`,
		remedy: null,
	});

afterEach(() => vi.clearAllMocks());

describe("connectorClient token dispatch", () => {
	it("app auth → resolveGithubAccess, scoped to the resource owner", async () => {
		grants("gh-token");
		const c = connectorClient({} as Env, "app_conn", caller);
		const t = await c.token({ resourceId: "acme/widgets" });
		expect(t).toBe("gh-token");
		// `diagnose` on: a tool's caller is a model talking to a human, and the whole point is
		// that the message names the actual condition rather than one guessed from a null.
		expect(resolveGithubAccess).toHaveBeenCalledWith({}, "u1", "acme", { diagnose: true });
	});

	it("app auth → relays the minter's OWN diagnosis, not a generic access refusal (#321)", async () => {
		// The old line was `No app_conn access for "acme"` for every one of five conditions —
		// including an owner that is not a GitHub account at all, which is not an access problem.
		denies("owner-unknown");
		const c = connectorClient({} as Env, "app_conn", caller);
		await expect(c.token({ resourceId: "acme/widgets" })).rejects.toThrow(/denied: owner-unknown/);
	});

	it("app auth → reserves HTTP 502 for the ONE retryable state", async () => {
		// The status is the contract github.ts branches on to decide whether to say "try again".
		// Getting it wrong is the whole bug: a permanent failure that advertises a retry loop.
		const statusOf = async (state: Parameters<typeof denies>[0]) => {
			denies(state);
			const c = connectorClient({} as Env, "app_conn", caller);
			return await c.token({ resourceId: "acme/widgets" }).then(
				() => 0,
				(e: { status?: number }) => e.status ?? 0,
			);
		};
		expect(await statusOf("transient")).toBe(502);
		expect(await statusOf("owner-unknown")).toBe(400);
		expect(await statusOf("app-not-configured")).toBe(503);
		expect(await statusOf("not-installed")).toBe(403);
		expect(await statusOf("not-authorized")).toBe(403);
	});

	it("oauth auth → reads the refresh token then mints an access token from the provider endpoint", async () => {
		vi.mocked(readConnectorRefreshToken).mockResolvedValue("refresh-xyz");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ access_token: "access-abc" }), { status: 200 }),
		);
		const env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" } as Env;
		const c = connectorClient(env, "google_drive", caller);
		const t = await c.token();
		expect(t).toBe("access-abc");
		expect(readConnectorRefreshToken).toHaveBeenCalledWith(env, "u1", "google_drive", "Drive");
		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toBe("https://oauth2.googleapis.com/token");
		expect(String((init as RequestInit).body)).toContain("refresh_token=refresh-xyz");
		fetchSpy.mockRestore();
	});

	it("token auth (platform env) → returns the env token", async () => {
		const env = { META_ACCESS_TOKEN: "  meta-tok  " } as Env;
		const c = connectorClient(env, "env_token_conn", caller);
		expect(await c.token()).toBe("meta-tok");
	});

	it("token auth (platform env) → throws a clear error when the env var is unset", async () => {
		const c = connectorClient({} as Env, "env_token_conn", caller);
		await expect(c.token()).rejects.toThrow(/not configured/);
	});

	it("token auth (no env) → falls back to the user's stored key", async () => {
		vi.mocked(readConnectorRefreshToken).mockResolvedValue("stored-key");
		const c = connectorClient({} as Env, "user_token_conn", caller);
		expect(await c.token()).toBe("stored-key");
		expect(readConnectorRefreshToken).toHaveBeenCalledWith({}, "u1", "user_token_conn", "User Token");
	});

	it("none auth → empty token, no collaborators called", async () => {
		const c = connectorClient({} as Env, "none_conn", caller);
		expect(await c.token()).toBe("");
		expect(resolveGithubAccess).not.toHaveBeenCalled();
		expect(readConnectorRefreshToken).not.toHaveBeenCalled();
	});

	it("unknown connector → throws", () => {
		expect(() => connectorClient({} as Env, "nope", caller)).toThrow(/Unknown connector/);
	});
});

describe("connectorClient scope enforcement", () => {
	it("read-only connector rejects a write-scoped token request", async () => {
		const c = connectorClient({} as Env, "readonly_conn", caller);
		await expect(c.token({ scope: "write", resourceId: "acme/x" })).rejects.toThrow(/read-only/);
		expect(resolveGithubAccess).not.toHaveBeenCalled();
	});

	it("read-only connector still serves a read-scoped request", async () => {
		grants("ro-token");
		const c = connectorClient({} as Env, "readonly_conn", caller);
		expect(await c.token({ scope: "read", resourceId: "acme/x" })).toBe("ro-token");
	});
});

describe("connectorClient grant enforcement (fail-closed)", () => {
	it("instance-resource connector mints a token only after requireConnectorGrant passes", async () => {
		vi.mocked(requireConnectorGrant).mockResolvedValue({} as never);
		grants("granted-token");
		const c = connectorClient({} as Env, "granted_conn", caller);
		const t = await c.token({ resourceId: "res-1" });
		expect(t).toBe("granted-token");
		expect(requireConnectorGrant).toHaveBeenCalledWith({}, "i1", "u1", "granted_conn", "res-1");
	});

	it("instance-resource connector → 403 when the grant is missing (fail-closed, no token minted)", async () => {
		vi.mocked(requireConnectorGrant).mockRejectedValue(Object.assign(new Error("Connector grant does not allow this agent to access that resource"), { status: 403 }));
		const c = connectorClient({} as Env, "granted_conn", caller);
		await expect(c.token({ resourceId: "res-x" })).rejects.toThrow(/grant does not allow/);
		expect(resolveGithubAccess).not.toHaveBeenCalled();
	});

	it("requireGrant() → 403 when there is no instance context (fail-closed)", async () => {
		const c = connectorClient({} as Env, "granted_conn", { userId: "u1" });
		await expect(c.requireGrant("res-1")).rejects.toThrow(/not granted|No instance/);
	});

	it("requireGrant() on a non-resource connector is a misuse → errors", async () => {
		const c = connectorClient({} as Env, "app_conn", caller);
		await expect(c.requireGrant("res-1")).rejects.toThrow(/not resource-granted/);
	});
});

describe("connectorClient.fetch", () => {
	it("attaches the minted token as a Bearer header", async () => {
		const env = { META_ACCESS_TOKEN: "meta-tok" } as Env;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
		const c = connectorClient(env, "env_token_conn", caller);
		await c.fetch("https://graph.example/messages", { method: "POST" });
		const [, init] = fetchSpy.mock.calls[0];
		expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer meta-tok");
		fetchSpy.mockRestore();
	});

	it("attaches no Authorization header for a none-auth connector", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
		const c = connectorClient({} as Env, "none_conn", caller);
		await c.fetch("https://relay.example/ping");
		const [, init] = fetchSpy.mock.calls[0];
		expect(new Headers((init as RequestInit).headers).has("Authorization")).toBe(false);
		fetchSpy.mockRestore();
	});
});
