import { MCP_SCOPES, parseScopes } from "./safety.js";

type AuthProvider = "github" | "google";

export interface OAuthConfig {
	issuer: string;
	authStart: string;
	apiBase: string;
	kv: KVNamespace;
	sessionSigningKey: string;
}

export interface ResolvedOAuthToken {
	session: string;
	scopes: string[];
}

export function createAuthChallenge(
	config: Pick<OAuthConfig, "issuer">,
	error?: "invalid_token",
): Response {
	const metadata = new URL("/.well-known/oauth-protected-resource/mcp", config.issuer);
	const params = [`resource_metadata="${metadata.toString()}"`];
	if (error) params.push(`error="${error}"`);
	return new Response("Authentication required", {
		status: 401,
		headers: {
			"WWW-Authenticate": `Bearer ${params.join(", ")}`,
			"Access-Control-Allow-Origin": "*",
		},
	});
}

export async function handleOAuthRoute(
	request: Request,
	config: OAuthConfig,
): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (request.method === "OPTIONS" && (
		path.startsWith("/.well-known/") ||
		path === "/register" ||
		path === "/authorize" ||
		path === "/authorize/continue" ||
		path === "/oauth/callback" ||
		path === "/token"
	)) {
		return new Response(null, {
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
			},
		});
	}

	if (
		path === "/.well-known/oauth-protected-resource" ||
		path === "/.well-known/oauth-protected-resource/mcp"
	) {
		return json({
			resource: `${config.issuer}/mcp`,
			authorization_servers: [config.issuer],
		});
	}
	if (path === "/.well-known/oauth-authorization-server") {
		return json({
			issuer: config.issuer,
			authorization_endpoint: `${config.issuer}/authorize`,
			token_endpoint: `${config.issuer}/token`,
			registration_endpoint: `${config.issuer}/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code"],
			code_challenge_methods_supported: ["S256"],
			scopes_supported: MCP_SCOPES,
			token_endpoint_auth_methods_supported: ["none"],
		});
	}
	if (path === "/register" && request.method === "POST") return register(request, config);
	if (path === "/authorize" && request.method === "GET") return authorize(request, config);
	if (path === "/authorize/continue" && request.method === "GET") {
		return continueAuthorize(request, config);
	}
	if (path === "/oauth/callback" && request.method === "GET") return oauthCallback(request, config);
	if (path === "/token" && request.method === "POST") return tokenExchange(request, config);

	return null;
}

export async function resolveOAuthToken(
	bearer: string,
	kv: KVNamespace,
): Promise<ResolvedOAuthToken | null> {
	const raw = await kv.get(`token:${bearer}`);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { session?: string; scopes?: string[] };
		if (parsed.session) {
			return { session: parsed.session, scopes: parseScopes(parsed.scopes) };
		}
	} catch {
		return { session: raw, scopes: parseScopes(null) };
	}
	return null;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[ch] || ch);
}

function startEndpointFor(config: OAuthConfig, provider: AuthProvider): string {
	const base = config.authStart.replace(/\/(?:github|google)\/start$/, "");
	if (base === config.authStart) return config.authStart;
	return `${base}/${provider}/start`;
}

async function register(request: Request, config: OAuthConfig): Promise<Response> {
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const hour = Math.floor(Date.now() / 3_600_000);
	const rlKey = `rl:reg:${ip}:${hour}`;
	const count = parseInt((await config.kv.get(rlKey)) ?? "0", 10);
	if (count >= 20) return json({ error: "rate_limit_exceeded" }, 429);
	await config.kv.put(rlKey, String(count + 1), { expirationTtl: 3600 });

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: "invalid_request" }, 400);
	}

	const redirectUris = body.redirect_uris;
	if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
		return json({ error: "invalid_redirect_uri" }, 400);
	}

	const clientId = crypto.randomUUID();
	const client = {
		client_id: clientId,
		redirect_uris: redirectUris,
		client_name: body.client_name ?? null,
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	await config.kv.put(`client:${clientId}`, JSON.stringify(client), {
		expirationTtl: 90 * 86_400,
	});
	return json(client, 201);
}

async function authorize(request: Request, config: OAuthConfig): Promise<Response> {
	const url = new URL(request.url);
	const responseType = url.searchParams.get("response_type");
	const clientId = url.searchParams.get("client_id");
	const redirectUri = url.searchParams.get("redirect_uri");
	const codeChallenge = url.searchParams.get("code_challenge");
	const codeChallengeMethod = url.searchParams.get("code_challenge_method");
	const state = url.searchParams.get("state");
	const scopes = parseScopes(url.searchParams.get("scope"));

	if (responseType !== "code") return new Response("unsupported_response_type", { status: 400 });
	if (!clientId || !redirectUri || !codeChallenge) {
		return new Response("missing client_id, redirect_uri, or code_challenge", { status: 400 });
	}
	if (codeChallengeMethod && codeChallengeMethod !== "S256") {
		return new Response("only S256 is supported", { status: 400 });
	}

	const clientRaw = await config.kv.get(`client:${clientId}`);
	if (!clientRaw) return new Response("invalid client_id", { status: 400 });
	const client = JSON.parse(clientRaw) as { redirect_uris: string[]; client_name?: string | null };
	if (!client.redirect_uris.includes(redirectUri)) {
		return new Response("redirect_uri not registered", { status: 400 });
	}

	const nonce = crypto.randomUUID();
	await config.kv.put(
		`authreq:${nonce}`,
		JSON.stringify({ clientId, redirectUri, codeChallenge, state, scopes }),
		{ expirationTtl: 600 },
	);

	const continueWith = (provider: AuthProvider): string => {
		const continueUrl = new URL("/authorize/continue", config.issuer);
		continueUrl.searchParams.set("nonce", nonce);
		continueUrl.searchParams.set("provider", provider);
		return escapeHtml(continueUrl.toString());
	};
	const clientName = client.client_name ? escapeHtml(client.client_name) : "your MCP client";
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

async function continueAuthorize(request: Request, config: OAuthConfig): Promise<Response> {
	const url = new URL(request.url);
	const nonce = url.searchParams.get("nonce");
	if (!nonce) return new Response("missing nonce", { status: 400 });
	const reqRaw = await config.kv.get(`authreq:${nonce}`);
	if (!reqRaw) return new Response("invalid or expired nonce", { status: 400 });

	const provider: AuthProvider = url.searchParams.get("provider") === "google" ? "google" : "github";
	const authUrl = new URL(startEndpointFor(config, provider));
	authUrl.searchParams.set("response_mode", "query");
	authUrl.searchParams.set("app_id", "pags-mcp");
	const callbackUrl = new URL("/oauth/callback", config.issuer);
	callbackUrl.searchParams.set("nonce", nonce);
	authUrl.searchParams.set("return_to", callbackUrl.toString());
	return new Response(null, {
		status: 302,
		headers: { Location: authUrl.toString() },
	});
}

async function exchangeFasSession(
	config: OAuthConfig,
	fasSession: string,
): Promise<string | null> {
	const res = await fetch(`${config.apiBase}/v1/auth/exchange`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ fas_session: fasSession }),
	});
	if (!res.ok) return null;
	const data = await res.json<{ token?: string }>();
	return data.token || null;
}

async function validatePagsSession(
	config: Pick<OAuthConfig, "apiBase">,
	session: string,
): Promise<boolean> {
	const res = await fetch(`${config.apiBase}/v1/auth/me`, {
		headers: { Authorization: `Bearer ${session}` },
	});
	return res.ok;
}

async function oauthCallback(request: Request, config: OAuthConfig): Promise<Response> {
	const url = new URL(request.url);
	const nonce = url.searchParams.get("nonce");
	const session =
		url.searchParams.get("session") ||
		(await maybeExchangeFasSession(config, url.searchParams.get("fas_session")));

	if (!nonce || !session) return new Response("missing nonce or session", { status: 400 });

	const reqRaw = await config.kv.get(`authreq:${nonce}`);
	if (!reqRaw) return new Response("invalid or expired nonce", { status: 400 });
	await config.kv.delete(`authreq:${nonce}`);

	if (!(await validatePagsSession(config, session))) {
		return new Response("invalid session", { status: 400 });
	}

	const authReq = JSON.parse(reqRaw) as {
		clientId: string;
		redirectUri: string;
		codeChallenge: string;
		state: string | null;
		scopes?: string[];
	};

	const code = crypto.randomUUID();
	await config.kv.put(
		`code:${code}`,
		JSON.stringify({
			session,
			codeChallenge: authReq.codeChallenge,
			redirectUri: authReq.redirectUri,
			clientId: authReq.clientId,
			scopes: parseScopes(authReq.scopes),
		}),
		{ expirationTtl: 600 },
	);

	const redirect = new URL(authReq.redirectUri);
	redirect.searchParams.set("code", code);
	if (authReq.state) redirect.searchParams.set("state", authReq.state);
	return new Response(null, {
		status: 302,
		headers: {
			Location: redirect.toString(),
		},
	});
}

async function maybeExchangeFasSession(
	config: OAuthConfig,
	fasSession: string | null,
): Promise<string | null> {
	if (!fasSession) return null;
	return exchangeFasSession(config, fasSession);
}

async function tokenExchange(request: Request, config: OAuthConfig): Promise<Response> {
	let body: URLSearchParams;
	try {
		body = new URLSearchParams(await request.text());
	} catch {
		return json({ error: "invalid_request" }, 400);
	}

	if (body.get("grant_type") !== "authorization_code") {
		return json({ error: "unsupported_grant_type" }, 400);
	}

	const code = body.get("code");
	const redirectUri = body.get("redirect_uri");
	const clientId = body.get("client_id");
	const codeVerifier = body.get("code_verifier");
	if (!code || !redirectUri || !clientId || !codeVerifier) {
		return json({ error: "invalid_request" }, 400);
	}

	const codeRaw = await config.kv.get(`code:${code}`);
	if (!codeRaw) return json({ error: "invalid_grant" }, 400);
	await config.kv.delete(`code:${code}`);

	const codeData = JSON.parse(codeRaw) as {
		session: string;
		codeChallenge: string;
		redirectUri: string;
		clientId: string;
		scopes?: string[];
	};
	if (codeData.redirectUri !== redirectUri || codeData.clientId !== clientId) {
		return json({ error: "invalid_grant" }, 400);
	}

	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(codeVerifier),
	);
	const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	if (computed !== codeData.codeChallenge) {
		return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
	}

	const accessToken = crypto.randomUUID();
	await config.kv.put(
		`token:${accessToken}`,
		JSON.stringify({
			session: codeData.session,
			scopes: parseScopes(codeData.scopes),
		}),
		{ expirationTtl: 86_400 },
	);

	return json({
		access_token: accessToken,
		token_type: "bearer",
		expires_in: 86_400,
		scope: parseScopes(codeData.scopes).join(" "),
	});
}
