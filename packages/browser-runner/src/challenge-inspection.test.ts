import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { detectHumanChallenge } from "./challenge.js";

// Invariant: an unreadable page cannot prove that an owner challenge was solved.
describe("challenge inspection failures", () => {
	function page(count = vi.fn().mockResolvedValue(0), evaluate = vi.fn().mockResolvedValue(false)): Page {
		return { locator: () => ({ count }), evaluate } as unknown as Page;
	}
	it("propagates a failed widget lookup instead of reporting no challenge", async () => {
		await expect(detectHumanChallenge(page(vi.fn().mockRejectedValue(new Error("frame detached"))))).rejects.toThrow("frame detached");
	});
	it("propagates a failed page evaluation instead of reporting no challenge", async () => {
		await expect(detectHumanChallenge(page(undefined, vi.fn().mockRejectedValue(new Error("context destroyed"))))).rejects.toThrow("context destroyed");
	});
	it("reports no challenge only after successful DOM inspection", async () => {
		await expect(detectHumanChallenge(page())).resolves.toBeNull();
	});
	it("still reports a detected widget without requiring later probes", async () => {
		await expect(detectHumanChallenge(page(vi.fn().mockResolvedValue(1)))).resolves.toBe("hcaptcha");
	});
});
