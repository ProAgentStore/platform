import { describe, expect, it } from "vitest";
import type { Env } from "../types.js";
import { readInstanceConfig } from "./instances-apply.js";

/** Minimal DB stub: prepare().bind().first() resolves to the given row. */
function envWithConfig(row: { config: string } | null): Env {
	return {
		DB: {
			prepare: () => ({ bind: () => ({ first: async () => row }) }),
		},
	} as unknown as Env;
}

describe("readInstanceConfig", () => {
	it("parses valid JSON config", async () => {
		const cfg = await readInstanceConfig(envWithConfig({ config: '{"specialInstructions":"be terse","x":1}' }), "i1", "u1");
		expect(cfg.specialInstructions).toBe("be terse");
		expect(cfg.x).toBe(1);
	});

	it("returns {} for malformed JSON (never throws)", async () => {
		const cfg = await readInstanceConfig(envWithConfig({ config: "{not json" }), "i1", "u1");
		expect(cfg).toEqual({});
	});

	it("returns {} when the instance has no row", async () => {
		expect(await readInstanceConfig(envWithConfig(null), "i1", "u1")).toEqual({});
	});

	it("returns {} for an empty config string", async () => {
		expect(await readInstanceConfig(envWithConfig({ config: "" }), "i1", "u1")).toEqual({});
	});
});
