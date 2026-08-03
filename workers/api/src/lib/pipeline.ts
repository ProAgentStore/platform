// Declarative data pipelines (issue #97, epic #94). A pipeline is DATA, not code: an
// ordered list of steps, each dispatching a registry tool (#85/#86) through the SINGLE
// runRegistryTool path so connector auth/grant/consent are enforced identically to a
// direct tool call. Outputs thread between steps by name (`bind`); inputs reference prior
// outputs + run params via a `$`-prefixed reference convention. This module holds the
// PURE schema + step-execution logic (validation, input resolution, one step) so it is
// unit-testable without the Workflow harness; the durable runner (workflows/pipeline-run.ts)
// wraps executePipelineStep in step.do for durability/resumability past the 30s DO limit.
import type { Env } from "../types.js";
import { getRegistryTool, runRegistryTool } from "./tool-registry.js";

/**
 * A reference into the run's data: `{ "$ref": "stepBind.field" }` reads a bound step's
 * output (dotted path), `{ "$param": "name" }` reads a run parameter. Anything else is a
 * literal (passed through verbatim, recursively for objects/arrays).
 */
export type PipelineInputValue =
	| { $ref: string }
	| { $param: string }
	| { [key: string]: PipelineInputValue }
	| PipelineInputValue[]
	| string
	| number
	| boolean
	| null;

export interface PipelineStep {
	/** Registry tool to dispatch (must exist in the tool registry). */
	tool: string;
	/** The tool's input args — each value may be a literal or a $ref/$param reference. */
	inputs?: Record<string, PipelineInputValue>;
	/** Name this step's output so later steps can `$ref` it. Defaults to the step index. */
	bind?: string;
	/**
	 * Trivial fan-out seam (#96 owns the rich version): when set to a reference that
	 * resolves to an array, the step runs ONCE PER item — the item is exposed to `inputs`
	 * as `$param: "item"` — and this step's bound output is the array of per-item results.
	 * Sequential (no concurrency here); a concurrency cap lands with the #96 step library.
	 */
	forEach?: PipelineInputValue;
}

export interface PipelineSink {
	/** Target instance collection (#91) the final records are upserted into. */
	collection: string;
	/** Unique key field for upsert/dedupe (optional; pass-through to the sink tool). */
	keyField?: string;
}

/** A pipeline definition — pure data, storable per instance (see loadPipeline). */
export interface PipelineDef {
	name: string;
	/** Declared run params (names → JSON type hint). Advisory; validation is name-based. */
	params?: Record<string, { type: string; description?: string }>;
	steps: PipelineStep[];
	sink?: PipelineSink;
}

/** A parsed tool result carried between steps. `output` is the tool's content parsed as
 *  JSON when possible, else the raw string. */
export interface StepResult {
	tool: string;
	bind: string;
	success: boolean;
	content: string;
	output: unknown;
}

/**
 * One entry in a record's audit trail (issue #98). Deliberately the SAME shape the /data
 * tab detail already renders for the lead-finder (`{step, detail, at}`), so generalizing
 * the console detail view means rendering this array unchanged. `step` is a short label
 * (an input-seen line, a step's tool→bind decision, or the sink action); `detail` is the
 * salient one-liner; `at` is an ISO timestamp.
 */
export interface AuditEntry {
	step: string;
	detail: string;
	at: string;
}

/** How many records a step's output represents (array length, or 1 for a single object). */
function outputCount(output: unknown): number {
	return Array.isArray(output) ? output.length : output == null ? 0 : 1;
}

/**
 * Summarize one completed step into an audit entry — the step's DECISION, captured as the
 * runner walks (not reconstructed). Records the tool, its bound name, whether it succeeded,
 * and how many records it produced (the salient output for a source→transform→sink walk).
 */
export function auditStepEntry(step: PipelineStep, index: number, result: StepResult): AuditEntry {
	const bind = stepBind(step, index);
	const verb = result.success ? "→" : "failed";
	const count = result.success ? ` ${outputCount(result.output)} record(s)` : `: ${result.content.slice(0, 160)}`;
	return { step: `step ${index}: ${step.tool}`, detail: `${verb} ${bind}${count}`, at: new Date().toISOString() };
}

/**
 * Attach the run's step-by-step audit trail to each output record (issue #98) so the sink
 * persists it and the /data tab detail renders "what the agent saw and decided" per record.
 * The trail = an input-seen line + one entry per step + a per-record sink line. Records that
 * already carry an `audit` array are respected (a dedupe/upsert step may have merged one);
 * we only fill it when absent. Pure — the durable runner calls it before the sink writes.
 */
export function attachAudit(records: unknown[], trail: AuditEntry[], collection: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const rec of records) {
		if (rec == null || typeof rec !== "object" || Array.isArray(rec)) continue;
		const r = rec as Record<string, unknown>;
		if (Array.isArray(r.audit)) {
			out.push(r);
			continue;
		}
		const sink: AuditEntry = { step: "sink", detail: `upserted into "${collection}"`, at: new Date().toISOString() };
		out.push({ ...r, audit: [...trail, sink] });
	}
	return out;
}

/** Validate a candidate pipeline definition. Returns an error string, or null if valid.
 *  Boundary validation only (definitions come from stored config / API callers). */
export function validatePipeline(def: unknown): string | null {
	if (!def || typeof def !== "object" || Array.isArray(def)) return "Pipeline must be an object";
	const p = def as Record<string, unknown>;
	if (typeof p.name !== "string" || !p.name.trim()) return "Pipeline.name is required";
	if (!Array.isArray(p.steps) || p.steps.length === 0) return "Pipeline.steps must be a non-empty array";
	const binds = new Set<string>();
	for (let i = 0; i < p.steps.length; i++) {
		const s = p.steps[i] as Record<string, unknown>;
		if (!s || typeof s !== "object") return `Step ${i} must be an object`;
		if (typeof s.tool !== "string" || !s.tool.trim()) return `Step ${i}: "tool" is required`;
		if (!getRegistryTool(s.tool as string)) return `Step ${i}: unknown tool "${s.tool}"`;
		if (s.inputs !== undefined && (typeof s.inputs !== "object" || s.inputs === null || Array.isArray(s.inputs))) {
			return `Step ${i}: "inputs" must be an object`;
		}
		if (s.bind !== undefined) {
			if (typeof s.bind !== "string" || !s.bind.trim()) return `Step ${i}: "bind" must be a non-empty string`;
			if (binds.has(s.bind as string)) return `Step ${i}: duplicate bind "${s.bind}"`;
			binds.add(s.bind as string);
		}
	}
	if (p.sink !== undefined) {
		const sink = p.sink as Record<string, unknown>;
		if (!sink || typeof sink !== "object" || Array.isArray(sink)) return "sink must be an object";
		if (typeof sink.collection !== "string" || !sink.collection.trim()) return "sink.collection is required";
	}
	return null;
}

/** The default bind name for a step without an explicit one. */
export function stepBind(step: PipelineStep, index: number): string {
	return step.bind ?? `step${index}`;
}

/** Read a dotted path (e.g. "geocode.lat") from the run's bound-output map + params. */
function readPath(root: unknown, path: string): unknown {
	let cur = root;
	for (const key of path.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

/**
 * Resolve one input value against the run scope. `$ref` reads from bound step outputs
 * (their parsed `output`), `$param` reads a run param, and a special `item` scope is used
 * for forEach. Objects/arrays are resolved recursively so nested references work.
 */
export function resolveInputValue(
	value: PipelineInputValue,
	scope: { outputs: Record<string, unknown>; params: Record<string, unknown>; item?: unknown },
): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((v) => resolveInputValue(v, scope));
	const obj = value as Record<string, unknown>;
	if (typeof obj.$param === "string") {
		// `$param: "item"` inside a forEach body reads the current fan-out item;
		// `$param: "item.<path>"` reads a dotted field off it (issue #114) — so a per-item
		// body can plug `item.lat`/`item.lng` into a request or `item.websiteUri` into a probe.
		if (scope.item !== undefined) {
			if (obj.$param === "item") return scope.item;
			if (obj.$param.startsWith("item.")) return readPath(scope.item, obj.$param.slice("item.".length));
		}
		return scope.params[obj.$param];
	}
	if (typeof obj.$ref === "string") return readPath(scope.outputs, obj.$ref);
	// A plain object literal — resolve each value recursively.
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) out[k] = resolveInputValue(v as PipelineInputValue, scope);
	return out;
}

/** Resolve a step's whole `inputs` map against the run scope. */
export function resolveInputs(
	inputs: Record<string, PipelineInputValue> | undefined,
	scope: { outputs: Record<string, unknown>; params: Record<string, unknown>; item?: unknown },
): Record<string, unknown> {
	const resolved: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(inputs ?? {})) resolved[k] = resolveInputValue(v, scope);
	return resolved;
}

/** Parse a tool's string content as JSON when it looks like JSON, else return the string. */
function parseOutput(content: string): unknown {
	const t = content.trim();
	if (t && (t[0] === "{" || t[0] === "[")) {
		try {
			return JSON.parse(t);
		} catch {
			/* not JSON — fall through */
		}
	}
	return content;
}

export interface PipelineRunCtx {
	env: Env;
	userId: string;
	instanceId: string;
	/** The run id, forwarded to steps so an emitting step can stamp it on its deliveries. */
	traceId?: string;
}

/**
 * Execute ONE pipeline step: resolve its inputs against prior outputs + params, dispatch
 * via runRegistryTool (the single path enforcing connector auth/grant/consent), and return
 * the result with its output parsed. On `forEach`, the step runs once per resolved array
 * item (sequentially) and the output is the array of per-item parsed outputs.
 *
 * PURE w.r.t. the Workflow: it takes a plain ctx + the accumulated outputs/params, so the
 * durable runner can call it inside step.do and unit tests can call it directly.
 */
export async function executePipelineStep(
	ctx: PipelineRunCtx,
	step: PipelineStep,
	index: number,
	outputs: Record<string, unknown>,
	params: Record<string, unknown>,
): Promise<StepResult> {
	const bind = stepBind(step, index);
	const registryCtx = { env: ctx.env, userId: ctx.userId, instanceId: ctx.instanceId, traceId: ctx.traceId };

	if (step.forEach !== undefined) {
		const list = resolveInputValue(step.forEach, { outputs, params });
		if (!Array.isArray(list)) {
			return { tool: step.tool, bind, success: false, content: `forEach did not resolve to an array for step ${index}`, output: null };
		}
		const results: unknown[] = [];
		let allOk = true;
		for (const item of list) {
			const input = resolveInputs(step.inputs, { outputs, params, item });
			const r = await runRegistryTool(step.tool, registryCtx, input);
			if (!r.success) allOk = false;
			results.push(parseOutput(r.content));
		}
		return { tool: step.tool, bind, success: allOk, content: `${results.length} item(s)`, output: results };
	}

	const input = resolveInputs(step.inputs, { outputs, params });
	const r = await runRegistryTool(step.tool, registryCtx, input);
	return { tool: step.tool, bind, success: r.success, content: r.content, output: parseOutput(r.content) };
}

/**
 * Load a pipeline definition stored on the instance. Definitions live in the instance's
 * existing `agent_instances.config` JSON under `config.pipelines[name]` — the least-invasive
 * store (reuses the row already read by requireOwnedInstance; no new migration, and it's
 * editable via the instance-settings UI/MCP that already round-trips `config`). Returns the
 * def, or null if the instance/pipeline isn't found or the stored def is invalid.
 */
export async function loadPipeline(env: Env, instanceId: string, userId: string, name: string): Promise<PipelineDef | null> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string }>();
	if (!row) return null;
	let cfg: Record<string, unknown>;
	try {
		cfg = JSON.parse(row.config || "{}") as Record<string, unknown>;
	} catch {
		return null;
	}
	const pipelines = cfg.pipelines as Record<string, unknown> | undefined;
	const def = pipelines?.[name];
	if (!def || validatePipeline(def) !== null) return null;
	return def as PipelineDef;
}
