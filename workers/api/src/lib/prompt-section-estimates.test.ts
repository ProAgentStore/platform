import { afterEach, describe, expect, it, vi } from "vitest";
import { estimatePromptSections, logPromptSectionEstimates } from "./prompt-section-estimates.js";
import type { Env } from "../types.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("prompt section estimates", () => {
	it("estimates bytes and rough token counts without model calls", () => {
		expect(estimatePromptSections([
			{ label: "empty", value: "" },
			{ label: "short", value: "abcd" },
			{ label: "object", value: { a: "bc" } },
		])).toEqual([
			{ label: "short", bytes: 4, estimatedTokens: 1 },
			{ label: "object", bytes: 10, estimatedTokens: 3 },
		]);
	});

	it("logs only labels and sizes, not prompt text", async () => {
		vi.spyOn(Math, "random").mockReturnValue(1);
		const binds: unknown[][] = [];
		const env = {
			DB: {
				prepare() {
					return {
						bind(...args: unknown[]) {
							binds.push(args);
							return { run: async () => ({ success: true }) };
						},
					};
				},
			},
		} as unknown as Pick<Env, "DB">;

		await logPromptSectionEstimates(env, {
			userId: "u1",
			instanceId: "i1",
			traceId: "t1",
			source: "coding",
			kind: "coding",
			model: "claude-sonnet-4-6",
			phase: "pilot_decide",
			sections: [{ label: "secret", value: "the literal secret prompt text" }],
		});

		expect(binds).toHaveLength(1);
		const context = JSON.parse(binds[0][9] as string) as Record<string, unknown>;
		expect(JSON.stringify(context)).not.toContain("literal secret");
		expect(context).toMatchObject({
			kind: "coding",
			model: "claude-sonnet-4-6",
			phase: "pilot_decide",
			totalBytes: 30,
			totalEstimatedTokens: 8,
		});
		expect(context.sections).toEqual([{ label: "secret", bytes: 30, estimatedTokens: 8 }]);
	});
});
