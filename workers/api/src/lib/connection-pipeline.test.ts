import { describe, expect, it } from "vitest";
import { connectionPipelineWarning, connectionSourceEmitWarning, sourceCanEmitEventType } from "./connection-pipeline.js";

const inv = (valid: string[], invalid: string[] = []) => ({ valid, invalid });

describe("connectionPipelineWarning (#363)", () => {
	it("says nothing when the named pipeline is there", () => {
		expect(connectionPipelineWarning("site-builder", '"Website Builder"', inv(["site-builder", "site-deploy"]))).toBeNull();
	});

	it("names the pipeline AND the agent it was looked for on", () => {
		const w = connectionPipelineWarning("site-buidler", '"Website Builder"', inv(["site-builder"]));
		expect(w).toContain('"site-buidler"');
		expect(w).toContain('"Website Builder"');
		// The near-miss is the whole point of listing what the target does have.
		expect(w).toContain('"site-builder"');
	});

	it("says so plainly when the target has no pipelines at all", () => {
		expect(connectionPipelineWarning("site-deploy", '"Lead Outreach"', inv([]))).toContain("no pipelines at all");
	});

	it("distinguishes a name that is PRESENT but does not validate", () => {
		const w = connectionPipelineWarning("site-deploy", '"Website Builder"', inv([], ["site-deploy"]));
		expect(w).toContain("not valid");
		// A broken definition is fixed on the target, not by renaming the edge — so it must not
		// read like a typo, which is the other sentence.
		expect(w).not.toContain("correct the name");
	});

	it("a null inventory ALLOWS — a failed read is not evidence of absence (#354)", () => {
		expect(connectionPipelineWarning("site-deploy", '"Website Builder"', null)).toBeNull();
		expect(connectionPipelineWarning("site-deploy", '"Website Builder"', undefined)).toBeNull();
	});

	it("says nothing when no pipeline is named — the event payload may still supply one", () => {
		expect(connectionPipelineWarning("", '"Website Builder"', inv([]))).toBeNull();
		expect(connectionPipelineWarning(null, '"Website Builder"', inv([]))).toBeNull();
		expect(connectionPipelineWarning("   ", '"Website Builder"', inv([]))).toBeNull();
	});

	it("falls back to a readable phrase when the target has no label", () => {
		expect(connectionPipelineWarning("x", "", inv([]))).toContain("the target agent");
	});

	it("trims a long pipeline list instead of printing the lot", () => {
		const many = Array.from({ length: 12 }, (_, i) => `p${i}`);
		const w = connectionPipelineWarning("nope", '"Big"', inv(many)) ?? "";
		expect(w).toContain("+4 more");
	});
});

// ── #632: source-side static-emit check ───────────────────────────────────────────────────

/** A minimal valid `config.pipelines` map. */
const pipelines = (defs: Record<string, unknown>) => defs;

/** A `dedupe_upsert` step with a literal emit value. */
const upsertStep = (emit: string) => ({ tool: "dedupe_upsert", inputs: { collection: "leads", key: "id", emit } });

/** A `dedupe_upsert` step with a $ref emit — not statically legible. */
const upsertRefStep = () => ({ tool: "dedupe_upsert", inputs: { collection: "leads", key: "id", emit: { $ref: "step0.event" } } });

/** A pipeline definition with the given steps. */
const def = (name: string, steps: unknown[]) => ({ name, steps });

describe("sourceCanEmitEventType (#632)", () => {
	it("returns true when a dedupe_upsert step has a matching literal emit", () => {
		const raw = pipelines({ finder: def("finder", [upsertStep("lead.created")]) });
		expect(sourceCanEmitEventType(raw, "lead.created")).toBe(true);
	});

	it("returns false when the source has a dedupe_upsert but with a different eventType", () => {
		const raw = pipelines({ finder: def("finder", [upsertStep("lead.qualified")]) });
		expect(sourceCanEmitEventType(raw, "lead.created")).toBe(false);
	});

	it("returns false when no step is a dedupe_upsert at all — a sink-only producer (#632)", () => {
		const raw = pipelines({ finder: def("finder", [{ tool: "geocode" }]) });
		expect(sourceCanEmitEventType(raw, "lead.created")).toBe(false);
	});

	it("returns false when the source has no pipelines", () => {
		expect(sourceCanEmitEventType({}, "lead.created")).toBe(false);
	});

	it("stays silent (null) when raw is null — a failed read is not evidence of absence (#354)", () => {
		expect(sourceCanEmitEventType(null, "lead.created")).toBe(null);
	});

	it("stays silent (null) when raw is not an object — same asymmetry", () => {
		expect(sourceCanEmitEventType("not-an-object", "lead.created")).toBe(null);
	});

	it("stays silent when eventType is empty — nothing to check against", () => {
		const raw = pipelines({ finder: def("finder", [upsertStep("lead.created")]) });
		expect(sourceCanEmitEventType(raw, "")).toBe(null);
		expect(sourceCanEmitEventType(raw, "   ")).toBe(null);
	});

	it("stays silent (null) for a $ref emit — not statically legible, do not warn on a working chain", () => {
		const raw = pipelines({ finder: def("finder", [upsertRefStep()]) });
		// We cannot resolve the ref at static read time — null means "uncertain, stay silent".
		expect(sourceCanEmitEventType(raw, "lead.created")).toBe(null);
	});

	it("stays silent (null) when raw is undefined — source instance not found at all", () => {
		expect(sourceCanEmitEventType(undefined, "lead.created")).toBe(null);
	});

	it("returns true when one of several pipelines can emit — a single capable pipeline is enough", () => {
		const raw = pipelines({
			other: def("other", [{ tool: "geocode" }]),
			finder: def("finder", [upsertStep("lead.created")]),
		});
		expect(sourceCanEmitEventType(raw, "lead.created")).toBe(true);
	});
});

describe("connectionSourceEmitWarning (#632)", () => {
	it("says nothing when the source CAN emit — the edge is healthy", () => {
		const raw = pipelines({ finder: def("finder", [upsertStep("lead.created")]) });
		expect(connectionSourceEmitWarning("lead.created", '"Lead Finder"', raw)).toBeNull();
	});

	it("warns — naming the eventType and the source agent — when NO pipeline can emit", () => {
		const raw = pipelines({ finder: def("finder", [{ tool: "geocode" }]) });
		const w = connectionSourceEmitWarning("lead.created", '"Lead Finder"', raw);
		expect(w).toContain('"lead.created"');
		expect(w).toContain('"Lead Finder"');
		expect(w).toContain("dedupe_upsert");
	});

	it("warns for a sink-only producer (AC4 — the case that drives the whole issue)", () => {
		// A pipeline that only declares a sink has no dedupe_upsert step at all → cannot emit.
		const sinkOnlyPipelines = pipelines({ finder: { name: "finder", steps: [{ tool: "geocode" }], sink: { collection: "leads" } } });
		const w = connectionSourceEmitWarning("lead.created", '"Lead Finder"', sinkOnlyPipelines);
		expect(w).not.toBeNull();
		expect(w).toContain("dedupe_upsert");
	});

	it("does NOT warn for a pipeline ending in dedupe_upsert with a matching emit (AC4)", () => {
		const goodPipelines = pipelines({ finder: def("finder", [upsertStep("lead.created")]) });
		expect(connectionSourceEmitWarning("lead.created", '"Lead Finder"', goodPipelines)).toBeNull();
	});

	it("stays silent when the inventory is null — a failed read is not evidence of absence", () => {
		expect(connectionSourceEmitWarning("lead.created", '"Lead Finder"', null)).toBeNull();
	});

	it("falls back to a readable phrase when the source has no label", () => {
		const raw = pipelines({ finder: def("finder", [{ tool: "geocode" }]) });
		expect(connectionSourceEmitWarning("lead.created", "", raw)).toContain("the source agent");
	});
});
