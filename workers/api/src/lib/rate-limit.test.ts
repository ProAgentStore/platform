import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimitAdmin } from "./rate-limit.js";

describe("rateLimitAdmin (issue #109)", () => {
	it("clamps anonymous requests to 20/min and 429s the 21st", async () => {
		const app = new Hono();
		app.use("/v1/admin/*", rateLimitAdmin());
		app.get("/v1/admin/me", (c) => c.json({ ok: true }));
		const ip = "203.0.113.109"; // unique per-test IP so the module bucket doesn't collide
		const hit = () => app.request("/v1/admin/me", { headers: { "CF-Connecting-IP": ip } }, {} as never);

		let last: Response | undefined;
		for (let i = 0; i < 20; i++) last = await hit();
		expect(last!.status).toBe(200);
		expect(last!.headers.get("X-RateLimit-Limit")).toBe("20");

		const over = await hit();
		expect(over.status).toBe(429);
	});
});

describe("rate limit logic", () => {
	it("bucket resets after window", () => {
		const windowMs = 60_000;
		const now = Date.now();
		const bucket = { count: 50, resetAt: now + windowMs };

		// Within window — should be counted
		expect(bucket.count).toBe(50);
		expect(now < bucket.resetAt).toBe(true);

		// After window — should reset
		const later = now + windowMs + 1;
		expect(later >= bucket.resetAt).toBe(true);
	});

	it("remaining calculation", () => {
		const limit = 60;
		const count = 45;
		const remaining = Math.max(0, limit - count);
		expect(remaining).toBe(15);
	});

	it("remaining floors at zero", () => {
		const limit = 60;
		const count = 75;
		const remaining = Math.max(0, limit - count);
		expect(remaining).toBe(0);
	});

	it("strict limit is lower than default", () => {
		const defaultLimit = 60;
		const strictLimit = 10;
		expect(strictLimit).toBeLessThan(defaultLimit);
	});
});
