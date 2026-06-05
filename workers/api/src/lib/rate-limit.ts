/**
 * Simple in-memory rate limiter using CF request headers.
 * Uses CF-Connecting-IP for client identification.
 * Resets per-minute — no persistence needed.
 */
import type { Context, Next } from 'hono';
import type { Env } from '../types.js';

const windowMs = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function getRateLimit(key: string, limit: number): { allowed: boolean; remaining: number } {
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

/** 60 req/min per IP — general API rate limit. */
export function rateLimitDefault() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const { allowed, remaining } = getRateLimit(`default:${ip}`, 60);
    c.header('X-RateLimit-Limit', '60');
    c.header('X-RateLimit-Remaining', String(remaining));
    if (!allowed) {
      return c.json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429);
    }
    await next();
  };
}

/** 10 req/min per IP — expensive endpoints (chat, run). */
export function rateLimitStrict() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const { allowed, remaining } = getRateLimit(`strict:${ip}`, 10);
    c.header('X-RateLimit-Limit', '10');
    c.header('X-RateLimit-Remaining', String(remaining));
    if (!allowed) {
      return c.json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429);
    }
    await next();
  };
}
