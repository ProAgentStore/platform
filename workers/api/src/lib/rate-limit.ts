/**
 * Simple in-memory rate limiter. Keyed PER USER when authenticated (fairer than
 * per-IP — corporate NAT / shared IPs no longer collide), falling back to the
 * client IP for anonymous requests. Resets per-minute, no persistence.
 */
import type { Context, Next } from "hono";
import { logDirectResponse } from "./on-error.js";
import { verifySession } from "./session.js";
import type { Env } from "../types.js";

const windowMs = 60_000;
/** `reported` — this window's refusal is already in the log (#1086). */
interface Bucket {
	count: number;
	resetAt: number;
	reported?: boolean;
}
const buckets = new Map<string, Bucket>();

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
	// CF-Connecting-IP is set by the Cloudflare edge and is not client-spoofable. Do NOT
	// fall back to X-Forwarded-For — an attacker rotating that header would mint a fresh
	// bucket per request and defeat the anonymous limit entirely.
	return `ip:${c.req.header("CF-Connecting-IP") || "unknown"}`;
}

/**
 * Refuse, and record it (#1086) — once per bucket per window, not once per refused request. A
 * client hammering a limit is the case worth a row, and also the case that would flood the log if
 * every refusal wrote one; the first refusal in a window is the evidence, the rest are the same fact.
 * The subject is recorded as its KIND (`user` / `ip`) — never the IP itself.
 */
async function deny(c: Context<{ Bindings: Env }>, bucket: { key: string; state: Bucket; limit: number }) {
	if (!bucket.state.reported) {
		bucket.state.reported = true;
		const name = bucket.key.split(":")[0];
		const who = bucket.key.substring(name.length + 1);
		const isUser = who.startsWith("u:");
		await logDirectResponse(c.env, {
			status: 429,
			source: "rate-limit",
			message: `rate limit exceeded: ${name} (${bucket.limit}/min)`,
			userId: isUser ? who.substring(2) : null,
			context: { bucket: name, limit: bucket.limit, subject: isUser ? "user" : "ip", path: c.req.path, method: c.req.method },
		});
	}
	return c.json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
}

function getRateLimit(
	key: string,
	limit: number,
): { allowed: boolean; remaining: number; state: Bucket } {
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
		state: bucket,
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
		const key = `${bucket}:${who}`;
		const { allowed, remaining, state } = getRateLimit(key, limit);
		c.header("X-RateLimit-Limit", String(limit));
		c.header("X-RateLimit-Remaining", String(remaining));
		if (!allowed) return deny(c, { key, state, limit });
		await next();
	};
}

/** 10/min per user — expensive endpoints (chat, run). */
export function rateLimitStrict() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const key = `strict:${await subject(c)}`;
		const { allowed, remaining, state } = getRateLimit(key, 10);
		c.header("X-RateLimit-Limit", "10");
		c.header("X-RateLimit-Remaining", String(remaining));
		if (!allowed) return deny(c, { key, state, limit: 10 });
		await next();
	};
}

/**
 * Dedicated admin bucket (issue #109) — a second gate in front of /v1/admin/* on top
 * of the general 240/min. An authenticated admin SPA legitimately polls (Terminals live
 * status), so authed users get 120/min; but an UNauthenticated prober falls through to an
 * `ip:` subject, and we clamp that to 20/min so the admin surface isn't a 240/min
 * enumeration budget. Complements the requireAdmin role check and the CF Access perimeter.
 */
export function rateLimitAdmin() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const who = await subject(c);
		const limit = who.startsWith("u:") ? 120 : 20;
		const key = `admin:${who}`;
		const { allowed, remaining, state } = getRateLimit(key, limit);
		c.header("X-RateLimit-Limit", String(limit));
		c.header("X-RateLimit-Remaining", String(remaining));
		if (!allowed) return deny(c, { key, state, limit });
		await next();
	};
}
