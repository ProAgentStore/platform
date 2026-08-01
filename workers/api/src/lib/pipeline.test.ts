import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the tool registry so schema validation (getRegistryTool) + step dispatch
// (runRegistryTool) are controllable without real connectors. A couple of fake tools:
//  - "geocode": returns a JSON object {lat,lng}
//  - "places": returns a JSON array of results
//  - "reachable": echoes its input so we can assert threaded/fan-out inputs
const KNOWN = new Set(["geocode", "places", "reachable", "noop"]);
const runRegistryTool = vi.fn();
vi.mock("./tool-registry.js", () => ({
	getRegistryTool: (name: string) => (KNOWN.has(name) ? { name } : undefined),
	runRegistryTool: (...args: unknown[]) => runRegistryTool(...args),
}));

import { attachAudit, auditStepEntry, executePipelineStep, resolveInputs, resolveInputValue, validatePipeline, stepBind, type PipelineDef, type StepResult } from "./pipeline.js";
import type { Env } from "../types.js";

const env = {} as Env;
const ctx = { env, userId: "u1", instanceId: "i1" };

beforeEach(() => {
	runRegistryTool.mockReset();
});

describe("validatePipeline", () => {
	it("accepts a minimal valid pipeline", () => {
		const def: PipelineDef = { name: "p", steps: [{ tool: "geocode", inputs: { city: "Sydney" } }] };
		expect(validatePipeline(def)).toBeNull();
	});

	it("rejects a missing name", () => {
		expect(validatePipeline({ steps: [{ tool: "geocode" }] })).toMatch(/name is required/);
	});

	it("rejects empty steps", () => {
		expect(validatePipeline({ name: "p", steps: [] })).toMatch(/non-empty array/);
	});

	it("rejects an unknown tool", () => {
		expect(validatePipeline({ name: "p", steps: [{ tool: "does_not_exist" }] })).toMatch(/unknown tool/);
	});

	it("rejects duplicate bind names", () => {
		const def = { name: "p", steps: [{ tool: "geocode", bind: "g" }, { tool: "places", bind: "g" }] };
		expect(validatePipeline(def)).toMatch(/duplicate bind/);
	});

	it("rejects a sink without a collection", () => {
		const def = { name: "p", steps: [{ tool: "geocode" }], sink: {} };
		expect(validatePipeline(def)).toMatch(/sink.collection is required/);
	});
});

describe("resolveInputValue / resolveInputs", () => {
	const scope = { outputs: { geo: { lat: -33.8, lng: 151.2 } }, params: { city: "Sydney", radius: 5000 } };

	it("passes literals through", () => {
		expect(resolveInputValue("hi", scope)).toBe("hi");
		expect(resolveInputValue(42, scope)).toBe(42);
	});

	it("resolves $param", () => {
		expect(resolveInputValue({ $param: "city" }, scope)).toBe("Sydney");
	});

	it("resolves $ref with a dotted path", () => {
		expect(resolveInputValue({ $ref: "geo.lat" }, scope)).toBe(-33.8);
	});

	it("resolves nested objects + arrays recursively", () => {
		const out = resolveInputs({ center: { lat: { $ref: "geo.lat" }, lng: { $ref: "geo.lng" } }, tags: [{ $param: "city" }, "fixed"] }, scope);
		expect(out).toEqual({ center: { lat: -33.8, lng: 151.2 }, tags: ["Sydney", "fixed"] });
	});

	it("resolves $param:item to the fan-out item", () => {
		expect(resolveInputValue({ $param: "item" }, { ...scope, item: { n: 1 } })).toEqual({ n: 1 });
	});
});

describe("executePipelineStep — dispatches via runRegistryTool + threads outputs", () => {
	it("dispatches the tool through runRegistryTool with resolved inputs", async () => {
		runRegistryTool.mockResolvedValue({ name: "geocode", content: '{"lat":-33.8,"lng":151.2}', success: true });
		const step = { tool: "geocode", inputs: { city: { $param: "city" } }, bind: "geo" };
		const res = await executePipelineStep(ctx, step, 0, {}, { city: "Sydney" });
		// dispatched through the single registry path with (name, ctx, resolvedInput)
		expect(runRegistryTool).toHaveBeenCalledWith("geocode", { env, userId: "u1", instanceId: "i1" }, { city: "Sydney" });
		// parsed JSON output threaded under the bind
		expect(res.bind).toBe("geo");
		expect(res.success).toBe(true);
		expect(res.output).toEqual({ lat: -33.8, lng: 151.2 });
	});

	it("threads a prior step's output into the next step's inputs", async () => {
		runRegistryTool.mockResolvedValue({ name: "places", content: "[]", success: true });
		const outputs = { geo: { lat: -33.8, lng: 151.2 } };
		const step = { tool: "places", inputs: { lat: { $ref: "geo.lat" }, lng: { $ref: "geo.lng" } } };
		await executePipelineStep(ctx, step, 1, outputs, {});
		expect(runRegistryTool).toHaveBeenCalledWith("places", expect.anything(), { lat: -33.8, lng: 151.2 });
	});

	it("keeps a non-JSON tool result as a raw string", async () => {
		runRegistryTool.mockResolvedValue({ name: "noop", content: "done", success: true });
		const res = await executePipelineStep(ctx, { tool: "noop" }, 0, {}, {});
		expect(res.output).toBe("done");
	});

	it("propagates a failed tool call as an unsuccessful step, carrying the reason + bind for error capture", async () => {
		runRegistryTool.mockResolvedValue({ name: "geocode", content: "boom", success: false });
		// The workflow logs this step's failure with {tool, bind, content} as debuggable context.
		const res = await executePipelineStep(ctx, { tool: "geocode", bind: "geo" }, 2, {}, {});
		expect(res.success).toBe(false);
		expect(res.tool).toBe("geocode");
		expect(res.bind).toBe("geo");
		expect(res.content).toBe("boom");
	});

	it("forEach runs the step once per array item and collects results", async () => {
		runRegistryTool
			.mockResolvedValueOnce({ name: "reachable", content: '{"ok":true}', success: true })
			.mockResolvedValueOnce({ name: "reachable", content: '{"ok":false}', success: true });
		const outputs = { sites: ["a.com", "b.com"] };
		const step = { tool: "reachable", forEach: { $ref: "sites" }, inputs: { url: { $param: "item" } }, bind: "checked" };
		const res = await executePipelineStep(ctx, step, 0, outputs, {});
		expect(runRegistryTool).toHaveBeenCalledTimes(2);
		expect(runRegistryTool).toHaveBeenNthCalledWith(1, "reachable", expect.anything(), { url: "a.com" });
		expect(runRegistryTool).toHaveBeenNthCalledWith(2, "reachable", expect.anything(), { url: "b.com" });
		expect(res.output).toEqual([{ ok: true }, { ok: false }]);
	});

	it("forEach over a non-array is a step failure", async () => {
		const res = await executePipelineStep(ctx, { tool: "reachable", forEach: { $param: "nope" } }, 0, {}, {});
		expect(res.success).toBe(false);
		expect(runRegistryTool).not.toHaveBeenCalled();
	});
});

describe("stepBind", () => {
	it("uses the explicit bind, else stepN", () => {
		expect(stepBind({ tool: "x", bind: "y" }, 3)).toBe("y");
		expect(stepBind({ tool: "x" }, 3)).toBe("step3");
	});
});

// Per-record audit capture (issue #98).
const ok = (over: Partial<StepResult> = {}): StepResult => ({ tool: "geocode", bind: "geo", success: true, content: "", output: null, ...over });

describe("auditStepEntry", () => {
	it("captures a successful step's decision with the record count", () => {
		const e = auditStepEntry({ tool: "places", bind: "results" }, 1, ok({ tool: "places", bind: "results", output: [{ a: 1 }, { a: 2 }] }));
		expect(e.step).toBe("step 1: places");
		expect(e.detail).toBe("→ results 2 record(s)");
		expect(typeof e.at).toBe("string");
	});

	it("counts a single object output as one record", () => {
		const e = auditStepEntry({ tool: "geocode" }, 0, ok({ output: { lat: 1 } }));
		expect(e.detail).toBe("→ step0 1 record(s)");
	});

	it("captures a failed step's reason instead of a count", () => {
		const e = auditStepEntry({ tool: "geocode" }, 0, ok({ success: false, content: "boom" }));
		expect(e.detail).toBe("failed step0: boom");
	});
});

describe("attachAudit", () => {
	const trail = [{ step: "input", detail: "run", at: "t0" }, { step: "step 0: geocode", detail: "→ geo 1 record(s)", at: "t1" }];

	it("attaches the trail plus a sink line onto each object record", () => {
		const out = attachAudit([{ name: "A" }, { name: "B" }], trail, "leads");
		expect(out).toHaveLength(2);
		const audit = out[0].audit as Array<Record<string, string>>;
		expect(audit).toHaveLength(3); // input + step0 + sink
		expect(audit[2].step).toBe("sink");
		expect(audit[2].detail).toBe('upserted into "leads"');
		expect(out[0].name).toBe("A"); // record data preserved
	});

	it("skips non-object records (they can't carry an audit field)", () => {
		const out = attachAudit([{ name: "A" }, null, 42, ["x"]], trail, "leads");
		expect(out).toHaveLength(1);
	});

	it("respects a record that already carries an audit array (e.g. from dedupe/upsert)", () => {
		const existing = [{ step: "prior", detail: "kept", at: "t" }];
		const out = attachAudit([{ name: "A", audit: existing }], trail, "leads");
		expect(out[0].audit).toBe(existing); // untouched
	});
});
