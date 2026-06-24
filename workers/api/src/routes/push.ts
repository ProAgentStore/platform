import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { type PushSubscription, sendWebPush, type VapidConfig } from "../lib/web-push.js";
import type { Env } from "../types.js";
import { createNotification } from "./notifications.js";

export const pushRoutes = new Hono<{ Bindings: Env }>();

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
		url: "/console/",
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

/** Send a Web Push to every device a user has registered. Prunes dead subs. */
export async function sendPushToUser(env: Env, userId: string, msg: PushMessage): Promise<number> {
	const vapid = vapidConfig(env);
	if (!vapid) return 0;
	const { results } = await env.DB.prepare(
		"SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1",
	)
		.bind(userId)
		.all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
	let sent = 0;
	await Promise.all(
		results.map(async (row) => {
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
	await createNotification(env.DB, userId, type, title, body).catch(() => undefined);
	await sendPushToUser(env, userId, { title, body, url, tag: type }).catch(() => undefined);
}
