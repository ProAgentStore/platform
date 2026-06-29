import { Hono } from "hono";
import { signPayload, signSession, verifyPayload, verifySession } from "../lib/session.js";
import { isAllowedReturnTo } from "../lib/origins.js";
import type { Env } from "../types.js";

export const authRoutes = new Hono<{ Bindings: Env }>();

const FAS_API = "https://api.freeappstore.online";

interface OAuthState {
	returnTo: string;
	exp: number;
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
		{ returnTo, exp: Math.floor(Date.now() / 1000) + 600 },
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
		return c.text(`OAuth failed: ${tokenData.error ?? "no token"}`, 401);
	}
	const ghUser = await (
		await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${tokenData.access_token}`,
				"User-Agent": "ProAgentStore",
			},
		})
	).json<{ id: number; login: string; avatar_url: string; name: string }>();

	const uid = String(ghUser.id);
	const roles = await upsertUser(c.env, uid, ghUser.login, ghUser.name, ghUser.avatar_url);
	const session = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
	const redirect = new URL(state.returnTo);
	redirect.searchParams.set("session", session);
	return c.redirect(redirect.toString());
});

/** GET /v1/auth/google/start — redirect to Google's OAuth consent. */
authRoutes.get("/google/start", async (c) => {
	const returnTo = c.req.query("return_to") ?? "";
	if (!returnTo) return c.text("missing return_to", 400);
	if (!isAllowedReturnTo(returnTo)) return c.text("return_to not allowed", 400);
	if (!c.env.GOOGLE_CLIENT_ID) return c.text("Google login not configured yet", 501);

	const state = await signPayload<OAuthState>(
		{ returnTo, exp: Math.floor(Date.now() / 1000) + 600 },
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
	const tok = await tokenRes.json<{ access_token?: string }>();
	if (!tok.access_token) return c.text("Google OAuth failed", 401);
	const gUser = await (
		await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
			headers: { Authorization: `Bearer ${tok.access_token}` },
		})
	).json<{ id: string; email: string; name: string; picture: string }>();

	const uid = `google:${gUser.id}`;
	const roles = await upsertUser(c.env, uid, gUser.email, gUser.name, gUser.picture);
	const session = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
	const redirect = new URL(state.returnTo);
	redirect.searchParams.set("session", session);
	return c.redirect(redirect.toString());
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
 * Exchange a FAS session token for a PAGS session token.
 * Flow: Console → FAS OAuth → fas_session in URL → POST here → PAGS token.
 * Same pattern as FAGS console — piggyback on FAS's GitHub OAuth app.
 */
authRoutes.post("/exchange", async (c) => {
	const { fas_session } = await c.req.json<{ fas_session: string }>();
	if (!fas_session) return c.json({ error: "fas_session required" }, 400);

	// Verify the FAS token by calling FAS /v1/auth/me
	const fasRes = await fetch(`${FAS_API}/v1/auth/me`, {
		headers: { Authorization: `Bearer ${fas_session}` },
	});
	if (!fasRes.ok) {
		return c.json({ error: "Invalid FAS session" }, 401);
	}
	// FAS /v1/auth/me returns: { id, login, githubLogin, avatarUrl, roles, ... }
	const fasUser = await fasRes.json<{
		id?: string;
		login?: string;
		githubLogin?: string;
		avatarUrl?: string;
	}>();
	if (!fasUser.id) {
		return c.json({ error: "FAS session invalid" }, 401);
	}

	const uid = fasUser.id;
	const github_login = fasUser.githubLogin || fasUser.login || "unknown";
	const avatar_url = fasUser.avatarUrl || "";
	const github_name = fasUser.login || github_login;

	// Upsert user in PAGS D1 — everyone is a creator on PAGS (it's a creator platform)
	const defaultRoles = JSON.stringify(["user", "creator"]);
	await c.env.DB.prepare(
		`INSERT INTO users (id, github_login, github_name, avatar_url, roles, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       github_name = excluded.github_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`,
	)
		.bind(
			uid,
			github_login,
			github_name || github_login,
			avatar_url,
			defaultRoles,
		)
		.run();

	// Fetch roles (existing users keep their roles, new users get user+creator)
	const row = await c.env.DB.prepare("SELECT roles FROM users WHERE id = ?1")
		.bind(uid)
		.first<{ roles: string }>();
	const roles = row?.roles ? JSON.parse(row.roles) : ["user", "creator"];

	const token = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
	return c.json({
		token,
		user: { id: uid, login: github_login, avatar: avatar_url, roles },
	});
});

/**
 * Direct GitHub OAuth callback — exchange code for token.
 * Kept for future use when PAGS has its own OAuth app.
 */
authRoutes.post("/github", async (c) => {
	const { code, return_to } = await c.req.json<{
		code: string;
		return_to?: string;
	}>();
	if (!code) return c.json({ error: "code required" }, 400);

	if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
		return c.json(
			{
				error:
					"GitHub OAuth not configured. Use /v1/auth/exchange with a FAS token instead.",
			},
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

/** Verify current PAGS session. */
authRoutes.get("/me", async (c) => {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer "))
		return c.json({ error: "Not authenticated" }, 401);

	const session = await verifySession(
		header.slice(7),
		c.env.SESSION_SIGNING_KEY,
	);
	if (!session) return c.json({ error: "Invalid or expired token" }, 401);

	const row = await c.env.DB.prepare(
		"SELECT id, github_login, github_name, avatar_url, roles, stripe_customer_id, display_name, bio, website, twitter, slack_webhook, board_config FROM users WHERE id = ?1",
	)
		.bind(session.uid)
		.first<Record<string, string>>();
	if (!row) return c.json({ error: "User not found" }, 404);

	return c.json({
		id: row.id,
		login: row.github_login,
		name: row.display_name || row.github_name,
		avatar: row.avatar_url,
		roles: JSON.parse(row.roles || '["user"]'),
		hasSubscription: !!row.stripe_customer_id,
		bio: row.bio || "",
		website: row.website || "",
		twitter: row.twitter || "",
		slackWebhook: row.slack_webhook ? "configured" : "",
		boardConfig: parseJsonOrNull(row.board_config),
	});
});
