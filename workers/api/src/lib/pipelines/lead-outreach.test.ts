// The Lead Outreach agent's `draft_outreach` pipeline, driven end-to-end through the REAL runner
// (`executePipelineStep`) and the REAL step handlers (`map`, `ai_generate` from steps.ts). Only the
// two genuine I/O boundaries are mocked: the BYOK model call and the collection sink's Durable
// Object. Everything between them — `$param`/`$ref` resolution, step threading, the `derive`
// reshape and `ai_generate`'s `{{field}}` rendering — runs for real.
//
// Why this file exists (#706). Until 2026-08-18 this definition lived in exactly ONE place:
// instance data on `3c09069a-e866-4218-978e-569f62f4ab10`. No reference JSON, no importer, no test,
// and an empty `agents.config`. It is the second link of the platform's only live agent-to-agent
// chain — Lead Finder emits `lead.created`, the pump routes it here — with 100+ completed runs
// behind it, and it was one cancelled subscription from being unrecoverable. Committing the JSON
// makes it versioned; this file is what makes it *tested*, which is the other half of the ticket.
import { beforeEach, describe, expect, it, vi } from "vitest";
import leadFinder from "./lead-finder.json" with { type: "json" };
import leadOutreach from "./lead-outreach.json" with { type: "json" };

// The REAL pure step handlers — the transform steps route to these so the logic is genuinely
// exercised rather than restated.
import { STEP_TOOLS } from "../steps.js";

const KNOWN = new Set(["map", "ai_generate", "dedupe_upsert"]);
const realHandler = (name: string) => STEP_TOOLS.find((t) => t.name === name)?.handler;

/** What the sink was asked to write, and how. */
let upserted: Array<{ items: Record<string, unknown>[]; collection: string; key: string; mode: string }> = [];
/** Every message list the model was handed, so the RENDERED prompt can be asserted. */
let modelCalls: Array<{ model: string; maxTokens: number; messages: Array<{ role: string; content: string }> }> = [];

// The BYOK model boundary. `ai_generate` reaches it through a deferred
// `await import("./user-ai.js")`, so this mock is what stands between the test and a real
// Anthropic call — and capturing `messages` here is the only way to see what the definition's
// own `{{field}}` template actually produced.
vi.mock("../user-ai.js", () => ({
	runUserWorkersAi: vi.fn(async (_env: unknown, _userId: string, model: string, opts: { messages: Array<{ role: string; content: string }>; maxTokens: number }) => {
		modelCalls.push({ model, maxTokens: opts.maxTokens, messages: opts.messages });
		const business = /Business: ([^ ]+(?: [^ ]+)*?) in /.exec(opts.messages.at(-1)?.content ?? "")?.[1] ?? "there";
		return { response: `Hi ${business} — noticed you have no website. Happy to build you a simple one.` };
	}),
}));

const runRegistryTool = vi.fn(async (name: string, ctx: unknown, input: Record<string, unknown>) => {
	// ── real pure transforms ───────────────────────────────────────────────
	if (name === "map" || name === "ai_generate") {
		const r = await realHandler(name)?.(ctx as never, input);
		return { name, content: r?.content ?? "", success: r?.success ?? false };
	}
	// ── mocked I/O boundary: the collection sink lives in a Durable Object ──
	if (name === "dedupe_upsert") {
		const items = (Array.isArray(input.items) ? input.items : []) as Record<string, unknown>[];
		upserted.push({ items, collection: String(input.collection), key: String(input.key), mode: String(input.mode) });
		return { name, content: JSON.stringify({ inserted: 0, updated: items.length, skipped: 0, total: items.length }), success: true };
	}
	return { name, content: `unexpected tool ${name}`, success: false };
});

vi.mock("../tool-registry.js", () => ({
	getRegistryTool: (name: string) => (KNOWN.has(name) ? { name } : undefined),
	runRegistryTool: (...args: unknown[]) => (runRegistryTool as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Import AFTER the mocks so pipeline.ts + steps.ts bind the mocked registry.
import { auditStepEntry, capStepOutput, declaredParamDefaults, executePipelineStep, stepBind, validatePipeline, type AuditEntry, type PipelineDef, type StepResult } from "../pipeline.js";
import { paramsWithDefaults } from "../instance-settings.js";
import type { Env } from "../../types.js";

const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);

const env = {} as Env;
const ctx = { env, userId: "u1", instanceId: "i1" };

/**
 * One `lead.created` payload as the Lead Finder actually emits it — a row out of the `leads`
 * collection, which the pump hands to this pipeline as its params.
 */
const LEAD = {
	place_id: "ChIJ_no_site",
	name: "Corner Espresso",
	address: "1 King St, Newtown NSW 2042",
	phone: "0298001111",
	suburb: "Marrickville",
	city: "Newtown",
	website_status: "none",
};

beforeEach(() => {
	runRegistryTool.mockClear();
	upserted = [];
	modelCalls = [];
});

/** Drive the JSON through the real runner exactly as workflows/pipeline-run.ts does. */
async function drivePipeline(def: PipelineDef, params: Record<string, unknown>) {
	const outputs: Record<string, unknown> = {};
	const trail: AuditEntry[] = [];
	const results: StepResult[] = [];
	const runParams = paramsWithDefaults(declaredParamDefaults(def), {}, params);
	for (let i = 0; i < def.steps.length; i++) {
		const step = def.steps[i];
		const r = capStepOutput(await executePipelineStep(ctx, step, i, outputs, runParams), step.tool, i);
		results.push(r);
		outputs[stepBind(step, i)] = r.output;
		trail.push(auditStepEntry(step, i, r));
	}
	return { outputs, trail, results };
}

describe("draft_outreach — the Lead Outreach pipeline (#706)", () => {
	const def = leadOutreach as unknown as PipelineDef;

	it("is a definition the runner will actually accept", () => {
		// `defaultPipelinesFor` drops an invalid def on subscribe — silently. A reference JSON that
		// failed here would look committed and hand out nothing.
		expect(validatePipeline(def)).toBeNull();
	});

	it("turns one lead.created payload into one drafted prospect", async () => {
		const { results } = await drivePipeline(def, LEAD);
		expect(results.every((r) => r.success)).toBe(true);

		expect(upserted).toHaveLength(1);
		const write = upserted[0];
		// The sink half of the chain: keyed by place_id into `prospects`, in `update` mode so a
		// re-delivery of the same lead revises the draft instead of duplicating the prospect.
		expect(write.collection).toBe("prospects");
		expect(write.key).toBe("place_id");
		expect(write.mode).toBe("update");
		expect(write.items).toHaveLength(1);

		const prospect = write.items[0];
		expect(prospect.place_id).toBe("ChIJ_no_site");
		expect(prospect.name).toBe("Corner Espresso");
		expect(prospect.suburb).toBe("Marrickville");
		expect(prospect.status).toBe("new");
		// The whole point of the agent: a drafted message, on the field the console reads.
		expect(String(prospect.draft_message)).toContain("Corner Espresso");
	});

	it("renders the lead's own details into the model prompt", async () => {
		await drivePipeline(def, LEAD);
		expect(modelCalls).toHaveLength(1);
		const user = modelCalls[0].messages.at(-1)?.content ?? "";
		// Each of these is a `{{field}}` in the definition's prompt resolving through the `map`
		// step's `derive`. This is the assertion that fails if a param is renamed on either side of
		// the chain — the failure mode being a prompt that still generates, fluently, about nobody.
		expect(user).toContain("Corner Espresso");
		expect(user).toContain("Marrickville");
		expect(user).toContain("Newtown");
		expect(user).toContain("0298001111");
		expect(user).toContain("none");
		// An unresolved placeholder renders as the literal braces; a missing field renders as "".
		expect(user).not.toContain("{{");
		expect(user).not.toMatch(/in , /);
		// The persona is a system message, not smuggled into the user turn.
		expect(modelCalls[0].messages[0].role).toBe("system");
		expect(modelCalls[0].messages[0].content).toContain("cold-outreach");
	});

	it("declares only params the Lead Finder's emitted record actually carries", () => {
		// The chain is choreography: `lead.created` fires from lead-finder's `dedupe_upsert` and the
		// pump passes that RECORD as this pipeline's params, matched by name. So a param named here
		// that the lead record does not carry arrives `undefined` and renders as "" — a draft about
		// a business with no suburb, generated confidently, failing nothing.
		//
		// Derived from lead-finder.json rather than restated, so a rename on the producing side
		// fails here instead of going out as prose.
		const steps = leadFinder.steps as Array<{ tool: string; inputs: Record<string, unknown> }>;
		const fields = new Set<string>();
		for (const s of steps) {
			if (s.tool === "map") {
				for (const k of (s.inputs.keep as string[] | undefined) ?? []) fields.add(k);
				for (const v of Object.values((s.inputs.rename as Record<string, string> | undefined) ?? {})) fields.add(v);
				for (const k of Object.keys((s.inputs.derive as Record<string, unknown> | undefined) ?? {})) fields.add(k);
			}
			if (s.tool === "enrich" && typeof s.inputs.as === "string") fields.add(s.inputs.as);
		}
		// Anchors, so a derivation that silently collected nothing (or everything) cannot pass the
		// subset check below by being empty.
		expect(fields.has("place_id")).toBe(true);
		expect(fields.has("website_status")).toBe(true);
		expect(fields.size).toBeGreaterThan(10);

		expect([...Object.keys(def.params ?? {})].filter((p) => !fields.has(p))).toEqual([]);
	});

	it("is draft-only: three instance-local steps, no channel to send anything", () => {
		// The storefront description promises "Draft-only — never sends", and nothing but this
		// enforces it. `map`, `ai_generate` and `dedupe_upsert` are the core step library: the first
		// two are pure/model-only and the third writes to the instance's own collection. A fourth
		// step naming a connector is how that promise would quietly stop being true, so it has to
		// come with a re-read of the description rather than a green suite.
		expect(def.steps.map((s) => s.tool)).toEqual(["map", "ai_generate", "dedupe_upsert"]);
		// It also emits nothing: the chain ends here. `emit` on the upsert would fan out to whatever
		// the owner has wired next, which is a product decision and not a silent one.
		expect(rows(def.steps).every((s) => !("emit" in ((s.inputs ?? {}) as Record<string, unknown>)))).toBe(true);
	});
});
