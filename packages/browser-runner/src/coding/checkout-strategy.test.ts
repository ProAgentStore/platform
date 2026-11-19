import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, PRESETS, presetOf, resolveStrategy, strategyProblems } from "./checkout-strategy.js";

describe("per-repository checkout and publication strategy (#1670)", () => {
	it("a repository with nothing stored keeps today's behaviour: shared checkout, direct publication", () => {
		for (const stored of [undefined, null, "", "garbage", 42, {}, { checkout: "clone", publish: "fork" }]) {
			expect(resolveStrategy(stored)).toEqual({ checkout: "shared", publish: "direct" });
		}
		expect(DEFAULT_STRATEGY).toEqual(PRESETS["shared-direct"]);
	});

	it("never turns a direct-to-main repository into a PR repository by omission or by an unknown value", () => {
		expect(resolveStrategy({ checkout: "worktree" }).publish).toBe("direct");
		expect(resolveStrategy({ publish: "squash" }).publish).toBe("direct");
		expect(resolveStrategy({ publish: "pr" }).publish).toBe("pr");
	});

	it("exposes exactly the three supported presets, each resolvable by name and by its two settings", () => {
		expect(Object.keys(PRESETS).sort()).toEqual(["isolated-direct", "isolated-pr", "shared-direct"]);
		for (const [name, s] of Object.entries(PRESETS)) {
			expect(resolveStrategy(name)).toEqual(s);
			expect(presetOf(s)).toBe(name);
			expect(strategyProblems(s)).toEqual([]);
		}
	});

	it("the two settings are independent, and the one unsupported pairing says why", () => {
		expect(strategyProblems({ checkout: "shared", publish: "pr" })[0]).toMatch(/no per-run branch/);
		expect(presetOf({ checkout: "shared", publish: "pr" })).toBeNull();
	});
});
