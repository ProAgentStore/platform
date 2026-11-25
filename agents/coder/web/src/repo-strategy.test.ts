import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, repoStrategy, STRATEGY_KEEP_NOTE, STRATEGY_OPTIONS, strategyOption } from "./repo-strategy";

describe("repo checkout preset (#1710)", () => {
	it("offers exactly the three presets, default first", () => {
		expect(STRATEGY_OPTIONS.map((o) => o.value)).toEqual(["shared-direct", "isolated-direct", "isolated-pr"]);
		expect(DEFAULT_STRATEGY).toBe("shared-direct");
	});

	it("an absent or unknown value is the default, a known one is itself", () => {
		expect(repoStrategy({})).toBe("shared-direct");
		expect(repoStrategy({ effectiveStrategy: "bogus" })).toBe("shared-direct");
		expect(repoStrategy({ effectiveStrategy: "isolated-pr" })).toBe("isolated-pr");
		expect(strategyOption("isolated-direct").short).toBe("Isolated · direct");
	});

	it("says direct-to-main repos stay as they are", () => {
		expect(STRATEGY_KEEP_NOTE).toMatch(/straight to main stay as they are/);
	});
});

describe("wiring (asserted on source, like repo-settings-modal.test.ts)", () => {
	const modal = readFileSync(join(import.meta.dirname, "RepoSettingsModal.tsx"), "utf8");
	const list = readFileSync(join(import.meta.dirname, "ReposList.tsx"), "utf8");

	it("the sheet saves the preset through the existing owner PUT, only when changed", () => {
		expect(modal).toContain('id="repo-settings-strategy"');
		expect(modal).toMatch(/strategy !== repoStrategy\(repo\)/);
		expect(modal).toContain("STRATEGY_KEEP_NOTE");
	});

	it("the repo card shows the preset", () => {
		expect(list).toContain("repo-strategy-");
	});
});
