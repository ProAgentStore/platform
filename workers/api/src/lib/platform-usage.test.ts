import { describe, expect, it, vi } from "vitest";
import { approxTokens, estimatePlatformCostMicros, PLATFORM_CF_PRICE } from "./ai-pricing.js";
import { recordPlatformUsage } from "./usage.js";

describe("platform cost estimation (issue #44)", () => {
	it("approxTokens is ~4 chars/token, floors at 0", () => {
		expect(approxTokens(400)).toBe(100);
		expect(approxTokens(0)).toBe(0);
		expect(approxTokens(-5)).toBe(0);
		expect(approxTokens(3)).toBe(1); // rounds up
	});

	it("estimatePlatformCostMicros uses the platform rate, never negative", () => {
		expect(estimatePlatformCostMicros(1_000_000, 0)).toBe(PLATFORM_CF_PRICE.inputPerM * 1_000_000);
		expect(estimatePlatformCostMicros(0, 1_000_000)).toBe(PLATFORM_CF_PRICE.outputPerM * 1_000_000);
		expect(estimatePlatformCostMicros(-5, -5)).toBe(0);
	});
});

describe("recordPlatformUsage", () => {
	function mockDb() {
		const run = vi.fn(async () => ({}));
		const bind = vi.fn(() => ({ run }));
		const prepare = vi.fn(() => ({ bind }));
		return { db: { DB: { prepare } as any }, prepare, bind, run };
	}

	it("inserts a provider=platform row with an estimated cost", async () => {
		const m = mockDb();
		await recordPlatformUsage(
			m.db,
			{ userId: "u1", instanceId: "i1", model: "@cf/baai/bge-base-en-v1.5", kind: "embedding" },
			{ input: 100, output: 0 },
		);
		expect(m.prepare).toHaveBeenCalledOnce();
		expect(m.prepare.mock.calls[0][0]).toContain("'platform'");
		// binds: id, userId, agentId, instanceId, model, kind, input, output, cost
		const args = m.bind.mock.calls[0];
		expect(args[1]).toBe("u1");
		expect(args[3]).toBe("i1");
		expect(args[5]).toBe("embedding");
		expect(args[6]).toBe(100);
		expect(args[8]).toBe(estimatePlatformCostMicros(100, 0));
	});

	it("no-ops with no user or no tokens", async () => {
		const m = mockDb();
		await recordPlatformUsage(m.db, { userId: undefined, model: "x", kind: "summary" }, { input: 5, output: 5 });
		await recordPlatformUsage(m.db, { userId: "u1", model: "x", kind: "summary" }, { input: 0, output: 0 });
		expect(m.prepare).not.toHaveBeenCalled();
	});
});
