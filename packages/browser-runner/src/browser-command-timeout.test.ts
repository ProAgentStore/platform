import { describe, expect, it } from "vitest";
import { McpRuntime } from "./mcp-runtime.js";

describe("native command deadline configuration", () => {
	it("accepts the default and maximum seconds without an invalid transport deadline", () => {
		const runtime = new McpRuntime();
		for (const seconds of [1, 600, 3600]) expect(() => runtime.configureCommandTimeout(seconds)).not.toThrow();
		for (const seconds of [0, 3601, 1.5, NaN, Infinity]) expect(() => runtime.configureCommandTimeout(seconds)).toThrow("1–3600");
	});
	it("cannot replace execution deadlines across an owner pause fence", async () => {
		const runtime = new McpRuntime();
		await runtime.suspendDispatch();
		expect(() => runtime.configureCommandTimeout(600)).toThrow("active or uncertain");
	});
});
