import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the tool registry so schema validation (getRegistryTool) + step dispatch
// (runRegistryTool) are controllable without real connectors. A couple of fake tools:
//  - "geocode": returns a JSON object {lat,lng}
//  - "places": returns a JSON array of results
//  - "reachable": echoes its input so we can assert threaded/fan-out inputs
//
// `connector` is part of the fake def because the declared-tools gate (#381) reads it: a
// connector-provided tool is declarable (and therefore gated), a connector-less one is the step
// library and is exempt. `places`/`noop` are deliberately connector-less.
//
// `dispatchesFromInput` (#396) mirrors the real `enrich`: the tool it runs per record arrives as an
// input, so what the step NAMES and what it RUNS are two different answers.
const KNOWN: Record<string, { connector?: string; dispatchesFromInput?: string }> = {
	geocode: { connector: "geo" },
	reachable: { connector: "http" },
	places: {},
	noop: {},
	enrich: { dispatchesFromInput: "tool" },
};
const runRegistryTool = vi.fn();
vi.mock("./tool-registry.js", () => ({
	getRegistryTool: (name: string) => (name in KNOWN ? { name, ...KNOWN[name] } : undefined),
	runRegistryTool: (...args: unknown[]) => runRegistryTool(...args),
}));

import { attachAudit, auditStepEntry, collectReferences, coverageShortfall, declaredParamDefaults, executePipelineStep, pipelineDefForKey, pipelineInventory, resolveInputs, resolveInputValue, stepReferenceError, validatePipeline, stepBind, type PipelineDef, type StepResult } from "./pipeline.js";
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

// ── #244 ────────────────────────────────────────────────────────────────────────
// `readPath` returns undefined the instant a segment is missing, and handlers treat absent as
// DEFAULT (`asArray(undefined)` → [], `Number(undefined) || 0` → 0). So a one-character typo
// produced a pipeline where every step succeeded, the run completed, and the data was empty —
// no failed step, no error row, nothing to notice. Every case below returned null (valid)
// before the fix and would have run to a silent, wrong completion.
describe("collectReferences", () => {
	it("finds references nested anywhere in an input tree", () => {
		const refs = collectReferences({
			url: "https://x",
			body: { circle: { center: { lat: { $param: "item.lat" } } }, ids: [{ $ref: "geo.id" }] },
		});
		expect(refs).toEqual([
			{ kind: "param", name: "item.lat", root: "item" },
			{ kind: "ref", name: "geo.id", root: "geo" },
		]);
	});

	it("mirrors resolveInputValue: $param wins over $ref on an object carrying both", () => {
		// If this ever diverges, validation would police a reference the runner never resolves.
		const both = { $param: "city", $ref: "geo.lat" };
		expect(collectReferences(both)).toEqual([{ kind: "param", name: "city", root: "city" }]);
		expect(resolveInputValue(both as never, { outputs: { geo: { lat: 1 } }, params: { city: "Sydney" } })).toBe("Sydney");
	});

	it("ignores $item, which the enrich step substitutes per record, not the resolver", () => {
		expect(collectReferences({ url: { $item: "website_url" } })).toEqual([]);
	});
});

describe("validatePipeline — reference checking", () => {
	it("rejects a $ref to a bind that does not exist (the one-character typo)", () => {
		const def = {
			name: "p",
			steps: [
				{ tool: "geocode", bind: "geocode" },
				{ tool: "places", inputs: { lat: { $ref: "geo.lat" } } },
			],
		};
		expect(validatePipeline(def)).toMatch(/Step 1: \$ref "geo\.lat" reads "geo"/);
		expect(validatePipeline(def)).toContain("geocode"); // tells the author what IS available
	});

	it("rejects a FORWARD $ref — steps run in order, so a later bind does not exist yet", () => {
		const def = {
			name: "p",
			steps: [
				{ tool: "geocode", inputs: { items: { $ref: "later.items" } } },
				{ tool: "places", bind: "later" },
			],
		};
		expect(validatePipeline(def)).toMatch(/Step 0: \$ref "later\.items"/);
	});

	it("rejects a step that reads its OWN bind", () => {
		const def = { name: "p", steps: [{ tool: "geocode", bind: "g", inputs: { x: { $ref: "g.y" } } }] };
		expect(validatePipeline(def)).toMatch(/Step 0/);
	});

	it("checks the forEach reference too, not just inputs", () => {
		const def = { name: "p", steps: [{ tool: "places", forEach: { $ref: "grid.cells" } }] };
		expect(validatePipeline(def)).toMatch(/\$ref "grid\.cells"/);
	});

	it("accepts the IMPLICIT bind — stepBind defaults to step{index}", () => {
		const def = {
			name: "p",
			steps: [{ tool: "geocode" }, { tool: "places", inputs: { lat: { $ref: "step0.lat" } } }],
		};
		expect(validatePipeline(def)).toBeNull();
		expect(stepBind(def.steps[0], 0)).toBe("step0");
	});

	it("accepts a deep path off a known bind — only the ROOT is knowable ahead of time", () => {
		const def = {
			name: "p",
			steps: [{ tool: "geocode", bind: "geo" }, { tool: "places", inputs: { x: { $ref: "geo.a.b.c.0" } } }],
		};
		expect(validatePipeline(def)).toBeNull();
	});

	it("rejects an undeclared $param when the pipeline declares its params", () => {
		const def = {
			name: "p",
			params: { city: { type: "string" } },
			steps: [{ tool: "geocode", inputs: { address: { $param: "citty" } } }],
		};
		expect(validatePipeline(def)).toMatch(/\$param "citty" is not declared/);
	});

	it("still accepts $param on a def that declares NO params — it isn't asserting a complete set", () => {
		// `params` is optional and predates this check; a def that declares none is not making a
		// claim about them, so tightening there would invalidate stored defs rather than find bugs.
		const def = { name: "p", steps: [{ tool: "geocode", inputs: { address: { $param: "city" } } }] };
		expect(validatePipeline(def)).toBeNull();
	});

	it("accepts item / item.* inside a forEach body — scope-provided, not a param", () => {
		const def = {
			name: "p",
			params: { type: { type: "string" } },
			steps: [
				{ tool: "geocode", bind: "grid" },
				{
					tool: "places",
					forEach: { $ref: "grid.cells" },
					inputs: { lat: { $param: "item.lat" }, whole: { $param: "item" }, kind: { $param: "type" } },
				},
			],
		};
		expect(validatePipeline(def)).toBeNull();
	});

	it("does NOT excuse item outside a forEach body", () => {
		const def = {
			name: "p",
			params: { city: { type: "string" } },
			steps: [{ tool: "geocode", inputs: { lat: { $param: "item.lat" } } }],
		};
		expect(validatePipeline(def)).toMatch(/\$param "item\.lat" is not declared/);
	});
});

describe("stepReferenceError", () => {
	it("is pure — the same step and known-name sets always give the same answer", () => {
		const step = { tool: "places", inputs: { x: { $ref: "geo.lat" } } };
		expect(stepReferenceError(step, 1, new Set(["geo"]), null)).toBeNull();
		expect(stepReferenceError(step, 1, new Set(), null)).toMatch(/it is the first step/);
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

	it("resolves $param:'item.<path>' to a dotted field of the fan-out item (#114)", () => {
		const s = { ...scope, item: { lat: -33.9, lng: 151.1, websiteUri: "https://x.example" } };
		expect(resolveInputValue({ $param: "item.lat" }, s)).toBe(-33.9);
		expect(resolveInputValue({ $param: "item.websiteUri" }, s)).toBe("https://x.example");
		// whole item still works, and a nested dotted path resolves too.
		expect(resolveInputValue({ $param: "item" }, s)).toEqual(s.item);
		const nested = { ...scope, item: { location: { lat: 1, lng: 2 } } };
		expect(resolveInputValue({ $param: "item.location.lng" }, nested)).toBe(2);
	});

	it("$param:'item.<path>' is undefined when there is no item scope (backward compatible)", () => {
		// Outside a forEach body, `item.foo` is just a (missing) param name — never crashes.
		expect(resolveInputValue({ $param: "item.lat" }, scope)).toBeUndefined();
	});
});

describe("executePipelineStep — dispatches via runRegistryTool + threads outputs", () => {
	it("dispatches the tool through runRegistryTool with resolved inputs", async () => {
		runRegistryTool.mockResolvedValue({ name: "geocode", content: '{"lat":-33.8,"lng":151.2}', success: true });
		const step = { tool: "geocode", inputs: { city: { $param: "city" } }, bind: "geo" };
		const res = await executePipelineStep(ctx, step, 0, {}, { city: "Sydney" });
		// dispatched through the single registry path with (name, ctx, resolvedInput)
		expect(runRegistryTool).toHaveBeenCalledWith("geocode", expect.objectContaining({ env, userId: "u1", instanceId: "i1" }), { city: "Sydney" });
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

// ── #381 ────────────────────────────────────────────────────────────────────────
// `runRegistryTool` enforces connector scope and write consent, neither of which asks whether
// the tool belongs to this agent. So before this a stored pipeline could dispatch any tool in
// the registry — including one the same instance's own /tools listing marks `not_declared`.
describe("executePipelineStep — the declared-tools gate (#381)", () => {
	// `geocode` is connector-provided in this file's fake registry, so it is declarable and gated;
	// `places` has no connector, so it is step-library-shaped and exempt.
	const scoped = { ...ctx, declaredTools: ["reachable"] };

	it("refuses an undeclared tool WITHOUT dispatching it", async () => {
		const res = await executePipelineStep(scoped, { tool: "geocode", bind: "geo" }, 0, {}, {});
		expect(runRegistryTool).not.toHaveBeenCalled();
		expect(res.success).toBe(false);
		expect(res.bind).toBe("geo");
		expect(res.content).toMatch(/not one of this agent's tools/);
		expect(res.output).toBeNull();
	});

	it("refuses an undeclared fan-out ONCE, not once per item", async () => {
		// `runRegistryTool` would refuse each call anyway; short-circuiting the step is what stops a
		// 200-item forEach producing 200 identical refusals.
		const step = { tool: "geocode", forEach: { $ref: "sites" }, inputs: { url: { $param: "item" } } };
		const res = await executePipelineStep(scoped, step, 0, { sites: ["a.com", "b.com"] }, {});
		expect(runRegistryTool).not.toHaveBeenCalled();
		expect(res.success).toBe(false);
	});

	it("dispatches a declared tool, and forwards the allowlist so a NESTED dispatch is gated too", async () => {
		// The forwarding is the point: `enrich` takes the tool to run as an INPUT and re-dispatches
		// it per record through this same ctx, so a gate that only read step names would miss it.
		runRegistryTool.mockResolvedValue({ name: "reachable", content: "{}", success: true });
		const res = await executePipelineStep(scoped, { tool: "reachable" }, 0, {}, {});
		expect(res.success).toBe(true);
		expect(runRegistryTool).toHaveBeenCalledWith("reachable", expect.objectContaining({ declaredTools: ["reachable"] }), {});
	});

	it("never gates a connector-less tool — no creator can declare one", async () => {
		runRegistryTool.mockResolvedValue({ name: "places", content: "[]", success: true });
		const res = await executePipelineStep(scoped, { tool: "places" }, 0, {}, {});
		expect(runRegistryTool).toHaveBeenCalledTimes(1);
		expect(res.success).toBe(true);
	});

	it("asserts nothing when no allowlist was resolved", async () => {
		// A capability lookup that came back empty is a failed read, not evidence.
		runRegistryTool.mockResolvedValue({ name: "geocode", content: "{}", success: true });
		expect((await executePipelineStep(ctx, { tool: "geocode" }, 0, {}, {})).success).toBe(true);
	});

	it("tells the dispatch gate which STEP it is running under (#396)", async () => {
		// Wording only, never permission: a tool `geocode` dispatches from inside itself is refused
		// with "geocode needs http_request" instead of a name the definition never mentions.
		runRegistryTool.mockResolvedValue({ name: "places", content: "[]", success: true });
		await executePipelineStep(scoped, { tool: "places" }, 0, {}, {});
		expect(runRegistryTool).toHaveBeenCalledWith("places", expect.objectContaining({ stepTool: "places" }), {});
	});
});

// ── #396 ────────────────────────────────────────────────────────────────────────
// Every trace event a run wrote carried `context.tool = "enrich"` and nothing about the tool it
// actually dispatched, so the #394 audit had to infer the inner tool from the shape of the data it
// left on each record. Resolved off the RESOLVED inputs, so a `$param`-supplied tool is reported
// too — one map lookup per step, nothing per item.
describe("executePipelineStep — what a step actually dispatched", () => {
	it("reports the tool an enrich step ran per record", async () => {
		runRegistryTool.mockResolvedValue({ name: "enrich", content: "{}", success: true });
		const step = { tool: "enrich", inputs: { items: [], tool: "reachable", as: "up" } };
		expect((await executePipelineStep(ctx, step, 0, {}, {})).dispatched).toBe("reachable");
	});

	it("reports one supplied by a run param, which no static reading could give", async () => {
		runRegistryTool.mockResolvedValue({ name: "enrich", content: "{}", success: true });
		const step = { tool: "enrich", inputs: { tool: { $param: "probe" }, as: "up" } };
		expect((await executePipelineStep(ctx, step, 0, {}, { probe: "reachable" })).dispatched).toBe("reachable");
	});

	it("reports it for a fan-out too, without re-reading it per item", async () => {
		runRegistryTool.mockResolvedValue({ name: "enrich", content: "{}", success: true });
		const step = { tool: "enrich", forEach: { $ref: "batches" }, inputs: { tool: "reachable", as: "up" } };
		const res = await executePipelineStep(ctx, step, 0, { batches: [[1], [2]] }, {});
		expect(res.dispatched).toBe("reachable");
		expect(runRegistryTool).toHaveBeenCalledTimes(2);
	});

	it("says nothing for a step that dispatches nothing", async () => {
		runRegistryTool.mockResolvedValue({ name: "places", content: "[]", success: true });
		expect((await executePipelineStep(ctx, { tool: "places", inputs: { tool: "reachable" } }, 0, {}, {})).dispatched).toBeUndefined();
	});
});

// ── #382 ────────────────────────────────────────────────────────────────────────
// `RegistryToolCtx.budgetId` is what makes a subordinate SHARE the tree's pool; `PipelineRunCtx`
// carried none, so `delegateToInstance` took its `??` branch and opened a fresh ROOT pool on every
// call — ten leads in a forEach, ten pools.
describe("executePipelineStep — the run's delegation pool (#382)", () => {
	it("forwards the run's budgetId to every dispatch", async () => {
		runRegistryTool.mockResolvedValue({ name: "geocode", content: "{}", success: true });
		await executePipelineStep({ ...ctx, budgetId: "b1" }, { tool: "geocode" }, 0, {}, {});
		expect(runRegistryTool).toHaveBeenCalledWith("geocode", expect.objectContaining({ budgetId: "b1" }), {});
	});

	it("forwards the SAME budgetId to every forEach iteration", async () => {
		runRegistryTool.mockResolvedValue({ name: "reachable", content: "{}", success: true });
		const step = { tool: "reachable", forEach: { $ref: "sites" }, inputs: { url: { $param: "item" } } };
		await executePipelineStep({ ...ctx, budgetId: "b1" }, step, 0, { sites: ["a.com", "b.com", "c.com"] }, {});
		expect(runRegistryTool).toHaveBeenCalledTimes(3);
		for (const call of runRegistryTool.mock.calls) expect((call[1] as { budgetId?: string }).budgetId).toBe("b1");
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

	it("names the inner tool an enrich step ran (#396)", () => {
		// A record's own trail said `enrich` and left the reader to guess which tool produced the
		// field sitting next to it.
		const e = auditStepEntry({ tool: "enrich" }, 2, ok({ tool: "enrich", dispatched: "reachable", output: [{}] }));
		expect(e.step).toBe("step 2: enrich → reachable");
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

// #173 — a run must have ONE name. Lookup is by config key; the workflow logs `def.name`. When
// those differ the same run appears under two spellings and the run named in a crash message
// cannot be found in the runs table (`lead_finder` vs `lead-finder`, seen in production).
describe("pipelineDefForKey — the config key is the pipeline's one name", () => {
	it("rewrites a def whose name disagrees with the key it is filed under", () => {
		const def = { name: "lead-finder", steps: [] };
		expect(pipelineDefForKey("lead_finder", def).name).toBe("lead_finder");
	});

	it("leaves everything else on the def untouched", () => {
		const def = { name: "sweep", steps: [{ tool: "geocode" }], sink: { collection: "leads" }, params: { city: {} } };
		const out = pipelineDefForKey("lead_finder", def);
		expect(out).toMatchObject({ steps: def.steps, sink: def.sink, params: def.params });
	});

	it("does not copy when the name already matches — same object, no churn", () => {
		const def = { name: "lead_finder", steps: [] };
		expect(pipelineDefForKey("lead_finder", def)).toBe(def);
	});

	it("does not mutate the caller's def", () => {
		const def = { name: "lead-finder", steps: [] };
		pipelineDefForKey("lead_finder", def);
		expect(def.name).toBe("lead-finder");
	});
});

// ── #363: the create-time check needs the inventory, not one yes/no lookup ─────────────
describe("pipelineInventory", () => {
	const good = { name: "site-builder", steps: [{ tool: "geocode" }] };

	it("splits present names by whether the definition would actually run", () => {
		expect(pipelineInventory({ "site-builder": good, broken: { name: "broken", steps: [] } })).toEqual({
			valid: ["site-builder"],
			invalid: ["broken"],
		});
	});

	it("an agent with NO pipelines is an empty inventory, not an unknown one", () => {
		// The distinction is the whole point: empty means "we looked and there are none", which
		// is exactly the case a connection naming one deserves to be warned about. `null` — the
		// unreadable case — is decided by pipelineNamesFor, not here.
		expect(pipelineInventory(undefined)).toEqual({ valid: [], invalid: [] });
		expect(pipelineInventory({})).toEqual({ valid: [], invalid: [] });
		expect(pipelineInventory([])).toEqual({ valid: [], invalid: [] });
		expect(pipelineInventory("nonsense")).toEqual({ valid: [], invalid: [] });
	});

	it("sorts, so the warning text does not depend on JSON key order", () => {
		expect(pipelineInventory({ z: good, a: good }).valid).toEqual(["a", "z"]);
	});
});

// ── The bound, and saying what it left ────────────────────────────────────────────────
describe("declaredParamDefaults", () => {
	it("collects only the params that declare one", () => {
		const def = { params: { city: { type: "string" }, max_places: { type: "number", default: 300 } } };
		expect(declaredParamDefaults(def)).toEqual({ max_places: 300 });
	});

	it("keeps an explicit falsy default — 0 and false are answers, not absences", () => {
		const def = { params: { limit: { type: "number", default: 0 }, dry: { type: "boolean", default: false } } };
		expect(declaredParamDefaults(def)).toEqual({ limit: 0, dry: false });
	});

	it("is empty for a definition that declares no params at all", () => {
		expect(declaredParamDefaults({})).toEqual({});
	});
});

describe("coverageShortfall", () => {
	it("reports what a bounding step left unexamined", () => {
		expect(coverageShortfall("slice", { count: 120, dropped: 380 })).toBe(
			"slice examined 120 of 500 record(s) — 380 were left unexamined by the cap. Raise the cap, or narrow the search, if you need the rest.",
		);
	});

	it("says nothing when the cap did not bind", () => {
		expect(coverageShortfall("slice", { count: 12, dropped: 0 })).toBeNull();
	});

	it("ignores a filter's drops — deciding against a record is not failing to look at it", () => {
		// `filter` reports `dropped` too, and warning on it would put a line on every run that
		// filters anything, which trains a reader to skip exactly the line that matters.
		expect(coverageShortfall("filter", { count: 3, dropped: 97 })).toBeNull();
	});

	it("tolerates a step output that isn't the envelope it expects", () => {
		expect(coverageShortfall("slice", null)).toBeNull();
		expect(coverageShortfall("slice", [1, 2, 3])).toBeNull();
		expect(coverageShortfall("slice", "nope")).toBeNull();
	});
});
