/**
 * Stripe billing — the $9/mo ProAgentStore Pro subscription, per USER.
 *
 * Vendored from pws/platform packages/worker/src/billing.ts (raw Stripe REST —
 * no SDK, ~200KB smaller; Workers-native HMAC webhook verification), adapted
 * from per-site to per-user: subscription state lives on the THREE `users`
 * columns that have existed since migration 0001 (stripe_customer_id,
 * subscription_status, subscription_expires_at).
 *
 * Entitlement: admins are always Pro (operator comp). Gates only enforce when
 * PAYWALL_ENFORCE is "1"/"true" — the soft-launch switch.
 */
import { HttpError } from "./auth.js";
import type { Env, SessionPayload } from "../types.js";

const STRIPE_API = "https://api.stripe.com/v1";

const UPGRADE_MESSAGE =
	"This feature requires ProAgentStore Pro ($9/mo). Upgrade at https://proagentstore.online/console/profile";

async function stripePost(
	env: Env,
	path: string,
	params: Record<string, string>,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
	const res = await fetch(`${STRIPE_API}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(params),
	});
	return { ok: res.ok, data: await parseStripeJson(res, path) };
}

/** Parse a Stripe response body as JSON, tolerating a non-JSON error page (e.g.
 *  a 5xx HTML page) instead of throwing — a throw here would crash a webhook
 *  handler into Stripe's multi-day retry loop. */
async function parseStripeJson(res: Response, path: string): Promise<Record<string, unknown>> {
	try {
		return (await res.json()) as Record<string, unknown>;
	} catch (e) {
		console.error("[stripe] non-JSON response", {
			path,
			status: res.status,
			err: e instanceof Error ? e.message : String(e),
		});
		return {};
	}
}

/** Create a Stripe Checkout Session for a new Pro subscription. No customer_email:
 *  PAGS users have no stored email (GitHub/Google ids) — Checkout collects it. */
export async function createCheckoutSession(
	env: Env,
	opts: { userId: string; existingCustomerId?: string; successUrl: string; cancelUrl: string },
): Promise<{ url: string } | { error: string }> {
	if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
		return { error: "Billing is not configured." };
	}
	const params: Record<string, string> = {
		mode: "subscription",
		"line_items[0][price]": env.STRIPE_PRICE_ID,
		"line_items[0][quantity]": "1",
		success_url: opts.successUrl,
		cancel_url: opts.cancelUrl,
		// user_id on BOTH the session and the subscription, so every
		// customer.subscription.* webhook payload can be mapped back to the user.
		"metadata[user_id]": opts.userId,
		"subscription_data[metadata][user_id]": opts.userId,
	};
	// Reuse existing Stripe customer to avoid duplicates on re-subscribe.
	if (opts.existingCustomerId) params.customer = opts.existingCustomerId;

	const { ok, data } = await stripePost(env, "/checkout/sessions", params);
	if (!ok || !data.url) {
		return {
			error: (data.error as { message?: string })?.message ?? "Failed to create checkout session.",
		};
	}
	return { url: data.url as string };
}

/** Create a Stripe Customer Portal session for managing/cancelling the subscription. */
export async function createPortalSession(
	env: Env,
	opts: { customerId: string; returnUrl: string },
): Promise<{ url: string } | { error: string }> {
	if (!env.STRIPE_SECRET_KEY) return { error: "Billing is not configured." };
	const { ok, data } = await stripePost(env, "/billing_portal/sessions", {
		customer: opts.customerId,
		return_url: opts.returnUrl,
	});
	if (!ok || !data.url) {
		return {
			error: (data.error as { message?: string })?.message ?? "Failed to create portal session.",
		};
	}
	return { url: data.url as string };
}

/** Verify a Stripe webhook signature (HMAC-SHA256). Vendored verbatim from PWS. */
export async function verifyWebhookSignature(
	payload: string,
	sigHeader: string,
	secret: string,
): Promise<boolean> {
	// Parse Stripe-Signature header: t=timestamp,v1=signature. During a webhook
	// secret rotation the header carries MULTIPLE v1= signatures (one per active
	// secret) — collect them all and accept if any matches, otherwise legitimate
	// events are dropped for the rotation window.
	const parts = sigHeader.split(",");
	let timestamp = "";
	const signatures: string[] = [];
	for (const part of parts) {
		const [key, value] = part.split("=");
		if (key === "t") timestamp = value ?? "";
		if (key === "v1" && value) signatures.push(value);
	}
	if (!timestamp || signatures.length === 0) return false;

	// Check timestamp tolerance (5 minutes)
	const age = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (age > 300) return false;

	// Compute expected signature
	const signedPayload = `${timestamp}.${payload}`;
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
	const expected = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");

	// Constant-time comparison against each candidate signature.
	for (const signature of signatures) {
		if (expected.length !== signature.length) continue;
		let diff = 0;
		for (let i = 0; i < expected.length; i++) {
			diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
		}
		if (diff === 0) return true;
	}
	return false;
}

/** Is the subscription usable right now? Vendored from PWS: active/trialing yes;
 *  past_due yes (Stripe dunning ~2 weeks — don't punish a transient decline);
 *  canceled keeps access until the paid period ends (grace). */
export function isSubscriptionActive(
	sub: { status: string; current_period_end: number | null } | null,
): boolean {
	if (!sub) return false;
	if (sub.status === "active" || sub.status === "trialing") return true;
	if (sub.status === "past_due") return true;
	if (
		sub.status === "canceled" &&
		sub.current_period_end &&
		sub.current_period_end * 1000 > Date.now()
	) {
		return true;
	}
	return false;
}

/** Bridge the users row (ISO TEXT expiry) to isSubscriptionActive's epoch-seconds shape. */
export function subFromUserRow(
	row: { subscription_status?: string | null; subscription_expires_at?: string | null } | null,
): { status: string; current_period_end: number | null } | null {
	if (!row) return null;
	const expires = row.subscription_expires_at ? Date.parse(row.subscription_expires_at) : NaN;
	return {
		status: row.subscription_status || "none",
		current_period_end: Number.isFinite(expires) ? Math.floor(expires / 1000) : null,
	};
}

/** Soft-launch switch: gates only enforce when PAYWALL_ENFORCE is "1"/"true". */
export function isPaywallEnforced(env: Env): boolean {
	return env.PAYWALL_ENFORCE === "1" || env.PAYWALL_ENFORCE === "true";
}

/** Pro entitlement: admins are always entitled (operator comp, no DB read);
 *  everyone else needs a usable subscription on their users row. */
export async function isEntitled(env: Env, session: SessionPayload): Promise<boolean> {
	if (session.roles.includes("admin")) return true;
	const row = await env.DB.prepare(
		"SELECT subscription_status, subscription_expires_at FROM users WHERE id = ?1",
	)
		.bind(session.uid)
		.first<{ subscription_status: string | null; subscription_expires_at: string | null }>();
	return isSubscriptionActive(subFromUserRow(row));
}

/** Gate a Pro-only route. No-op unless the paywall is enforced. */
export async function requirePro(env: Env, session: SessionPayload): Promise<void> {
	if (!isPaywallEnforced(env)) return;
	if (!(await isEntitled(env, session))) throw new HttpError(402, UPGRADE_MESSAGE);
}

/** Instance cap for a user: free tier 2, Pro (or unenforced) the 100 fair-use cap. */
export function instanceCapFor(entitled: boolean, enforced: boolean): number {
	return enforced && !entitled ? 2 : 100;
}

/**
 * Apply a verified Stripe event to the users table. Idempotent (plain UPDATEs) —
 * Stripe redelivers events. Mapping:
 * - checkout.session.completed (subscription, paid) → customer id + active, by metadata.user_id
 * - customer.subscription.created/updated/deleted → raw status + period end; by
 *   metadata.user_id (set via subscription_data), else by stripe_customer_id
 * - invoice.payment_failed → past_due, by stripe_customer_id (invoices carry no sub metadata)
 */
export async function handleStripeEvent(
	db: D1Database,
	event: { type: string; data: { object: Record<string, unknown> } },
): Promise<void> {
	const obj = event.data.object;
	switch (event.type) {
		case "checkout.session.completed": {
			if (obj.mode !== "subscription") return;
			// Async payment methods complete later — subscription events cover those.
			if (obj.payment_status === "unpaid") return;
			const userId = (obj.metadata as Record<string, unknown> | undefined)?.user_id;
			const customer = typeof obj.customer === "string" ? obj.customer : null;
			if (typeof userId !== "string" || !userId || !customer) return;
			await db
				.prepare(
					"UPDATE users SET stripe_customer_id = ?1, subscription_status = 'active', subscription_expires_at = NULL, updated_at = datetime('now') WHERE id = ?2",
				)
				.bind(customer, userId)
				.run();
			return;
		}
		case "customer.subscription.created":
		case "customer.subscription.updated":
		case "customer.subscription.deleted": {
			const status = typeof obj.status === "string" ? obj.status : "canceled";
			// current_period_end moved from the subscription to its items on newer
			// Stripe API versions — read both.
			const items = obj.items as { data?: Array<{ current_period_end?: number }> } | undefined;
			const periodEnd =
				typeof obj.current_period_end === "number"
					? obj.current_period_end
					: items?.data?.[0]?.current_period_end ?? null;
			const expiresAt = typeof periodEnd === "number" ? new Date(periodEnd * 1000).toISOString() : null;
			const customer = typeof obj.customer === "string" ? obj.customer : null;
			const userId = (obj.metadata as Record<string, unknown> | undefined)?.user_id;
			if (typeof userId === "string" && userId) {
				await db
					.prepare(
						"UPDATE users SET stripe_customer_id = COALESCE(?1, stripe_customer_id), subscription_status = ?2, subscription_expires_at = ?3, updated_at = datetime('now') WHERE id = ?4",
					)
					.bind(customer, status, expiresAt, userId)
					.run();
			} else if (customer) {
				// Portal-driven or dashboard-created subs may lack our metadata.
				await db
					.prepare(
						"UPDATE users SET subscription_status = ?1, subscription_expires_at = ?2, updated_at = datetime('now') WHERE stripe_customer_id = ?3",
					)
					.bind(status, expiresAt, customer)
					.run();
			}
			return;
		}
		case "invoice.payment_failed": {
			const customer = typeof obj.customer === "string" ? obj.customer : null;
			if (!customer) return;
			await db
				.prepare(
					"UPDATE users SET subscription_status = 'past_due', updated_at = datetime('now') WHERE stripe_customer_id = ?1",
				)
				.bind(customer)
				.run();
			return;
		}
		default:
			return; // unhandled event types are fine — endpoint subscribes narrowly anyway
	}
}
