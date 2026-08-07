import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { consoleHomeLink } from "../lib/console-links.js";
import { type PushSubscription, sendWebPush, type VapidConfig } from "../lib/web-push.js";
import type { Env } from "../types.js";
import { createNotification } from "./notifications.js";

export const pushRoutes = new Hono<{ Bindings: Env }>();

/** Max push subscriptions kept per user (older ones are pruned). */
const MAX_SUBS_PER_USER = 20;

/**
 * SSRF guard: the worker later fetch()es a subscription's endpoint, so a user
 * must not be able to point it at internal/private hosts. Require a public
 * https URL on the default port with a real hostname.
 */
export function isSafePushEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") return false;
	if (url.username || url.password) return false;
	if (url.port && url.port !== "443") return false;
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
	if (host.includes(":")) return false; // IPv6 literal
	// Bare IPv4 is never a real push service (and covers private ranges).
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
	return host.includes("."); // must be a dotted public hostname
}

/** True when `value` is base64url that decodes to exactly `len` bytes. */
function isB64urlLen(value: string, len: number): boolean {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
	try {
		const s = value.replace(/-/g, "+").replace(/_/g, "/");
		return atob(s + "=".repeat((4 - (s.length % 4)) % 4)).length === len;
	} catch {
		return false;
	}
}

/** Public VAPID key the browser needs to create a push subscription. */
pushRoutes.get("/vapid-key", (c) => {
	return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY || null });
});

/** Store (or refresh) a push subscription for the current user. */
pushRoutes.post("/subscribe", async (c) => {
	const session = await requireUser(c);
	let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } = {};
	try {
		body = await c.req.json();
	} catch {
		/* invalid JSON → empty */
	}
	if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
		return c.json({ error: "Invalid subscription" }, 400);
	}
	if (body.endpoint.length > 2048 || !isSafePushEndpoint(body.endpoint)) {
		return c.json({ error: "Unsupported push endpoint" }, 400);
	}
	// p256dh is a 65-byte uncompressed P-256 point; auth is a 16-byte secret.
	if (!isB64urlLen(body.keys.p256dh, 65) || !isB64urlLen(body.keys.auth, 16)) {
		return c.json({ error: "Invalid subscription keys" }, 400);
	}
	await c.env.DB.prepare(
		`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
     ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
	)
		.bind(
			crypto.randomUUID(),
			session.uid,
			body.endpoint,
			body.keys.p256dh,
			body.keys.auth,
			(c.req.header("user-agent") || "").slice(0, 200),
		)
		.run();
	// Cap per-user growth: keep only the most recent subscriptions.
	await c.env.DB.prepare(
		`DELETE FROM push_subscriptions WHERE user_id = ?1 AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2
     )`,
	)
		.bind(session.uid, MAX_SUBS_PER_USER)
		.run();
	return c.json({ success: true });
});

/** Remove a push subscription (on unsubscribe / sign-out). */
pushRoutes.delete("/subscribe", async (c) => {
	const session = await requireUser(c);
	let body: { endpoint?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		/* ignore */
	}
	if (body.endpoint) {
		await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2")
			.bind(session.uid, body.endpoint)
			.run();
	}
	return c.json({ success: true });
});

/** Send a test push to the current user's devices (for setup validation). */
pushRoutes.post("/test", async (c) => {
	const session = await requireUser(c);
	const sent = await sendPushToUser(c.env, session.uid, {
		title: "ProAgentStore",
		body: "Push notifications are working ✅",
		url: consoleHomeLink(),
		tag: "pags-test",
	});
	return c.json({ sent });
});

function vapidConfig(env: Env): VapidConfig | null {
	if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
	return {
		publicKey: env.VAPID_PUBLIC_KEY,
		privateKey: env.VAPID_PRIVATE_KEY,
		subject: env.VAPID_SUBJECT || "mailto:hello@proagentstore.online",
	};
}

export interface PushMessage {
	title: string;
	body: string;
	url?: string;
	tag?: string;
}

/** Send a Web Push to every device a user has registered. Prunes dead/duplicate subs. */
export async function sendPushToUser(env: Env, userId: string, msg: PushMessage): Promise<number> {
	const vapid = vapidConfig(env);
	if (!vapid) return 0;
	const { results } = await env.DB.prepare(
		"SELECT id, endpoint, p256dh, auth, user_agent FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC",
	)
		.bind(userId)
		.all<{ id: string; endpoint: string; p256dh: string; auth: string; user_agent: string | null }>();

	// Deduped by ENDPOINT, which is the thing that actually identifies a subscription — and only
	// skipped, never deleted.
	//
	// Keying on `user_agent` was wrong twice over. It is the raw UA header truncated to 200 chars,
	// so a laptop and a desktop on the same Chrome + OS version produce byte-identical values —
	// and the older row was DELETED, silently and permanently unsubscribing one of the user's two
	// machines on the first push. The existing test never sets user_agent, so it fell through to
	// the per-row-unique endpoint and never exercised the collision.
	//
	// The duplicate this guards against is the same endpoint re-inserted after the browser
	// re-subscribes, and skipping is enough for that: a false positive here costs one duplicate
	// notification, whereas a false positive on DELETE is unrecoverable without the user manually
	// re-enabling.
	const seen = new Set<string>();
	const fresh: typeof results = [];
	for (const row of results) {
		if (seen.has(row.endpoint)) continue;
		seen.add(row.endpoint);
		fresh.push(row);
	}

	let sent = 0;
	await Promise.all(
		fresh.map(async (row) => {
			if (!isSafePushEndpoint(row.endpoint)) {
				await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(row.id).run();
				return;
			}
			const sub: PushSubscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
			try {
				const res = await sendWebPush(sub, JSON.stringify(msg), vapid);
				if (res.status === 404 || res.status === 410) {
					await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(row.id).run();
				} else if (res.ok) {
					sent += 1;
				}
			} catch {
				// individual delivery failures are non-fatal
			}
		}),
	);
	return sent;
}

/** In-app notification + Web Push to the user's phone, in one call. */
export async function notifyUser(
	env: Env,
	userId: string,
	type: string,
	title: string,
	body: string,
	url?: string,
): Promise<void> {
	await createNotification(env.DB, userId, type, title, body, undefined, url).catch(() => undefined);
	await sendPushToUser(env, userId, { title, body, url, tag: type }).catch(() => undefined);
}
