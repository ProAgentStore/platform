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

/** Require 'admin' role. */
export async function requireAdmin(
	c: Context<{ Bindings: Env }>,
): Promise<SessionPayload> {
	const session = await requireUser(c);
	if (!session.roles.includes("admin")) {
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
