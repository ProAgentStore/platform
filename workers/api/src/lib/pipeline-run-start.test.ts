import { describe, expect, it, vi } from "vitest";

// A registry whose tools are all "known" so a stored def validates.
vi.mock("./tool-registry.js", () => ({
	getRegistryTool: (name: string) => ({ name }),
	runRegistryTool: vi.fn(),
}));

import { startPipelineRun } from "./pipeline-run-start.js";
import { loadPipeline } from "./pipeline.js";
import type { Env } from "../types.js";

const PIPE = { name: "leads", steps: [{ tool: "geocode", inputs: { city: { $param: "city" } } }], sink: { collection: "leads" } };

/** Env whose agent_instances row carries a config with a pipelines map. */
function envWithConfig(config: unknown, create?: (arg: unknown) => Promise<{ id: string }>): Env {
	return {
		DB: { prepare: () => ({ bind: () => ({ first: async () => (config === null ? null : { config: typeof config === "string" ? config : JSON.stringify(config) }) }) }) },
		PIPELINE_RUN: { create: create ?? (async () => ({ id: "wf-1" })) },
	} as unknown as Env;
}

describe("loadPipeline", () => {
	it("reads a named pipeline from config.pipelines", async () => {
		const def = await loadPipeline(envWithConfig({ pipelines: { leads: PIPE } }), "i1", "u1", "leads");
		expect(def?.name).toBe("leads");
	});

	it("returns null when the instance row is missing", async () => {
		expect(await loadPipeline(envWithConfig(null), "i1", "u1", "leads")).toBeNull();
	});

	it("returns null for an unknown pipeline name", async () => {
		expect(await loadPipeline(envWithConfig({ pipelines: { other: PIPE } }), "i1", "u1", "leads")).toBeNull();
	});

	it("returns null for malformed config JSON", async () => {
		expect(await loadPipeline(envWithConfig("{not json"), "i1", "u1", "leads")).toBeNull();
	});

	it("returns null for an invalid stored definition", async () => {
		expect(await loadPipeline(envWithConfig({ pipelines: { leads: { name: "leads", steps: [] } } }), "i1", "u1", "leads")).toBeNull();
	});
});

describe("startPipelineRun", () => {
	it("kicks the PIPELINE_RUN workflow with the loaded def + params", async () => {
		const create = vi.fn(async () => ({ id: "wf-42" }));
		const env = envWithConfig({ pipelines: { leads: PIPE } }, create);
		const res = await startPipelineRun(env, "i1", "u1", "leads", { city: "Sydney" }, "chat");
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.workflowId).toBe("wf-42");
			expect(res.runId).toBeTruthy();
		}
		expect(create).toHaveBeenCalledTimes(1);
		const arg = create.mock.calls[0][0] as { params: { pipeline: { name: string }; params: unknown; trigger: string; instanceId: string; userId: string } };
		expect(arg.params.pipeline.name).toBe("leads");
		expect(arg.params.params).toEqual({ city: "Sydney" });
		expect(arg.params.trigger).toBe("chat");
		expect(arg.params.instanceId).toBe("i1");
		expect(arg.params.userId).toBe("u1");
	});

	it("returns an error (does not kick) for an unknown pipeline", async () => {
		const create = vi.fn(async () => ({ id: "wf" }));
		const env = envWithConfig({ pipelines: {} }, create);
		const res = await startPipelineRun(env, "i1", "u1", "nope", {}, "api");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/No pipeline named "nope"/);
		expect(create).not.toHaveBeenCalled();
	});
});
