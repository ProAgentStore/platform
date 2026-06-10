const AUTH_IN_FLIGHT_COOKIE = "pags_mcp_oauth_inflight";

export interface OAuthConfig {
	issuer: string;
	authStart: string;
	apiBase: string;
	kv: KVNamespace;
	sessionSigningKey: string;
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
): Promise<string | null> {
	return kv.get(`token:${bearer}`);
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

function cookieValue(request: Request, name: string): string | null {
	const raw = request.headers.get("Cookie") ?? "";
	for (const part of raw.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=") || "";
	}
	return null;
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

function authAlreadyInProgress(): Response {
	return new Response(
		"<!doctype html><title>ProAgentStore sign-in</title><p>ProAgentStore MCP sign-in is already in progress in another tab. Complete that sign-in, then return to your MCP client.</p>",
		{ headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
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

	if (responseType !== "code") return new Response("unsupported_response_type", { status: 400 });
	if (!clientId || !redirectUri || !codeChallenge) {
		return new Response("missing client_id, redirect_uri, or code_challenge", { status: 400 });
	}
	if (codeChallengeMethod && codeChallengeMethod !== "S256") {
		return new Response("only S256 is supported", { status: 400 });
	}
	if (cookieValue(request, AUTH_IN_FLIGHT_COOKIE)) return authAlreadyInProgress();

	const clientRaw = await config.kv.get(`client:${clientId}`);
	if (!clientRaw) return new Response("invalid client_id", { status: 400 });
	const client = JSON.parse(clientRaw) as { redirect_uris: string[]; client_name?: string | null };
	if (!client.redirect_uris.includes(redirectUri)) {
		return new Response("redirect_uri not registered", { status: 400 });
	}

	const nonce = crypto.randomUUID();
	await config.kv.put(
		`authreq:${nonce}`,
		JSON.stringify({ clientId, redirectUri, codeChallenge, state }),
		{ expirationTtl: 600 },
	);

	const continueUrl = new URL("/authorize/continue", config.issuer);
	continueUrl.searchParams.set("nonce", nonce);
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
    a{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border-radius:8px;background:#7c3aed;color:white;text-decoration:none;font-weight:700}
  </style>
</head>
<body>
  <main>
    <h1>Connect ProAgentStore MCP</h1>
    <p>${clientName} wants to use ProAgentStore MCP tools as your account.</p>
    <a href="${escapeHtml(continueUrl.toString())}" autofocus>Continue with GitHub</a>
  </main>
</body>
</html>`,
		{
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Set-Cookie": `${AUTH_IN_FLIGHT_COOKIE}=1; Max-Age=120; Path=/; Secure; HttpOnly; SameSite=Lax`,
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

	const authUrl = new URL(config.authStart);
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
	};

	const code = crypto.randomUUID();
	await config.kv.put(
		`code:${code}`,
		JSON.stringify({
			session,
			codeChallenge: authReq.codeChallenge,
			redirectUri: authReq.redirectUri,
			clientId: authReq.clientId,
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
			"Set-Cookie": `${AUTH_IN_FLIGHT_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
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
	await config.kv.put(`token:${accessToken}`, codeData.session, {
		expirationTtl: 86_400,
	});

	return json({
		access_token: accessToken,
		token_type: "bearer",
		expires_in: 86_400,
	});
}
