import { describe, expect, it, vi } from "vitest";
import type { Env, SessionPayload } from "../types.js";
import {
	handleStripeEvent,
	instanceCapFor,
	isEntitled,
	isPaywallEnforced,
	isSubscriptionActive,
	requirePro,
	subFromUserRow,
	verifyWebhookSignature,
} from "./billing.js";

// ── Subscription state machine (vendored PWS cases) ─────────────────────────

describe("isSubscriptionActive", () => {
	it("false for null", () => {
		expect(isSubscriptionActive(null)).toBe(false);
	});
	it("true for active / trialing", () => {
		expect(isSubscriptionActive({ status: "active", current_period_end: null })).toBe(true);
		expect(isSubscriptionActive({ status: "trialing", current_period_end: null })).toBe(true);
	});
	it("true for past_due (Stripe dunning — don't punish a transient decline)", () => {
		expect(isSubscriptionActive({ status: "past_due", current_period_end: null })).toBe(true);
	});
	it("canceled: true within the paid period (grace), false after", () => {
		const future = Math.floor(Date.now() / 1000) + 86_400;
		const past = Math.floor(Date.now() / 1000) - 86_400;
		expect(isSubscriptionActive({ status: "canceled", current_period_end: future })).toBe(true);
		expect(isSubscriptionActive({ status: "canceled", current_period_end: past })).toBe(false);
		expect(isSubscriptionActive({ status: "canceled", current_period_end: null })).toBe(false);
	});
	it("false for unpaid / none / incomplete", () => {
		for (const status of ["unpaid", "none", "incomplete"]) {
			expect(isSubscriptionActive({ status, current_period_end: null })).toBe(false);
		}
	});
});

describe("subFromUserRow", () => {
	it("bridges the ISO expiry column to epoch seconds", () => {
		const iso = new Date(1_800_000_000_000).toISOString();
		expect(subFromUserRow({ subscription_status: "canceled", subscription_expires_at: iso }))
			.toEqual({ status: "canceled", current_period_end: 1_800_000_000 });
	});
	it("null row → null; missing fields default safely", () => {
		expect(subFromUserRow(null)).toBeNull();
		expect(subFromUserRow({})).toEqual({ status: "none", current_period_end: null });
	});
});

// ── Webhook signature (vendored PWS cases + real HMAC vector) ────────────────

describe("verifyWebhookSignature", () => {
	it("rejects missing signature parts", async () => {
		expect(await verifyWebhookSignature("payload", "", "secret")).toBe(false);
	});

	it("rejects an expired timestamp (>5 min)", async () => {
		const old = Math.floor(Date.now() / 1000) - 600;
		expect(await verifyWebhookSignature("payload", `t=${old},v1=deadbeef`, "secret")).toBe(false);
	});

	const sign = async (payload: string, ts: number, secret: string) => {
		const enc = new TextEncoder();
		const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${payload}`));
		return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
	};

	it("accepts a valid signature", async () => {
		const ts = Math.floor(Date.now() / 1000);
		const payload = '{"test":true}';
		const hex = await sign(payload, ts, "whsec_test");
		expect(await verifyWebhookSignature(payload, `t=${ts},v1=${hex}`, "whsec_test")).toBe(true);
	});

	it("rejects a wrong signature but accepts among multiple v1s (secret rotation)", async () => {
		const ts = Math.floor(Date.now() / 1000);
		const payload = '{"test":true}';
		const hex = await sign(payload, ts, "whsec_new");
		expect(await verifyWebhookSignature(payload, `t=${ts},v1=${"0".repeat(64)}`, "whsec_new")).toBe(false);
		expect(await verifyWebhookSignature(payload, `t=${ts},v1=${"0".repeat(64)},v1=${hex}`, "whsec_new")).toBe(true);
	});
});

// ── Webhook → users-columns mapping ──────────────────────────────────────────

/** Minimal D1 mock recording prepared SQL + bound params. */
function mockD1() {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const db = {
		prepare: vi.fn((sql: string) => ({
			bind: (...params: unknown[]) => ({
				run: async () => {
					calls.push({ sql, params });
					return { success: true };
				},
				first: async () => null,
			}),
		})),
	} as unknown as D1Database;
	return { db, calls };
}

describe("handleStripeEvent", () => {
	it("checkout.session.completed (subscription, paid) → customer + active by user_id", async () => {
		const { db, calls } = mockD1();
		await handleStripeEvent(db, {
			type: "checkout.session.completed",
			data: { object: { mode: "subscription", payment_status: "paid", customer: "cus_1", metadata: { user_id: "u1" } } },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toContain("subscription_status = 'active'");
		expect(calls[0].params).toEqual(["cus_1", "u1"]);
	});

	it("checkout.session.completed with payment_status unpaid → no write", async () => {
		const { db, calls } = mockD1();
		await handleStripeEvent(db, {
			type: "checkout.session.completed",
			data: { object: { mode: "subscription", payment_status: "unpaid", customer: "cus_1", metadata: { user_id: "u1" } } },
		});
		expect(calls).toHaveLength(0);
	});

	it("subscription.updated with metadata → raw status + ISO expiry by user_id", async () => {
		const { db, calls } = mockD1();
		await handleStripeEvent(db, {
			type: "customer.subscription.updated",
			data: { object: { status: "canceled", customer: "cus_1", current_period_end: 1_800_000_000, metadata: { user_id: "u1" } } },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toContain("WHERE id = ?4");
		expect(calls[0].params).toEqual(["cus_1", "canceled", new Date(1_800_000_000_000).toISOString(), "u1"]);
	});

	it("subscription.deleted WITHOUT metadata → fallback by stripe_customer_id", async () => {
		const { db, calls } = mockD1();
		await handleStripeEvent(db, {
			type: "customer.subscription.deleted",
			data: { object: { status: "canceled", customer: "cus_2", current_period_end: 1_800_000_000 } },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toContain("WHERE stripe_customer_id = ?3");
		expect(calls[0].params).toEqual(["canceled", new Date(1_800_000_000_000).toISOString(), "cus_2"]);
	});

	it("reads current_period_end from items.data[0] when the top-level field is absent (new Stripe API)", async () => {
		const { db, calls } = mockD1();
		await handleStripeEvent(db, {
			type: "customer.subscription.updated",
			data: { object: { status: "active", customer: "cus_1", items: { data: [{ current_period_end: 1_800_000_000 }] }, metadata: { user_id: "u1" } } },
		});
		expect(calls[0].params).toContain(new Date(1_800_000_000_000).toISOString());
	});

	it("invoice.payment_failed → past_due by customer id", async () => {
		const { db, calls } = mockD1();
		await handleStripeEvent(db, {
			type: "invoice.payment_failed",
			data: { object: { customer: "cus_3" } },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toContain("'past_due'");
		expect(calls[0].params).toEqual(["cus_3"]);
	});
});

// ── Entitlement + caps ───────────────────────────────────────────────────────

const session = (roles: string[]): SessionPayload => ({ uid: "u1", roles, iat: 0, exp: 0 });

function envWith(row: { subscription_status: string; subscription_expires_at: string | null } | null, enforce?: string): Env {
	return {
		PAYWALL_ENFORCE: enforce,
		DB: {
			prepare: () => ({ bind: () => ({ first: async () => row }) }),
		},
	} as unknown as Env;
}

describe("entitlement", () => {
	it("isPaywallEnforced only for '1'/'true'", () => {
		expect(isPaywallEnforced({ PAYWALL_ENFORCE: "1" } as Env)).toBe(true);
		expect(isPaywallEnforced({ PAYWALL_ENFORCE: "true" } as Env)).toBe(true);
		expect(isPaywallEnforced({ PAYWALL_ENFORCE: "" } as Env)).toBe(false);
		expect(isPaywallEnforced({} as Env)).toBe(false);
	});

	it("admins are always entitled — no DB read", async () => {
		const env = { DB: { prepare: () => { throw new Error("should not query"); } } } as unknown as Env;
		expect(await isEntitled(env, session(["user", "admin"]))).toBe(true);
	});

	it("non-admin entitled iff the users row has a usable subscription", async () => {
		expect(await isEntitled(envWith({ subscription_status: "active", subscription_expires_at: null }), session(["user"]))).toBe(true);
		expect(await isEntitled(envWith({ subscription_status: "none", subscription_expires_at: null }), session(["user"]))).toBe(false);
		expect(await isEntitled(envWith(null), session(["user"]))).toBe(false);
	});

	it("requirePro is a no-op when enforcement is off, throws 402 with the upgrade pointer when on", async () => {
		await expect(requirePro(envWith(null), session(["user"]))).resolves.toBeUndefined();
		await expect(requirePro(envWith(null, "1"), session(["user"]))).rejects.toMatchObject({
			status: 402,
			message: expect.stringContaining("platform access requires Pro ($5/mo)"),
		});
		// entitled user passes even when enforced
		await expect(
			requirePro(envWith({ subscription_status: "active", subscription_expires_at: null }, "1"), session(["user"])),
		).resolves.toBeUndefined();
	});

	it("instanceCapFor: unpaid+enforced = 0, otherwise effectively unlimited", () => {
		expect(instanceCapFor(false, true)).toBe(0);
		expect(instanceCapFor(true, true)).toBe(Number.MAX_SAFE_INTEGER);
		expect(instanceCapFor(false, false)).toBe(Number.MAX_SAFE_INTEGER);
	});
});
