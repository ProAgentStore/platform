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
 *
 * Also the single enforcement point for operator SUSPENSION (issue #34): a suspended
 * account is rejected here, so every authenticated route is covered at once and the
 * next route added cannot forget the check. Revoking the token would not work — a
 * session lives 30 days and the user can simply sign in again for a fresh one.
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
	if (await isSuspended(c, session.uid)) {
		throw new HttpError(403, "Account suspended");
	}
	return session;
}

/**
 * Live suspension lookup — one indexed PK read. Deliberately NOT cached: an operator
 * suspending an account that is actively doing damage needs it to stop now, not after
 * a TTL, and this is the whole point of the lever.
 *
 * FAILS OPEN on a DB error. A D1 blip must not 403 the entire platform; the failure
 * mode of a moderation gate briefly not applying is far smaller than a total outage.
 */
async function isSuspended(c: Context<{ Bindings: Env }>, uid: string): Promise<boolean> {
	try {
		if (!c.env?.DB) return false;
		const row = await c.env.DB.prepare("SELECT suspended FROM users WHERE id = ?1")
			.bind(uid)
			.first<{ suspended: number | null }>();
		return !!row?.suspended;
	} catch {
		return false;
	}
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
