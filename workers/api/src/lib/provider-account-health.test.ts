import { describe, expect, it } from "vitest";
import type { Env } from "../types.js";
import { providerSentenceOf, readProviderAccountHealth, VERIFY_HINT } from "./provider-account-health.js";

/** The row `recordCodingFailure` writes for the run #773 was filed on, framing and all. */
const CREDIT_MESSAGE =
	"coding run 7f3a9c12 failed (provider_credentials) at s1-decide after 0 steps: Anthropic (400): Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

function db(opts: { failure?: { message: string; context?: string; seen_at: string } | null; lastUsedAt?: string | null; throwOn?: "error_log" | "user_api_keys" }) {
	const prepared: string[] = [];
	const DB = {
		prepare(sql: string) {
			prepared.push(sql);
			return {
				bind() {
					return {
						async first() {
							if (sql.includes("FROM error_log")) {
								if (opts.throwOn === "error_log") throw new Error("D1_ERROR");
								const f = opts.failure;
								return f ? { message: f.message, context: f.context ?? null, last_context: null, seen_at: f.seen_at } : null;
							}
							if (sql.includes("FROM user_api_keys")) {
								if (opts.throwOn === "user_api_keys") throw new Error("D1_ERROR");
								return opts.lastUsedAt === undefined ? null : { last_used_at: opts.lastUsedAt };
							}
							return null;
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Pick<Env, "DB">, prepared };
}

describe("the owner's provider account, as last observed (#773)", () => {
	it("strips the run's framing and keeps the provider's sentence", () => {
		expect(providerSentenceOf(CREDIT_MESSAGE)).toBe(
			"Anthropic (400): Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
		);
		expect(providerSentenceOf("coding run 7f3a9c12 interrupted (infra_transient) at s2 after 4 steps, resumed: Durable Object reset")).toBe("Durable Object reset");
		// A message with no framing is returned whole rather than emptied.
		expect(providerSentenceOf("Anthropic (401): invalid x-api-key")).toBe("Anthropic (401): invalid x-api-key");
	});

	it("reports nothing on record as exactly that — not as healthy", async () => {
		const { env, prepared } = db({ failure: null, lastUsedAt: "2026-09-08 10:00:00" });
		const h = await readProviderAccountHealth(env, "u1");
		expect(h.state).toBe("no_failure_recorded");
		expect(h.failureClass).toBeNull();
		expect(h.lastSuccessAt).toBe("2026-09-08 10:00:00");
		expect(h.verify).toBe(VERIFY_HINT);
		// Scoped to the user and to run deaths, and filtered on the class in the row's own context.
		expect(prepared.some((sql) => sql.includes("user_id = ?1") && sql.includes("failureClass"))).toBe(true);
	});

	it("is FAILING when the newest account failure is newer than the key's last success", async () => {
		const { env } = db({ failure: { message: CREDIT_MESSAGE, seen_at: "2026-09-09 07:07:00" }, lastUsedAt: "2026-09-09 06:30:00" });
		const h = await readProviderAccountHealth(env, "u1");
		expect(h.state).toBe("failing");
		// Re-read from the sentence: the row was filed as `provider_credentials` before the split,
		// and the reader must not send the owner to the key page for an empty balance.
		expect(h.failureClass).toBe("provider_credit");
		expect(h.remedy).toContain("console.anthropic.com/settings/billing");
		expect(h.lastFailure).toMatch(/^Anthropic \(400\): Your credit balance is too low/);
		expect(h.lastFailureAt).toBe("2026-09-09 07:07:00");
	});

	it("is RECOVERED once the same key has succeeded after the failure", async () => {
		const { env } = db({ failure: { message: CREDIT_MESSAGE, seen_at: "2026-09-09 07:07:00" }, lastUsedAt: "2026-09-09 09:15:00" });
		const h = await readProviderAccountHealth(env, "u1");
		expect(h.state).toBe("recovered");
		expect(h.failureClass).toBe("provider_credit");
		expect(h.lastSuccessAt).toBe("2026-09-09 09:15:00");
	});

	it("accepts an ISO last-used stamp beside D1's space-separated one", async () => {
		const { env } = db({ failure: { message: CREDIT_MESSAGE, seen_at: "2026-09-09 07:07:00" }, lastUsedAt: "2026-09-09T09:15:00.000Z" });
		expect((await readProviderAccountHealth(env, "u1")).state).toBe("recovered");
	});

	it("a key that has never succeeded stays failing", async () => {
		const { env } = db({ failure: { message: CREDIT_MESSAGE, seen_at: "2026-09-09 07:07:00" }, lastUsedAt: null });
		expect((await readProviderAccountHealth(env, "u1")).state).toBe("failing");
	});

	it("keeps an invalid key as the OTHER class, with the key-page remedy", async () => {
		const { env } = db({
			failure: { message: "coding run 1a2b3c4d failed (provider_credentials) at s1-decide after 0 steps: Anthropic (401): invalid x-api-key — Invalid API key. Update it in Profile → API Keys → Anthropic", seen_at: "2026-09-09 07:07:00" },
			lastUsedAt: null,
		});
		const h = await readProviderAccountHealth(env, "u1");
		expect(h.failureClass).toBe("provider_credentials");
		expect(h.remedy).not.toContain("settings/billing");
	});

	it("falls back to the context's class when the sentence alone no longer classifies", async () => {
		const { env } = db({
			failure: { message: "coding run 1a2b3c4d failed (provider_credit) at s1 after 0 steps: (message lost)", context: JSON.stringify({ failureClass: "provider_credit" }), seen_at: "2026-09-09 07:07:00" },
			lastUsedAt: null,
		});
		expect((await readProviderAccountHealth(env, "u1")).failureClass).toBe("provider_credit");
	});

	it("never throws — a D1 error on either read degrades to nothing on record", async () => {
		for (const throwOn of ["error_log", "user_api_keys"] as const) {
			const { env } = db({ failure: { message: CREDIT_MESSAGE, seen_at: "2026-09-09 07:07:00" }, lastUsedAt: "2026-09-09 06:00:00", throwOn });
			await expect(readProviderAccountHealth(env, "u1")).resolves.toMatchObject({ provider: "anthropic" });
		}
	});
});
