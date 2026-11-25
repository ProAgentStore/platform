import { describe, expect, it } from "vitest";
import { parseStrategy, resolveRepoStrategy, sanitizeStrategy, STRATEGY_PRESETS, strategyForRunner } from "./checkout-strategy.js";
import { toRepo, type RepoRow } from "./coding-store.js";

describe("checkout strategy vocabulary (#1670)", () => {
	it("nothing stored resolves to shared/direct — no existing repository changes workflow", () => {
		for (const raw of [undefined, null, "", "garbage", "shared-pr", "toString", "__proto__"]) {
			expect(parseStrategy(raw)).toBeUndefined();
		}
		expect(resolveRepoStrategy(undefined)).toEqual({ checkout: "shared", publish: "direct" });
	});

	it("offers exactly the three presets and resolves each", () => {
		expect(Object.keys(STRATEGY_PRESETS).sort()).toEqual(["isolated-direct", "isolated-pr", "shared-direct"]);
		expect(resolveRepoStrategy("isolated-pr")).toEqual({ checkout: "worktree", publish: "pr" });
		expect(resolveRepoStrategy("isolated-direct")).toEqual({ checkout: "worktree", publish: "direct" });
	});

	it("the door accepts a preset or null and refuses everything else", () => {
		expect(sanitizeStrategy("isolated-direct")).toEqual({ ok: true, value: "isolated-direct" });
		expect(sanitizeStrategy(null)).toEqual({ ok: true, value: null });
		for (const bad of ["pr", "shared-pr", 1, {}, "hasOwnProperty"]) expect(sanitizeStrategy(bad).ok).toBe(false);
	});

	it("a repo row with no strategy column value reads as undefined, never as PR", () => {
		const row = { id: "r", instance_id: "i", user_id: "u", name: "n", branch: "", clone_status: "ready", workdir: "/x", created_at: "", updated_at: "" } as unknown as RepoRow;
		expect(toRepo(row).strategy).toBeUndefined();
		expect(toRepo({ ...row, strategy: "isolated-pr" }).strategy).toBe("isolated-pr");
	});
});

describe("what the runner is told at start (#1708)", () => {
	it("only an isolated preset is sent; unset and shared/direct send nothing, so an older runner and every existing repo see today's request", () => {
		expect(strategyForRunner(undefined)).toBeUndefined();
		expect(strategyForRunner("shared-direct")).toBeUndefined();
		expect(strategyForRunner("isolated-direct")).toBe("isolated-direct");
		expect(strategyForRunner("isolated-pr")).toBe("isolated-pr");
	});
});
