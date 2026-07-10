/**
 * Billing routes — the $9/mo ProAgentStore Pro subscription (see lib/billing.ts).
 * Checkout + customer portal + the Stripe webhook that keeps the users columns
 * in sync. Webhook URL registered with Stripe:
 * https://api.proagentstore.online/v1/billing/webhook
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	createCheckoutSession,
	createPortalSession,
	handleStripeEvent,
	isEntitled,
	isPaywallEnforced,
	verifyWebhookSignature,
} from "../lib/billing.js";
import type { Env } from "../types.js";

const PROFILE_URL = "https://proagentstore.online/console/profile";

export const billingRoutes = new Hono<{ Bindings: Env }>();

/** Get subscription status (+ resolved Pro entitlement and enforcement flag). */
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
		hasBillingAccount: !!row?.stripe_customer_id,
		pro: await isEntitled(c.env, session),
		enforced: isPaywallEnforced(c.env),
	});
});

/** Start a Stripe Checkout for the Pro subscription — returns the redirect URL. */
billingRoutes.post("/checkout", async (c) => {
	const session = await requireUser(c);
	const row = await c.env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?1")
		.bind(session.uid)
		.first<{ stripe_customer_id: string | null }>();
	const result = await createCheckoutSession(c.env, {
		userId: session.uid,
		existingCustomerId: row?.stripe_customer_id || undefined,
		successUrl: `${PROFILE_URL}?billing=success`,
		cancelUrl: `${PROFILE_URL}?billing=cancelled`,
	});
	if ("error" in result) throw new HttpError(503, result.error);
	return c.json({ url: result.url });
});

/** Open the Stripe Customer Portal (manage / cancel the subscription). */
billingRoutes.post("/portal", async (c) => {
	const session = await requireUser(c);
	const row = await c.env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?1")
		.bind(session.uid)
		.first<{ stripe_customer_id: string | null }>();
	if (!row?.stripe_customer_id) throw new HttpError(400, "No billing account yet — upgrade first.");
	const result = await createPortalSession(c.env, {
		customerId: row.stripe_customer_id,
		returnUrl: PROFILE_URL,
	});
	if ("error" in result) throw new HttpError(503, result.error);
	return c.json({ url: result.url });
});

/** Stripe webhook — NO auth (signature-verified). Keeps users columns in sync. */
billingRoutes.post("/webhook", async (c) => {
	if (!c.env.STRIPE_WEBHOOK_SECRET) return c.json({ error: "Webhook not configured" }, 503);
	const sig = c.req.header("stripe-signature") ?? "";
	const body = await c.req.text();
	const valid = await verifyWebhookSignature(body, sig, c.env.STRIPE_WEBHOOK_SECRET);
	if (!valid) return c.json({ error: "Invalid signature" }, 401);
	const event = JSON.parse(body) as { type: string; data: { object: Record<string, unknown> } };
	await handleStripeEvent(c.env.DB, event);
	return c.json({ received: true });
});
