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
 * Also the enforcement point for operator SUSPENSION (issue #34): a suspended
 * account is rejected here, so every route that authenticates THROUGH THIS FUNCTION is
 * covered at once. Revoking the token would not work — a session lives 30 days and the
 * user can simply sign in again for a fresh one.
 *
 * The qualifier matters (issue #273): a handful of routes authenticate inline instead
 * of calling this — `/v1/auth/me`, and the two WS upgrades, which can't send a header
 * and so verify a purpose-scoped `?token=` (chat / relay) rather than a session. Those
 * call {@link isSuspended} themselves; anything else added that authenticates by hand
 * must do the same.
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
 *
 * Exported for the routes that authenticate WITHOUT `requireUser` (the WS chat upgrade,
 * which verifies a short-lived chat token, and `/v1/auth/me`) — a token minted before a
 * suspension is still valid, so the live read is the only gate. Through `/v1/auth/me`'s 403 it is also the
 * signal the MCP worker's own gate reads (#273).
 */
export async function isSuspended(c: Context<{ Bindings: Env }>, uid: string): Promise<boolean> {
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
 * The `users.roles` column as a list of role names.
 *
 * A row that is not a JSON array of strings simply has NO roles. It must not throw: the read
 * below resolves admin from `roles` OR from `github_login`, and those two live inside one
 * `try` whose catch is there for "the DB is unavailable". A `JSON.parse` that raised — or a
 * parsed value with no `.includes` — used to jump out of that block and skip the allowlist
 * check on the very next line, so ONE malformed blob silently cost a legitimate operator
 * their break-glass path. `lib/external-usage.ts` reads the same column and already scopes
 * its parse this way; this brings the two into line.
 *
 * Fails closed either way: an unparseable `roles` never grants admin.
 */
function rolesOf(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
	} catch {
		return [];
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
		if (rolesOf(row?.roles).includes("admin")) return true;
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
