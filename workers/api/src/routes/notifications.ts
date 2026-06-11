import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";

export const notificationRoutes = new Hono<{ Bindings: Env }>();

/** List notifications for the current user. */
notificationRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	const unreadOnly = c.req.query("unread") === "true";
	const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

	let sql = "SELECT * FROM notifications WHERE user_id = ?1";
	if (unreadOnly) sql += " AND read = 0";
	sql += " ORDER BY created_at DESC LIMIT ?2";

	const { results } = await c.env.DB.prepare(sql).bind(session.uid, limit).all();

	const unreadCount = await c.env.DB.prepare(
		"SELECT COUNT(*) as count FROM notifications WHERE user_id = ?1 AND read = 0",
	).bind(session.uid).first<{ count: number }>();

	return c.json({ notifications: results, unreadCount: unreadCount?.count || 0 });
});

/** Mark notification as read. */
notificationRoutes.post("/:id/read", async (c) => {
	const session = await requireUser(c);
	await c.env.DB.prepare(
		"UPDATE notifications SET read = 1 WHERE id = ?1 AND user_id = ?2",
	).bind(c.req.param("id"), session.uid).run();
	return c.json({ success: true });
});

/** Mark all notifications as read. */
notificationRoutes.post("/read-all", async (c) => {
	const session = await requireUser(c);
	await c.env.DB.prepare(
		"UPDATE notifications SET read = 1 WHERE user_id = ?1 AND read = 0",
	).bind(session.uid).run();
	return c.json({ success: true });
});

/**
 * Create a notification (internal — called by other routes).
 * Not exposed as an API endpoint.
 */
export async function createNotification(
	db: D1Database,
	userId: string,
	type: string,
	title: string,
	body: string,
	agentId?: string,
): Promise<void> {
	await db.prepare(
		`INSERT INTO notifications (id, user_id, type, title, body, agent_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`,
	).bind(crypto.randomUUID(), userId, type, title, body, agentId || null).run();

	// Send Slack webhook if configured (fire-and-forget)
	try {
		const user = await db.prepare(
			"SELECT slack_webhook FROM users WHERE id = ?1",
		).bind(userId).first<{ slack_webhook: string }>();
		if (user?.slack_webhook) {
			await fetch(user.slack_webhook, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					text: `*${title}*\n${body}`,
					blocks: [
						{ type: "section", text: { type: "mrkdwn", text: `*${title}*\n${body}` } },
						{ type: "context", elements: [{ type: "mrkdwn", text: `ProAgentStore · ${type}` }] },
					],
				}),
			}).catch((error) => {
				console.warn("Slack notification delivery failed", error);
			});
		}
	} catch (error) {
		console.warn("Notification dispatch failed", error);
	}
}
