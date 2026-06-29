import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { apiBase, type McpEnv } from "./http.js";
import { parseScopes } from "./safety.js";
import { verifyMcpSession } from "./session.js";

type AuthProvider = "github" | "google";

/**
 * Environment seen by the OAuth default handler. `OAUTH_PROVIDER` is injected by
 * `@cloudflare/workers-oauth-provider` before the default handler runs and exposes
 * the helper methods (parseAuthRequest / lookupClient / completeAuthorization).
 */
export type LoginEnv = McpEnv & { OAUTH_PROVIDER: OAuthHelpers };

/**
 * Default (non-API) request handler for the OAuth provider.
 *
 * The `@cloudflare/workers-oauth-provider` library owns dynamic client
 * registration (`/register`), the token endpoint (`/token`), PKCE verification,
 * token issuance/encryption, and the `.well-known/*` metadata. This handler only
 * implements the interactive consent + login-delegation surface:
 *
 *   GET /authorize           — consent page with GitHub / Google buttons
 *   GET /authorize/continue  — redirect to the platform login start endpoint
 *   GET /oauth/callback       — platform login callback → completeAuthorization
 *   GET /health               — health probe
 *   GET /                     — human-readable landing text
 */
export const loginHandler: ExportedHandler<LoginEnv> = {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const issuer = `${url.protocol}//${url.host}`;

		if (path === "/authorize" && request.method === "GET") {
			return authorize(request, env);
		}
		if (path === "/authorize/continue" && request.method === "GET") {
			return continueAuthorize(request, env, issuer);
		}
		if (path === "/oauth/callback" && request.method === "GET") {
			return oauthCallback(request, env, issuer);
		}
		if (path === "/health") {
			return new Response(
				JSON.stringify({ ok: true, service: "proagentstore-mcp", tools: 36 }),
				{
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "https://proagentstore.online",
					},
				},
			);
		}
		return new Response(ROOT_TEXT, {
			headers: { "Content-Type": "text/plain" },
		});
	},
};

const ROOT_TEXT =
	"ProAgentStore MCP Server\n\nConnect: npx mcp-remote https://mcp.proagentstore.online/mcp\n\nUse chat_with_agent for public trial previews. Use subscribe_agent, my_instances, add_instance_knowledge, and chat_with_instance for text private instances. Use register_instance_runtime, run_instance_task, approve_instance_task, cancel_instance_task, and instance_task_events for browser-capable private instances.\n\nSafety: OAuth scopes are read/write/runtime/destructive. Mutating tools support dry_run where useful. Destructive and repository overwrite tools require exact confirm values. Use mcp_audit_log to inspect recent MCP events.\n\nTools include: list_agents, my_agents, my_instances, subscribe_agent, chat_with_instance, register/manage instance runtimes, run/approve/cancel instance tasks, scaffold_agent, create_agent, update_agent, get/update agent board config, list/read/write agent files, add/list knowledge, analytics, deploy status, MCP audit log, platform guide, SDK reference.";

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(ch) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[ch] || ch,
	);
}

function startEndpointFor(authStart: string, provider: AuthProvider): string {
	const base = authStart.replace(/\/(?:github|google)\/start$/, "");
	if (base === authStart) return authStart;
	return `${base}/${provider}/start`;
}

/**
 * Render the consent page. The user picks an identity provider; the parsed
 * OAuth authorization request is stashed in KV under a one-time nonce so it can
 * be restored after the platform login round-trip.
 */
async function authorize(request: Request, env: LoginEnv): Promise<Response> {
	let authReq: AuthRequest;
	try {
		authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	} catch (err) {
		return new Response((err as Error).message || "invalid_request", {
			status: 400,
		});
	}

	// PKCE (S256) is mandatory. The library only runs PKCE verification when a
	// code_challenge is present, so a client sending code_challenge_method with no
	// challenge would skip PKCE and fall back to redirect_uri matching. Reject it —
	// the pre-migration server hard-required code_challenge.
	if (!authReq.codeChallenge) {
		return new Response("code_challenge required (PKCE S256)", { status: 400 });
	}

	const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);

	const nonce = crypto.randomUUID();
	await env.OAUTH_KV?.put(`authreq:${nonce}`, JSON.stringify(authReq), {
		expirationTtl: 600,
	});

	const continueWith = (provider: AuthProvider): string => {
		const continueUrl = new URL(
			"/authorize/continue",
			`${new URL(request.url).protocol}//${new URL(request.url).host}`,
		);
		continueUrl.searchParams.set("nonce", nonce);
		continueUrl.searchParams.set("provider", provider);
		return escapeHtml(continueUrl.toString());
	};
	const clientName = client?.clientName
		? escapeHtml(client.clientName)
		: "your MCP client";

	return new Response(
		`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect ProAgentStore MCP</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#111827}
    main{max-width:440px;padding:32px;border:1px solid #e5e7eb;border-radius:12px;background:white;box-shadow:0 12px 32px rgba(15,23,42,.08)}
    h1{font-size:22px;margin:0 0 12px}
    p{line-height:1.5;margin:0 0 20px;color:#374151}
    .actions{display:flex;flex-direction:column;gap:12px}
    a{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700;border:1px solid transparent}
    a.github{background:#111827;color:white}
    a.google{background:white;color:#111827;border-color:#d1d5db}
  </style>
</head>
<body>
  <main>
    <h1>Connect ProAgentStore MCP</h1>
    <p>${clientName} wants to use ProAgentStore MCP tools as your account.</p>
    <div class="actions">
      <a class="github" href="${continueWith("github")}" autofocus>Continue with GitHub</a>
      <a class="google" href="${continueWith("google")}">Continue with Google</a>
    </div>
  </main>
</body>
</html>`,
		{
			headers: {
				"Content-Type": "text/html; charset=utf-8",
			},
		},
	);
}

/** Redirect the user to the platform login start endpoint for the chosen provider. */
async function continueAuthorize(
	request: Request,
	env: LoginEnv,
	issuer: string,
): Promise<Response> {
	const url = new URL(request.url);
	const nonce = url.searchParams.get("nonce");
	if (!nonce) return new Response("missing nonce", { status: 400 });
	const reqRaw = await env.OAUTH_KV?.get(`authreq:${nonce}`);
	if (!reqRaw) return new Response("invalid or expired nonce", { status: 400 });

	const provider: AuthProvider =
		url.searchParams.get("provider") === "google" ? "google" : "github";
	const authStart =
		env.AUTH_START || "https://api.freeappstore.online/v1/auth/github/start";
	const authUrl = new URL(startEndpointFor(authStart, provider));
	authUrl.searchParams.set("response_mode", "query");
	authUrl.searchParams.set("app_id", "pags-mcp");
	const callbackUrl = new URL("/oauth/callback", issuer);
	callbackUrl.searchParams.set("nonce", nonce);
	authUrl.searchParams.set("return_to", callbackUrl.toString());
	return new Response(null, {
		status: 302,
		headers: { Location: authUrl.toString() },
	});
}

async function exchangeFasSession(
	apiBaseUrl: string,
	fasSession: string,
): Promise<string | null> {
	const res = await fetch(`${apiBaseUrl}/v1/auth/exchange`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ fas_session: fasSession }),
	});
	if (!res.ok) return null;
	const data = await res.json<{ token?: string }>();
	return data.token || null;
}

async function maybeExchangeFasSession(
	apiBaseUrl: string,
	fasSession: string | null,
): Promise<string | null> {
	if (!fasSession) return null;
	return exchangeFasSession(apiBaseUrl, fasSession);
}

async function validatePagsSession(
	apiBaseUrl: string,
	session: string,
): Promise<boolean> {
	const res = await fetch(`${apiBaseUrl}/v1/auth/me`, {
		headers: { Authorization: `Bearer ${session}` },
	});
	return res.ok;
}

/**
 * Platform login callback. Resolves the PAGS session (directly or by exchanging a
 * FAS session), validates it, then hands control back to the OAuth library which
 * mints the authorization code and redirects to the client's redirect_uri.
 *
 * The stored grant `props` mirror what the legacy implementation put in KV, so
 * the MCP transport (PagsMcp) keeps reading `authToken` / `mcpScopes` /
 * `mcpSubject` from `this.props` unchanged.
 */
async function oauthCallback(
	request: Request,
	env: LoginEnv,
	_issuer: string,
): Promise<Response> {
	const url = new URL(request.url);
	const nonce = url.searchParams.get("nonce");
	const apiBaseUrl = apiBase(env);
	const session =
		url.searchParams.get("session") ||
		(await maybeExchangeFasSession(apiBaseUrl, url.searchParams.get("fas_session")));

	if (!nonce || !session) {
		return new Response("missing nonce or session", { status: 400 });
	}

	const reqRaw = await env.OAUTH_KV?.get(`authreq:${nonce}`);
	if (!reqRaw) return new Response("invalid or expired nonce", { status: 400 });
	await env.OAUTH_KV?.delete(`authreq:${nonce}`);

	if (!(await validatePagsSession(apiBaseUrl, session))) {
		return new Response("invalid session", { status: 400 });
	}

	const authReq = JSON.parse(reqRaw) as AuthRequest;
	const scopes = parseScopes(authReq.scope);
	const subject = env.SESSION_SIGNING_KEY
		? (await verifyMcpSession(session, env.SESSION_SIGNING_KEY))?.uid
		: undefined;

	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: authReq,
		userId: subject || session,
		scope: scopes,
		metadata: { via: "pags-mcp" },
		props: {
			authToken: session,
			mcpScopes: scopes,
			mcpSubject: subject,
		},
	});

	return new Response(null, {
		status: 302,
		headers: { Location: redirectTo },
	});
}
