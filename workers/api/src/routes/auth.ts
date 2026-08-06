import { Hono } from "hono";
import { isSubscriptionActive, subFromUserRow } from "../lib/billing.js";
import { signPayload, signSession, verifyPayload, verifySession } from "../lib/session.js";
import { isAllowedReturnTo } from "../lib/origins.js";
import { isSuspended, requireUser } from "../lib/auth.js";
import { bindMemberOrgInstallations } from "../lib/github-app.js";
import { logError } from "../lib/error-log.js";
import { mintMcpAuthCode, exchangeMcpAuthCode } from "../lib/mcp-auth-codes.js";
import { clearOauthBindCookie, newOauthNonce, oauthBindCookie, oauthBindMatches, readOauthBindCookie, OAUTH_BIND_ERROR } from "../lib/oauth-nonce.js";
import type { Env } from "../types.js";

export const authRoutes = new Hono<{ Bindings: Env }>();

interface OAuthState {
	returnTo: string;
	exp: number;
	/** Which caller started this flow (from `app_id`). `pags-mcp` gets a one-time code back
	 *  instead of the raw session token in the URL (#25). */
	appId?: string;
	/** Set for the LINK flow: record the GitHub username onto THIS account (no sign-in /
	 *  session switch). Uses the same /github/callback so the OAuth App's one registered
	 *  redirect URI still matches. */
	linkUid?: string;
	/** LINK flow only: binds the state to the browser that started it (see lib/oauth-nonce.ts).
	 *  Without it a signed state is bearer-grade — anyone holding one can have a victim complete
	 *  it and land the victim's GitHub identity (and org App installations) on THEIR account. */
	bindNonce?: string;
}

/**
 * Bounce back to `returnTo` with the minted session. For the MCP flow (#25) the raw session
 * token must NEVER travel in the URL (logs / Referer / history) — hand back a single-use code
 * the MCP worker exchanges server-to-server. Every other caller (the same-origin console) keeps
 * the existing `?session=`.
 */
async function bounceBackUrl(env: Env, returnTo: string, session: string, appId?: string): Promise<string> {
	const redirect = new URL(returnTo);
	if (appId === "pags-mcp") {
		redirect.searchParams.set("code", await mintMcpAuthCode(env, session));
	} else {
		redirect.searchParams.set("session", session);
	}
	return redirect.toString();
}

/** Upsert a user row and return their roles. Shared by both providers. */
async function upsertUser(
	env: Env,
	uid: string,
	login: string,
	name: string,
	avatar: string,
): Promise<string[]> {
	await env.DB.prepare(
		`INSERT INTO users (id, github_login, github_name, avatar_url, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       github_name = excluded.github_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`,
	)
		.bind(uid, login, name || login, avatar)
		.run();
	const row = await env.DB.prepare("SELECT roles FROM users WHERE id = ?1")
		.bind(uid)
		.first<{ roles: string }>();
	return row?.roles ? JSON.parse(row.roles) : ["user"];
}

/** GET /v1/auth/github/start — redirect the user to GitHub's OAuth consent. */
authRoutes.get("/github/start", async (c) => {
	const returnTo = c.req.query("return_to") ?? "";
	if (!returnTo) return c.text("missing return_to", 400);
	if (!isAllowedReturnTo(returnTo)) return c.text("return_to not allowed", 400);
	if (!c.env.GITHUB_CLIENT_ID) return c.text("GitHub OAuth not configured", 501);

	const state = await signPayload<OAuthState>(
		{ returnTo, exp: Math.floor(Date.now() / 1000) + 600, appId: c.req.query("app_id") },
		c.env.SESSION_SIGNING_KEY,
	);
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
	url.searchParams.set("scope", "read:user");
	url.searchParams.set("state", state);
	url.searchParams.set(
		"redirect_uri",
		new URL("/v1/auth/github/callback", c.req.url).toString(),
	);
	return c.redirect(url.toString());
});

/** GET /v1/auth/github/callback — exchange code, mint a PAGS session, bounce back. */
authRoutes.get("/github/callback", async (c) => {
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (!code || !stateRaw) return c.text("missing code or state", 400);
	const state = await verifyPayload<OAuthState>(stateRaw, c.env.SESSION_SIGNING_KEY);
	if (!state || state.exp < Math.floor(Date.now() / 1000)) {
		return c.text("invalid or expired state", 400);
	}
	if (!isAllowedReturnTo(state.returnTo)) return c.text("return_to not allowed", 400);

	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code,
		}),
	});
	const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
	if (!tokenData.access_token) {
		const reason = tokenData.error ?? "no token";
		await logError(c.env, { source: "auth", status: 401, message: `GitHub sign-in failed: ${reason}`, context: { provider: "github" } });
		return c.text(`OAuth failed: ${reason}`, 401);
	}
	const ghUser = await (
		await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${tokenData.access_token}`,
				"User-Agent": "ProAgentStore",
			},
		})
	).json<{ id: number; login: string; avatar_url: string; name: string }>();

	// LINK flow: record the GitHub username onto the account named in the signed state —
	// do NOT mint a session or switch accounts. Bounce back with ?github_linked=<login>.
	if (state.linkUid) {
		// The state alone says which account to credit, and a state is bearer-grade: whoever
		// STARTED the flow holds one. Require the completing browser to be the one that started
		// it, or an attacker's link, clicked by a victim, binds the VICTIM's GitHub identity —
		// and every org App installation they belong to — onto the ATTACKER's account.
		if (!oauthBindMatches(state.bindNonce, readOauthBindCookie(c.req.header("cookie"), "github_link"))) {
			await logError(c.env, {
				source: "auth",
				status: 400,
				message: "GitHub link rejected: state not bound to this browser",
				context: { provider: "github", linkUid: state.linkUid },
			});
			c.header("Set-Cookie", clearOauthBindCookie("github_link"));
			return c.text(OAUTH_BIND_ERROR, 400);
		}
		if (!ghUser.login) return c.text("could not read GitHub login", 502);
		c.header("Set-Cookie", clearOauthBindCookie("github_link")); // single-use
		await c.env.DB.prepare("UPDATE users SET linked_github_login = ?1, updated_at = datetime('now') WHERE id = ?2")
			.bind(ghUser.login, state.linkUid)
			.run();
		// Auto-bind every installed org (+ personal account) this user belongs to, verified
		// by their read:org token — so all their orgs light up from one Connect, no per-org
		// Members:read/sudo approval. Best-effort: a failure just leaves them to bind later.
		const bound = await bindMemberOrgInstallations(c.env, state.linkUid, ghUser.login, tokenData.access_token).catch(() => [] as string[]);
		const redirect = new URL(state.returnTo);
		redirect.searchParams.set("github_linked", ghUser.login);
		if (bound.length) redirect.searchParams.set("github_bound", String(bound.length));
		return c.redirect(redirect.toString());
	}

	const uid = String(ghUser.id);
	const roles = await upsertUser(c.env, uid, ghUser.login, ghUser.name, ghUser.avatar_url);
	const session = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
	return c.redirect(await bounceBackUrl(c.env, state.returnTo, session, state.appId));
});

/**
 * GET /v1/auth/github/link/start — begin linking a GitHub identity to the CURRENT account
 * (Bearer). Unlike /github/start (which signs in and would create a SEPARATE github: account),
 * this records the GitHub username onto the signed-in account so a Google user can authorize
 * the GitHub App / verify org membership without abandoning their instances. Reuses the shared
 * /github/callback (state carries `linkUid`) so the OAuth App's one registered redirect URI still
 * matches. Returns the consent URL as JSON — the caller holds a Bearer, not a cookie.
 */
authRoutes.get("/github/link/start", async (c) => {
	const session = await requireUser(c);
	const returnTo = c.req.query("return_to") ?? "";
	if (!returnTo || !isAllowedReturnTo(returnTo)) return c.json({ error: "return_to not allowed" }, 400);
	if (!c.env.GITHUB_CLIENT_ID) return c.json({ error: "GitHub OAuth not configured" }, 501);
	// 30 min (not the sign-in flow's 10): the consent page can take a while when you
	// click "Grant" on many orgs one by one, and an expired state 400s at the callback.
	// Bind the state to THIS browser: the same nonce goes into the signed state and into a
	// HttpOnly cookie. A victim who merely clicks the resulting link has no cookie, so the
	// callback refuses to credit the initiator. See lib/oauth-nonce.ts.
	const bindNonce = newOauthNonce();
	const state = await signPayload<OAuthState>(
		{ returnTo, exp: Math.floor(Date.now() / 1000) + 1800, linkUid: session.uid, bindNonce },
		c.env.SESSION_SIGNING_KEY,
	);
	c.header("Set-Cookie", oauthBindCookie(bindNonce, "github_link"));
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
	// read:org so the callback can verify + auto-bind every org you're a member of, using
	// YOUR token — no per-org App "Members:read" approval (which GitHub gates behind sudo).
	url.searchParams.set("scope", "read:user read:org");
	url.searchParams.set("state", state);
	url.searchParams.set("redirect_uri", new URL("/v1/auth/github/callback", c.req.url).toString());
	return c.json({ url: url.toString() });
});

/** GET /v1/auth/google/start — redirect to Google's OAuth consent. */
authRoutes.get("/google/start", async (c) => {
	const returnTo = c.req.query("return_to") ?? "";
	if (!returnTo) return c.text("missing return_to", 400);
	if (!isAllowedReturnTo(returnTo)) return c.text("return_to not allowed", 400);
	if (!c.env.GOOGLE_CLIENT_ID) return c.text("Google login not configured yet", 501);

	const state = await signPayload<OAuthState>(
		{ returnTo, exp: Math.floor(Date.now() / 1000) + 600, appId: c.req.query("app_id") },
		c.env.SESSION_SIGNING_KEY,
	);
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
	url.searchParams.set(
		"redirect_uri",
		new URL("/v1/auth/google/callback", c.req.url).toString(),
	);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "openid email profile");
	url.searchParams.set("state", state);
	return c.redirect(url.toString());
});

/** GET /v1/auth/google/callback — exchange code, mint a PAGS session, bounce back. */
authRoutes.get("/google/callback", async (c) => {
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (!code || !stateRaw) return c.text("missing code or state", 400);
	const state = await verifyPayload<OAuthState>(stateRaw, c.env.SESSION_SIGNING_KEY);
	if (!state || state.exp < Math.floor(Date.now() / 1000)) {
		return c.text("invalid or expired state", 400);
	}
	if (!isAllowedReturnTo(state.returnTo)) return c.text("return_to not allowed", 400);
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		return c.text("Google login not configured", 501);
	}

	const redirectUri = new URL("/v1/auth/google/callback", c.req.url).toString();
	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: c.env.GOOGLE_CLIENT_ID,
			client_secret: c.env.GOOGLE_CLIENT_SECRET,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}).toString(),
	});
	const tok = await tokenRes.json<{ access_token?: string; error?: string; error_description?: string }>();
	if (!tok.access_token) {
		// Persist + surface WHY (e.g. redirect_uri_mismatch) instead of a generic 401.
		const reason = tok.error_description || tok.error || `token exchange returned ${tokenRes.status}`;
		await logError(c.env, { source: "auth", status: 401, message: `Google sign-in failed: ${reason}`, context: { provider: "google", redirectUri } });
		return c.text(`Google OAuth failed: ${reason}`, 401);
	}
	const gUser = await (
		await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
			headers: { Authorization: `Bearer ${tok.access_token}` },
		})
	).json<{ id: string; email: string; name: string; picture: string }>();

	const uid = `google:${gUser.id}`;
	const roles = await upsertUser(c.env, uid, gUser.email, gUser.name, gUser.picture);
	const session = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
	return c.redirect(await bounceBackUrl(c.env, state.returnTo, session, state.appId));
});

/**
 * POST /v1/auth/mcp/exchange { code } — swap a one-time MCP auth code for its session,
 * server-to-server, so the session token never travels in a URL (#25). Fail-closed: a missing,
 * malformed, unknown, expired, or already-used code all return a bare 400.
 */
authRoutes.post("/mcp/exchange", async (c) => {
	const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
	const code = body.code;
	if (!code || typeof code !== "string") return c.json({ error: "code required" }, 400);
	const session = await exchangeMcpAuthCode(c.env, code);
	if (!session) return c.json({ error: "invalid or expired code" }, 400);
	return c.json({ session });
});

function parseJsonOrNull(value: string | null | undefined): unknown {
	if (!value) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

interface BoardColumnConfig {
	id: string;
	title: string;
	color: string;
	empty: string;
	statuses: string[];
	visibilities: string[];
	excludeStatuses: string[];
	excludeVisibilities: string[];
	catchAll: boolean;
}

interface BoardConfig {
	summary: string;
	columns: BoardColumnConfig[];
}

function strings(value: unknown, maxItems = 10): string[] {
	return Array.isArray(value)
		? value.map((item) => String(item).slice(0, 40)).slice(0, maxItems)
		: [];
}

function safeBoardColor(value: unknown): string {
	const color = String(value || "").trim().slice(0, 40);
	if (
		/^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([0-9, .%]+\)|hsla?\([0-9, .%]+\)|var\(--[a-z0-9-]+\))$/i.test(
			color,
		)
	) {
		return color;
	}
	return "var(--accent)";
}

export function normalizeBoardConfigInput(input: unknown): BoardConfig {
	let source = input;
	if (typeof input === "string") {
		try {
			source = JSON.parse(input);
		} catch {
			throw new Error("board_config must be valid JSON");
		}
	}
	if (!source || typeof source !== "object") {
		throw new Error("board_config must be an object");
	}
	const raw = source as { summary?: unknown; columns?: unknown };
	if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
		throw new Error("board_config.columns must contain at least one column");
	}
	const columns = raw.columns
		.slice(0, 8)
		.map((column): BoardColumnConfig => {
			if (!column || typeof column !== "object") {
				throw new Error("board_config columns must be objects");
			}
			const col = column as Record<string, unknown>;
			if (!col.id || !col.title) {
				throw new Error("board_config columns require id and title");
			}
			return {
				id: String(col.id).replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(0, 40),
				title: String(col.title).slice(0, 40),
				color: safeBoardColor(col.color || "var(--accent)"),
				empty: String(col.empty || "No agents in this column.").slice(0, 160),
				statuses: strings(col.statuses),
				visibilities: strings(col.visibilities),
				excludeStatuses: strings(col.excludeStatuses),
				excludeVisibilities: strings(col.excludeVisibilities),
				catchAll: Boolean(col.catchAll),
			};
		});
	return {
		summary: String(
			raw.summary || columns.map((column) => column.title.toLowerCase()).join(", "),
		).slice(0, 120),
		columns,
	};
}

/** Auth config — tells the console how to start the OAuth flow. */
authRoutes.get("/config", async (c) => {
	const base = new URL(c.req.url).origin;
	return c.json({
		// ProAgentStore's own OAuth — no FAS dependency.
		oauth_url: `${base}/v1/auth/github/start`,
		google_oauth_url: `${base}/v1/auth/google/start`,
		app_id: "pags-console",
		response_mode: "query",
	});
});

/**
 * Direct GitHub OAuth code-exchange endpoint — ProAgentStore's own OAuth app.
 */
authRoutes.post("/github", async (c) => {
	const { code, return_to } = await c.req.json<{
		code: string;
		return_to?: string;
	}>();
	if (!code) return c.json({ error: "code required" }, 400);

	if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
		return c.json(
			{ error: "GitHub OAuth not configured." },
			501,
		);
	}

	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code,
		}),
	});
	const tokenData = await tokenRes.json<{
		access_token?: string;
		error?: string;
	}>();
	if (!tokenData.access_token) {
		return c.json({ error: tokenData.error || "OAuth failed" }, 401);
	}

	const userRes = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			"User-Agent": "ProAgentStore",
		},
	});
	const ghUser = await userRes.json<{
		id: number;
		login: string;
		avatar_url: string;
		name: string;
	}>();

	const uid = String(ghUser.id);
	await c.env.DB.prepare(
		`INSERT INTO users (id, github_login, github_name, avatar_url, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       github_name = excluded.github_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`,
	)
		.bind(uid, ghUser.login, ghUser.name || ghUser.login, ghUser.avatar_url)
		.run();

	const row = await c.env.DB.prepare("SELECT roles FROM users WHERE id = ?1")
		.bind(uid)
		.first<{ roles: string }>();
	const roles = row?.roles ? JSON.parse(row.roles) : ["user"];

	const token = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
	return c.json({
		token,
		user: { id: uid, login: ghUser.login, avatar: ghUser.avatar_url, roles },
		return_to,
	});
});

/** Update profile (bio, website, twitter, display name). */
authRoutes.put("/me", async (c) => {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer "))
		return c.json({ error: "Not authenticated" }, 401);
	const session = await verifySession(
		header.slice(7),
		c.env.SESSION_SIGNING_KEY,
	);
	if (!session) return c.json({ error: "Invalid or expired token" }, 401);
	// This route verifies the session by hand rather than through requireUser, so the
	// suspension gate has to be applied explicitly — without it a suspended account
	// could still edit its public profile (#273).
	if (await isSuspended(c, session.uid)) return c.json({ error: "Account suspended" }, 403);

	const body = await c.req.json<{
		display_name?: string;
		bio?: string;
		website?: string;
		twitter?: string;
		slack_webhook?: string;
		board_config?: unknown;
	}>();
	let boardConfig: string | undefined;
	if (body.board_config !== undefined) {
		try {
			boardConfig = JSON.stringify(normalizeBoardConfigInput(body.board_config));
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Invalid board_config" }, 400);
		}
	}
	// Validate slack webhook URL (SSRF protection)
	if (body.slack_webhook !== undefined && body.slack_webhook !== "") {
		try {
			const u = new URL(body.slack_webhook);
			if (u.protocol !== "https:") return c.json({ error: "Slack webhook must be https" }, 400);
			// Exact host or a dot-prefixed subdomain — a bare endsWith("slack.com") would also
			// match attacker-controlled domains like evilslack.com (allow-list / SSRF bypass).
			const h = u.hostname.toLowerCase();
			const allowedHost = (d: string) => h === d || h.endsWith(`.${d}`);
			if (!allowedHost("slack.com") && !allowedHost("discord.com"))
				return c.json({ error: "Webhook must be a Slack or Discord URL" }, 400);
		} catch { return c.json({ error: "Invalid webhook URL" }, 400); }
	}
	const allowed = [
		["display_name", "display_name"],
		["bio", "bio"],
		["website", "website"],
		["twitter", "twitter"],
		["slack_webhook", "slack_webhook"],
		["board_config", "board_config"],
	] as const;
	const sets: string[] = ["updated_at = datetime('now')"];
	const params: unknown[] = [];
	for (const [key, column] of allowed) {
		const value = key === "board_config" ? boardConfig : body[key];
		if (value !== undefined) {
			params.push(value);
			sets.push(`${column} = ?${params.length + 1}`);
		}
	}
	if (params.length === 0) return c.json({ error: "Nothing to update" }, 400);
	params.unshift(session.uid);
	const sql = ["UPDATE users SET", sets.join(", "), "WHERE id = ?1"].join(" ");
	await c.env.DB.prepare(sql)
		.bind(...params)
		.run();
	return c.json({ success: true });
});

/**
 * Verify current PAGS session.
 *
 * The 403 below is load-bearing beyond this route: it is the ONLY way another worker
 * can ask "is this session suspended?" without duplicating the definition, and the MCP
 * worker's tool gate (#273) reads exactly that status. Changing 403 to anything else
 * silently re-opens that bypass — `auth-suspension.test.ts` pins it.
 */
authRoutes.get("/me", async (c) => {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer "))
		return c.json({ error: "Not authenticated" }, 401);

	const session = await verifySession(
		header.slice(7),
		c.env.SESSION_SIGNING_KEY,
	);
	if (!session) return c.json({ error: "Invalid or expired token" }, 401);
	if (await isSuspended(c, session.uid)) return c.json({ error: "Account suspended" }, 403);

	const row = await c.env.DB.prepare(
		"SELECT id, github_login, linked_github_login, github_name, avatar_url, roles, stripe_customer_id, subscription_status, subscription_expires_at, display_name, bio, website, twitter, slack_webhook, board_config FROM users WHERE id = ?1",
	)
		.bind(session.uid)
		.first<Record<string, string>>();
	if (!row) return c.json({ error: "User not found" }, 404);

	const roles = JSON.parse(row.roles || '["user"]') as string[];
	return c.json({
		id: row.id,
		login: row.github_login,
		githubLinked: row.linked_github_login || null,
		name: row.display_name || row.github_name,
		avatar: row.avatar_url,
		roles,
		// A usable subscription (or admin comp) — NOT "has a Stripe customer id",
		// which stays truthy forever after a cancel.
		hasSubscription: roles.includes("admin") || isSubscriptionActive(subFromUserRow(row)),
		bio: row.bio || "",
		website: row.website || "",
		twitter: row.twitter || "",
		slackWebhook: row.slack_webhook ? "configured" : "",
		boardConfig: parseJsonOrNull(row.board_config),
	});
});
