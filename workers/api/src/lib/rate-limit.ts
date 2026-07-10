/**
 * Simple in-memory rate limiter. Keyed PER USER when authenticated (fairer than
 * per-IP — corporate NAT / shared IPs no longer collide), falling back to the
 * client IP for anonymous requests. Resets per-minute, no persistence.
 */
import type { Context, Next } from "hono";
import { verifySession } from "./session.js";
import type { Env } from "../types.js";

const windowMs = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

/** Who to rate-limit: the authenticated user if the token is valid, else the IP. */
async function subject(c: Context<{ Bindings: Env }>): Promise<string> {
	const header = c.req.header("Authorization");
	if (header?.startsWith("Bearer ")) {
		try {
			const session = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
			if (session?.uid) return `u:${session.uid}`;
		} catch {
			/* fall through to IP */
		}
	}
	return `ip:${c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown"}`;
}

function deny(c: Context<{ Bindings: Env }>) {
	return c.json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
}

function getRateLimit(
	key: string,
	limit: number,
): { allowed: boolean; remaining: number } {
	const now = Date.now();
	let bucket = buckets.get(key);

	if (!bucket || now >= bucket.resetAt) {
		bucket = { count: 0, resetAt: now + windowMs };
		buckets.set(key, bucket);
	}

	bucket.count++;

	// Prune old entries periodically (every 100 requests)
	if (buckets.size > 10_000) {
		for (const [k, v] of buckets) {
			if (now >= v.resetAt) buckets.delete(k);
		}
	}

	return {
		allowed: bucket.count <= limit,
		remaining: Math.max(0, limit - bucket.count),
	};
}

/**
 * General API limit — 240/min per user (an authenticated SPA legitimately makes
 * many requests: status polls, board, the coding co-pilot). Two carve-outs:
 *  - live polling (takeover frames + the coding `capture` poll, ~1.5s) → 3000/min
 *    so it can never starve normal actions;
 *  - the coding co-pilot `/explain` (a per-request LLM call) → its own 40/min
 *    bucket so summaries/questions don't eat the general budget (and vice-versa).
 */
export function rateLimitDefault() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const who = await subject(c);
		const path = c.req.path;
		// Multipart part uploads ride the live bucket too: a large file is hundreds
		// of sequential 10MiB parts — the default 240/min would stall mid-upload.
		const isLivePoll = path.includes("/takeover") || path.endsWith("/capture") || path.includes("/files/multipart/");
		const isExplain = path.endsWith("/explain");
		const limit = isLivePoll ? 3000 : isExplain ? 40 : 240;
		const bucket = isLivePoll ? "live" : isExplain ? "explain" : "default";
		const { allowed, remaining } = getRateLimit(`${bucket}:${who}`, limit);
		c.header("X-RateLimit-Limit", String(limit));
		c.header("X-RateLimit-Remaining", String(remaining));
		if (!allowed) return deny(c);
		await next();
	};
}

/** 10/min per user — expensive endpoints (chat, run). */
export function rateLimitStrict() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const { allowed, remaining } = getRateLimit(`strict:${await subject(c)}`, 10);
		c.header("X-RateLimit-Limit", "10");
		c.header("X-RateLimit-Remaining", String(remaining));
		if (!allowed) return deny(c);
		await next();
	};
}
