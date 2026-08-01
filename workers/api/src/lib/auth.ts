import type { Context } from "hono";
import type { Env, SessionPayload } from "../types.js";
import { verifySession } from "./session.js";

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

/**
 * Extract and verify Bearer token. Throws HttpError(401) if missing/invalid.
 * Returns the session payload.
 */
export async function requireUser(
	c: Context<{ Bindings: Env }>,
): Promise<SessionPayload> {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		throw new HttpError(401, "Missing Authorization header");
	}
	const token = header.slice(7);
	const session = await verifySession(token, c.env.SESSION_SIGNING_KEY);
	if (!session) {
		throw new HttpError(401, "Invalid or expired token");
	}
	return session;
}

/**
 * Resolve whether a session is an admin (issue #28), defense-in-depth:
 *   1. the role baked into the session token (fast path), then
 *   2. a LIVE `users.roles` read — so a freshly granted/revoked admin takes effect
 *      immediately without waiting for the 30-day token to expire, then
 *   3. the ADMIN_ALLOWLIST env (break-glass) — bootstraps the first admin. Matches
 *      the session uid OR the user's github_login/email, so the operator can be
 *      promoted with a value they actually know (not the opaque uid hash) even if
 *      the seed migration ran before their user row existed.
 */
export async function isAdmin(
	c: Context<{ Bindings: Env }>,
	session: SessionPayload,
): Promise<boolean> {
	if (session.roles.includes("admin")) return true;
	const allow = (c.env.ADMIN_ALLOWLIST || "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (allow.includes(session.uid.toLowerCase())) return true;
	try {
		const row = await c.env.DB.prepare("SELECT roles, github_login FROM users WHERE id = ?1")
			.bind(session.uid)
			.first<{ roles: string; github_login: string }>();
		if (row?.roles && (JSON.parse(row.roles) as string[]).includes("admin")) return true;
		if (row?.github_login && allow.includes(row.github_login.toLowerCase())) return true;
	} catch {
		// DB unavailable — uid allowlist above is the only remaining path
	}
	return false;
}

/** Require 'admin' role (see isAdmin for the resolution order). */
export async function requireAdmin(
	c: Context<{ Bindings: Env }>,
): Promise<SessionPayload> {
	const session = await requireUser(c);
	if (!(await isAdmin(c, session))) {
		throw new HttpError(403, "Admin access required");
	}
	return session;
}

/** Require 'creator' role. */
export async function requireCreator(
	c: Context<{ Bindings: Env }>,
): Promise<SessionPayload> {
	const session = await requireUser(c);
	if (!session.roles.includes("creator") && !session.roles.includes("admin")) {
		throw new HttpError(403, "Creator access required");
	}
	return session;
}
