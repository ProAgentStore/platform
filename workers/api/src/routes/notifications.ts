import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import type { NotificationKind } from "../lib/notifications.js";
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
 * What the row records beyond its prose (#361/#360).
 *
 * `interrupt: false` still writes the row — the bell list is a LOG and must stay complete;
 * it is the interruption that needs bounding. Same split as the #176 visibility gate, which
 * suppresses the OS banner for a visible console tab and still forwards the payload so the
 * badge updates. So a suppressed notification is visible and auditable, which is exactly what
 * the push `tag` was not: it hid the repetition in the tray while every alert still fired.
 */
export interface NotificationRecordOptions {
	dedupeKey?: string;
	kind?: NotificationKind;
	/** False when this copy was suppressed (duplicate, or a muted type) — no push, no Slack. */
	interrupt?: boolean;
}

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
	url?: string,
	opts: NotificationRecordOptions = {},
): Promise<void> {
	const interrupt = opts.interrupt !== false;
	await db.prepare(
		`INSERT INTO notifications (id, user_id, type, title, body, agent_id, url, kind, dedupe_key, pushed_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))`,
	)
		.bind(
			crypto.randomUUID(),
			userId,
			type,
			title,
			body,
			agentId || null,
			url || null,
			opts.kind || "update",
			opts.dedupeKey || null,
			// The window is measured against a real interruption — see migration 0093.
			interrupt ? new Date().toISOString() : null,
		)
		.run();

	// Slack is an interruption channel like the push is, so a suppressed copy is silent there
	// too. Muting deploys in the console and still being pinged in Slack would make the control
	// a half-truth.
	if (!interrupt) return;

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
