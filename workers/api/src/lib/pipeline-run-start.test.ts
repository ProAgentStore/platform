import { beforeEach, describe, expect, it, vi } from "vitest";

// A registry whose tools are all "known" so a stored def validates. `places` and `http_request` are
// connector-provided, so they are what the declared-tools gate (#381) can refuse; everything else is
// step-library-shaped and exempt. `geocode` mirrors the real declaration — a connector-LESS step
// that dispatches a connector tool from inside itself, which is the whole of #396.
const TOOLS: Record<string, { connector?: string; dispatches?: string[] }> = {
	places: { connector: "http" },
	http_request: { connector: "http" },
	geocode: { dispatches: ["http_request"] },
};
vi.mock("./tool-registry.js", () => ({
	getRegistryTool: (name: string) => ({ name, ...(TOOLS[name] ?? {}) }),
	runRegistryTool: vi.fn(),
}));

// The delegation pool (#382) — stubbed so opening one is observable without D1.
const openBudget = vi.fn(async () => ({ id: "pool-1" }));
vi.mock("./delegation-budget-store.js", () => ({ openBudget: (...a: unknown[]) => openBudget(...(a as [])) }));

import { startPipelineRun } from "./pipeline-run-start.js";
import { loadPipeline } from "./pipeline.js";
import type { Env } from "../types.js";

// A genuinely exempt pipeline — a pure step that reaches nothing external. It used to be a
// `geocode` step, which reads as exempt and is not: since #396 the gate can see the `http_request`
// underneath it, so using it here would make every test below assert the refusal instead.
const PIPE = { name: "leads", steps: [{ tool: "map", inputs: { items: { $param: "city" } } }], sink: { collection: "leads" } };

beforeEach(() => {
	openBudget.mockClear();
});

/** The PIPELINE_RUN `create` stub. Declared WITH its one argument: a zero-arg `vi.fn` records a
 *  zero-length call tuple, so `create.mock.calls[0][0]` — the kicked payload every assertion
 *  below reads — would not exist. */
const createStub = (id: string) => vi.fn(async (_arg: unknown) => ({ id }));

/** Env whose agent_instances row carries a config with a pipelines map.
 *
 *  `agentConfig` answers the capability join (`agent_instances ⨝ agents`) separately, because that
 *  is where `capabilities.tools` lives — the instance's own config holds the pipelines. */
function envWithConfig(config: unknown, create?: (arg: unknown) => Promise<{ id: string }>, agentConfig?: unknown): Env {
	const row = config === null ? null : { config: typeof config === "string" ? config : JSON.stringify(config) };
	return {
		DB: {
			prepare: (sql: string) => ({
				// Bind-less .run() — reached by logEvent's opportunistic retention DELETE (#680).
				run: async () => ({ meta: { changes: 0 } }),
				bind: () => ({
					first: async () => (sql.includes("JOIN agents") ? { slug: "fixture", category: "general", config: JSON.stringify(agentConfig ?? {}) } : row),
					// .run() — reached by logEvent INSERT and openRun's INSERT OR IGNORE (#680).
					run: async () => ({ meta: { changes: 1 } }),
				}),
			}),
		},
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
		const create = createStub("wf-42");
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
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: {} }, create);
		const res = await startPipelineRun(env, "i1", "u1", "nope", {}, "api");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/No pipeline named "nope"/);
		expect(create).not.toHaveBeenCalled();
	});
});

// ── #381 ────────────────────────────────────────────────────────────────────────
describe("startPipelineRun — the declared-tools gate", () => {
	const CONNECTOR_PIPE = { name: "leads", steps: [{ tool: "places" }] };

	it("refuses a pipeline naming an undeclared connector tool, and does NOT kick", async () => {
		// Before this the run started, the workflow walked, and the tool ran — `runRegistryTool`
		// asks about connector scope and write consent, never about whose agent this is.
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: CONNECTOR_PIPE } }, create, { capabilities: { tools: ["web_search"] } });
		const res = await startPipelineRun(env, "i1", "u1", "leads", {}, "trigger");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/places/);
		expect(create).not.toHaveBeenCalled();
	});

	it("kicks when the agent declares the tool, carrying the allowlist to the runner", async () => {
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: CONNECTOR_PIPE } }, create, { capabilities: { tools: ["places"] } });
		expect((await startPipelineRun(env, "i1", "u1", "leads", {}, "api")).ok).toBe(true);
		expect((create.mock.calls[0][0] as { params: { declaredTools?: string[] } }).params.declaredTools).toEqual(["places"]);
	});

	// ── #396 ───────────────────────────────────────────────────────────────────
	const GEO_PIPE = { name: "leads", steps: [{ tool: "geocode", inputs: { address: { $param: "city" } } }, { tool: "map" }] };

	it("refuses a geocode-only pipeline at KICK, not eight steps into a run", async () => {
		// The regression this issue is about. Every step here is step-library and connector-less, so
		// the definition looked exempt: attach passed, kick passed, the workflow opened a run row and
		// the FIRST step was refused by `runRegistryTool` — a run that started, spent and stopped,
		// which is exactly what the kick check exists to prevent.
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: GEO_PIPE } }, create, { capabilities: { tools: [] } });
		const res = await startPipelineRun(env, "i1", "u1", "leads", { city: "Sydney" }, "trigger");
		expect(res.ok).toBe(false);
		// Naming the STEP is the point: the definition never mentions `http_request`.
		if (!res.ok) expect(res.error).toMatch(/step 0 \("geocode"\) needs "http_request"/);
		expect(create).not.toHaveBeenCalled();
	});

	it("kicks the same pipeline once the agent declares what geocode needs", async () => {
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: GEO_PIPE } }, create, { capabilities: { tools: ["http_request"] } });
		expect((await startPipelineRun(env, "i1", "u1", "leads", { city: "Sydney" }, "trigger")).ok).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
	});
});

// ── The params a run actually walks with ────────────────────────────────────────
describe("startPipelineRun — caller > subscriber setting > declared default", () => {
	const CAPPED = {
		name: "leads",
		params: { city: { type: "string" }, max_places: { type: "number", default: 300 } },
		steps: [{ tool: "slice", inputs: { limit: { $param: "max_places" } } }],
	};
	const SETTINGS_SCHEMA = [{ id: "max_places", label: "Places per sweep", type: "number" }];
	const kicked = (create: { mock: { calls: unknown[][] } }) => (create.mock.calls[0][0] as { params: { params: Record<string, unknown> } }).params.params;

	it("fills an unsupplied param from the definition's default", async () => {
		// The live wiring passes {city, type, radius} and nothing else. Without this the `slice`
		// limit resolves to undefined, `slice` keeps everything, and the sweep is unbounded again.
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: CAPPED } }, create);
		await startPipelineRun(env, "i1", "u1", "leads", { city: "Sydney" }, "trigger");
		expect(kicked(create)).toEqual({ city: "Sydney", max_places: 300 });
	});

	it("lets the subscriber's setting of the same name override the default", async () => {
		// The point of putting the knob in settingsSchema: before this, settings reached the chat
		// prompt only, so an agent whose behaviour IS its pipelines had a Settings card that
		// changed nothing about what those pipelines did.
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: CAPPED }, settings: { max_places: 120 } }, create, { settingsSchema: SETTINGS_SCHEMA });
		await startPipelineRun(env, "i1", "u1", "leads", { city: "Sydney" }, "trigger");
		expect(kicked(create)).toEqual({ city: "Sydney", max_places: 120 });
	});

	it("still lets an explicit argument win over both", async () => {
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: CAPPED }, settings: { max_places: 120 } }, create, { settingsSchema: SETTINGS_SCHEMA });
		await startPipelineRun(env, "i1", "u1", "leads", { city: "Sydney", max_places: 40 }, "chat");
		expect(kicked(create)).toEqual({ city: "Sydney", max_places: 40 });
	});

	it("leaves a definition without defaults, on an agent without settings, exactly as it was", async () => {
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: PIPE } }, create);
		await startPipelineRun(env, "i1", "u1", "leads", { city: "Hobart" }, "api");
		expect(kicked(create)).toEqual({ city: "Hobart" });
	});
});

// ── #382 ────────────────────────────────────────────────────────────────────────
describe("startPipelineRun — one delegation pool per run", () => {
	it("opens ONE pool for a definition that delegates, and hands it to every step", async () => {
		// Before this no pool was opened here at all, so `delegateToInstance` took its `??` branch
		// and opened a fresh ROOT pool per call — 288 a day on a 5-minute cron.
		const create = createStub("wf");
		const def = { name: "fleet", steps: [{ tool: "subordinate_status" }, { tool: "delegate_goal" }] };
		const env = envWithConfig({ pipelines: { fleet: def } }, create);
		expect((await startPipelineRun(env, "i1", "u1", "fleet", {}, "trigger")).ok).toBe(true);
		expect(openBudget).toHaveBeenCalledTimes(1);
		expect((create.mock.calls[0][0] as { params: { budgetId?: string } }).params.budgetId).toBe("pool-1");
	});

	it("opens NO pool for an ordinary source → transform → sink pipeline", async () => {
		// The lead-finder sweeps every 5 minutes and never delegates; a pool per tick would be three
		// D1 operations and a permanent unused row, forever, to bound nothing.
		const create = createStub("wf");
		const env = envWithConfig({ pipelines: { leads: PIPE } }, create);
		expect((await startPipelineRun(env, "i1", "u1", "leads", {}, "trigger")).ok).toBe(true);
		expect(openBudget).not.toHaveBeenCalled();
		expect((create.mock.calls[0][0] as { params: { budgetId?: string } }).params.budgetId).toBeUndefined();
	});
});
