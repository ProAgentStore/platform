import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";

export const billingRoutes = new Hono<{ Bindings: Env }>();

/** Get subscription status. */
billingRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const row = await c.env.DB.prepare(
		"SELECT stripe_customer_id, subscription_status, subscription_expires_at FROM users WHERE id = ?1",
	)
		.bind(session.uid)
		.first<{
			stripe_customer_id: string;
			subscription_status: string;
			subscription_expires_at: string;
		}>();

	return c.json({
		active: row?.subscription_status === "active",
		status: row?.subscription_status || "none",
		expiresAt: row?.subscription_expires_at || null,
	});
});

// TODO: Stripe checkout session creation
// TODO: Stripe webhook handler
// TODO: Creator payout calculations
