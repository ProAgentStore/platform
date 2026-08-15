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
import { undeclaredToolRefusal } from "./tool-refusal.js";
import { unfenceUntrusted } from "./untrusted-fence.js";

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

/**
 * One declared run parameter. `default` is what the runner uses when the caller supplies nothing
 * (`lib/pipeline-run-start.ts`, #394).
 *
 * It exists because "unset" and "zero" are different answers and only one of them is safe. A bound
 * expressed as `{"$param":"max_places"}` on a `slice` resolves to `undefined` when nobody passes it,
 * and an absent `limit` means KEEP EVERYTHING — so the one step whose job is to bound the run is
 * also the step that silently stops bounding it the moment the wiring forgets a param. A default
 * declared next to the param makes the bound a property of the DEFINITION rather than of every
 * call site that has to remember it.
 */
export interface PipelineParam {
	type: string;
	description?: string;
	default?: string | number | boolean;
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
	/** Declared run params (names → JSON type hint + optional default). Validation is name-based. */
	params?: Record<string, PipelineParam>;
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
	/**
	 * The registry tool this step actually dispatched from its own inputs (#396), when its handler
	 * takes one there — today `enrich`.
	 *
	 * Every trace event a run writes carried `context.tool = "enrich"` and nothing about what ran,
	 * so the #394 audit had to INFER the inner tool from the shape of the output it left on each
	 * record. Resolved here rather than in the handler because the inputs are already resolved at
	 * this point: it costs one map lookup per step and nothing per item.
	 */
	dispatched?: string;
}

/**
 * Cloudflare journals every `step.do` return value and rejects one over 1MiB with a
 * `WorkflowInternalError` that kills the RUN — not the step. Seen in production:
 *
 *   lead_finder … failed … "Step s3-flatten-1 output is too large. Maximum allowed size is 1MiB."
 *
 * A sweep that happened to match a lot of places lost everything, several steps in, to an
 * infrastructure error naming an internal step id — with no indication of what to do about it.
 * Checked here, BEFORE returning, so it becomes an ordinary failed step: the run closes cleanly,
 * the error store gets the real reason, and the message names the fix (`slice`, which exists for
 * exactly this).
 */
const MAX_STEP_OUTPUT_BYTES = 900_000; // under 1MiB, with headroom for the journal's own framing

export function capStepOutput(result: StepResult, tool: string, index: number): StepResult {
	let bytes: number;
	try {
		bytes = new TextEncoder().encode(JSON.stringify(result)).length;
	} catch {
		return result; // unserializable is the Workflow engine's problem to report, not ours
	}
	if (bytes <= MAX_STEP_OUTPUT_BYTES) return result;
	const kb = Math.round(bytes / 1024);
	return {
		tool,
		bind: result.bind,
		// Carried through the rewrite: the trace line for an over-large step is exactly the one a
		// reader needs "what actually ran" for, and dropping it here would blank it on failure only.
		...(result.dispatched ? { dispatched: result.dispatched } : {}),
		success: false,
		content:
			`step ${index} (${tool}) produced ${kb}KB, over the 1MiB per-step limit. ` +
			"Cap the list before this step with a `slice` step (e.g. {\"tool\":\"slice\",\"inputs\":{\"limit\":50}}), " +
			"or narrow the search that produced it.",
		output: null,
	};
}

/**
 * The values a definition declares as its own defaults, for the params that carry one.
 *
 * Applied UNDER everything else at kick, so an explicit argument always wins and the default only
 * fills a gap.
 */
export function declaredParamDefaults(def: Pick<PipelineDef, "params">): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, decl] of Object.entries(def.params ?? {})) {
		if (decl && typeof decl === "object" && decl.default !== undefined) out[name] = decl.default;
	}
	return out;
}

/**
 * Steps whose job is to BOUND a list, and which therefore report a `dropped` count that means
 * "records this run never looked at" rather than "records this run decided against".
 *
 * `filter` also reports `dropped` and is deliberately not here: dropping is the whole point of a
 * filter, and a warning per filtered record would be noise that trains a reader to ignore the line.
 */
const BOUNDING_TOOLS = new Set(["slice"]);

/**
 * The sentence to publish when a bounding step left records unexamined — null when it didn't (#394).
 *
 * A cap that quietly keeps the first N is the same class of defect as the crash it replaces: the run
 * closes `completed`, the counts look like a full sweep, and nothing anywhere says the city was only
 * partly covered. The platform's rule is that a workflow which bounds coverage says what it left,
 * so this is surfaced as a warn-level trace event AND carried into the run's own detail line, not
 * buried in a step's JSON body where the 160-character trace excerpt never reaches it.
 */
export function coverageShortfall(tool: string, output: unknown): string | null {
	if (!BOUNDING_TOOLS.has(tool) || !output || typeof output !== "object" || Array.isArray(output)) return null;
	const o = output as Record<string, unknown>;
	const dropped = typeof o.dropped === "number" ? o.dropped : 0;
	const kept = typeof o.count === "number" ? o.count : 0;
	if (dropped <= 0) return null;
	return `${tool} examined ${kept} of ${kept + dropped} record(s) — ${dropped} were left unexamined by the cap. Raise the cap, or narrow the search, if you need the rest.`;
}

/**
 * Steps that succeed as a whole while some of their records did not — and that report the count in
 * their own JSON body, where no reader can reach it (#642, #630).
 *
 * `enrich` counts per-item tool failures deliberately (its comment says "so it is visible rather
 * than silent") and puts the number after a pretty-printed `items` array: with only two records
 * `"failed"` already sits at index 357 of a 407-character body, and the trace event carries the
 * first 160. On a real run — the shipped lead-finder enriches the whole shaped list, 83 records on
 * the live run — it lands tens of thousands of characters out.
 *
 * `parse_json` is the same shape and was found by the source-derived guard in
 * `workflows/pipeline-run-accounting.test.ts`, not by the issue: a value that will not parse becomes
 * `null` "and is counted in `failed`", into a body with the same problem. Which is why that guard
 * derives this set from `steps.ts` rather than checking that one known tool is in it.
 *
 * So the count is lifted OUT of the body here, the same way `coverageShortfall` lifts a cap out of
 * `slice`'s. Computed from the output rather than carried on `StepResult` because it is a fact
 * about the data, not about the dispatch — and because a pure function over the body is what makes
 * it testable without a Workflow harness.
 */
const PARTIAL_FAILURE_TOOLS = new Set(["enrich", "parse_json", "dedupe_upsert"]);

export interface PartialFailure {
	/** Records the step could not process. Folded into the run's `errors`. */
	failed: number;
	/** Records it looked at, so the note reads as a proportion rather than a bare count. */
	total: number;
	/** The first failure's message — the one string that says WHAT went wrong. */
	firstError: string;
	/** The sentence for the trace and the run's detail line. */
	note: string;
}

/**
 * What a step failed on, when it failed on part of its input but still returned success — null when
 * it didn't (or when the tool does not report such a count).
 *
 * `label` is the step's "what actually ran" label (`enrich → http_reachable`), because the inner
 * tool is the useful half: 40 failed `http_reachable` probes and 40 failed `web_search` calls are
 * different problems and `enrich` names neither.
 */
export function partialFailure(tool: string, output: unknown, label = tool): PartialFailure | null {
	if (!PARTIAL_FAILURE_TOOLS.has(tool) || !output || typeof output !== "object" || Array.isArray(output)) return null;
	const o = output as Record<string, unknown>;
	const failed = typeof o.failed === "number" && Number.isFinite(o.failed) ? Math.trunc(o.failed) : 0;
	if (failed <= 0) return null;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
	// `enrich`/`parse_json` report how many records they produced (`count`); `dedupe_upsert` how
	// many it was given (`total`). Never below `failed`, so the proportion cannot read backwards.
	const total = Math.max(num(o.total), num(o.count), failed);
	const firstError = typeof o.firstError === "string" ? o.firstError.slice(0, 200) : "";
	// A write that did not land and a tool call that returned an error are not the same event, and
	// the detail line is read by someone deciding whether data was LOST.
	const what = tool === "dedupe_upsert" ? `could not write ${failed} of ${total} record(s)` : `failed on ${failed} of ${total} record(s)`;
	return { failed, total, firstError, note: `${label} ${what}${firstError ? ` — ${firstError}` : ""}` };
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
	// The inner tool when the step dispatched one (#396) — a record's own trail said `enrich` and
	// left the reader to guess which tool produced the field sitting right next to it.
	const ran = result.dispatched ? `${step.tool} → ${result.dispatched}` : step.tool;
	return { step: `step ${index}: ${ran}`, detail: `${verb} ${bind}${count}`, at: new Date().toISOString() };
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

/** One reference found inside a step's input tree. */
export interface PipelineReference {
	kind: "ref" | "param";
	/** The reference as authored, e.g. "geo.lat" or "item.lng". */
	name: string;
	/** The first dotted segment — the only part knowable before the run. */
	root: string;
}

/**
 * Every `$ref` / `$param` in a value tree, in document order.
 *
 * Mirrors `resolveInputValue`'s dispatch EXACTLY (including `$param` winning over `$ref` on an
 * object carrying both), so what this walk sees is what the runner will actually resolve. Any
 * other object is a literal and is recursed into, which is how a reference nested inside an
 * `args`/`body`/`params` object is found.
 */
export function collectReferences(value: unknown): PipelineReference[] {
	const out: PipelineReference[] = [];
	const walk = (v: unknown): void => {
		if (v === null || typeof v !== "object") return;
		if (Array.isArray(v)) {
			for (const el of v) walk(el);
			return;
		}
		const obj = v as Record<string, unknown>;
		if (typeof obj.$param === "string") {
			out.push({ kind: "param", name: obj.$param, root: obj.$param.split(".")[0] });
			return;
		}
		if (typeof obj.$ref === "string") {
			out.push({ kind: "ref", name: obj.$ref, root: obj.$ref.split(".")[0] });
			return;
		}
		for (const nested of Object.values(obj)) walk(nested);
	};
	walk(value);
	return out;
}

/**
 * Static reference check for ONE step (issue #244) — the cheap half of "did the author mean
 * this?".
 *
 * `readPath` returns `undefined` the instant a segment is missing, and handlers treat absent as
 * *default* rather than error (`asArray(undefined)` → `[]`, `Number(undefined) || 0` → `0`). So a
 * typo'd bind, a forward reference to a LATER step's output, or an undeclared param all produce a
 * pipeline where every step succeeds, the run completes, and the data is empty or wrong — with no
 * failed step and no error row to notice. Nobody debugs a successful run.
 *
 * `knownBinds` is deliberately "the binds seen SO FAR", which is precisely the set of outputs that
 * will exist when this step runs — so typos and ordering mistakes are one check.
 *
 * Only the ROOT segment is checkable: a `$ref` into a step's output SHAPE isn't knowable ahead of
 * time. The root is where typos and ordering mistakes live.
 *
 * @param declaredParams the def's declared param names, or null to skip the param check (a def
 *   that declares none is not asserting a complete set — legacy/ad-hoc defs stay valid).
 */
export function stepReferenceError(
	step: PipelineStep,
	index: number,
	knownBinds: ReadonlySet<string>,
	declaredParams: ReadonlySet<string> | null,
): string | null {
	// `forEach` resolves against the same scope as the inputs, so it is checked identically.
	const refs = [...collectReferences(step.inputs ?? {}), ...collectReferences(step.forEach ?? null)];
	for (const r of refs) {
		if (r.kind === "ref") {
			if (!knownBinds.has(r.root)) {
				const known = [...knownBinds];
				return `Step ${index}: $ref "${r.name}" reads "${r.root}", which no earlier step binds${
					known.length ? ` (available: ${known.join(", ")})` : " (it is the first step — nothing is bound yet)"
				}. A $ref to a later step, or to a misspelt bind, resolves to undefined and the run completes on missing data.`;
			}
			continue;
		}
		// `item` / `item.<path>` inside a forEach body is scope-provided by the fan-out, not a
		// run param — resolveInputValue reads it off the current item.
		if (step.forEach !== undefined && (r.root === "item" || r.name === "item")) continue;
		if (declaredParams && !declaredParams.has(r.root)) {
			const known = [...declaredParams];
			return `Step ${index}: $param "${r.name}" is not declared in the pipeline's "params" (declared: ${known.join(", ") || "none"}). An undeclared param resolves to undefined and the run completes on missing data — declare it, or fix the name.`;
		}
	}
	return null;
}

/** Validate a candidate pipeline definition. Returns an error string, or null if valid.
 *  Boundary validation only (definitions come from stored config / API callers). */
export function validatePipeline(def: unknown): string | null {
	if (!def || typeof def !== "object" || Array.isArray(def)) return "Pipeline must be an object";
	const p = def as Record<string, unknown>;
	if (typeof p.name !== "string" || !p.name.trim()) return "Pipeline.name is required";
	if (!Array.isArray(p.steps) || p.steps.length === 0) return "Pipeline.steps must be a non-empty array";
	// The declared params, when the def declares any. A def that declares NONE isn't asserting a
	// complete set (`params` is optional and predates this check), so we don't reject its
	// `$param`s — but a def that does declare them gets the typo protection.
	const declared =
		p.params && typeof p.params === "object" && !Array.isArray(p.params) && Object.keys(p.params).length > 0
			? new Set(Object.keys(p.params as Record<string, unknown>))
			: null;
	const binds = new Set<string>();
	for (let i = 0; i < p.steps.length; i++) {
		const s = p.steps[i] as Record<string, unknown>;
		if (!s || typeof s !== "object") return `Step ${i} must be an object`;
		if (typeof s.tool !== "string" || !s.tool.trim()) return `Step ${i}: "tool" is required`;
		if (!getRegistryTool(s.tool as string)) return `Step ${i}: unknown tool "${s.tool}"`;
		if (s.inputs !== undefined && (typeof s.inputs !== "object" || s.inputs === null || Array.isArray(s.inputs))) {
			return `Step ${i}: "inputs" must be an object`;
		}
		// Check references BEFORE this step's own bind joins the set: a step cannot read its own
		// output, and "the binds so far" is exactly what will exist when this step runs (#244).
		const refErr = stepReferenceError(s as unknown as PipelineStep, i, binds, declared);
		if (refErr) return refErr;
		if (s.bind !== undefined) {
			if (typeof s.bind !== "string" || !s.bind.trim()) return `Step ${i}: "bind" must be a non-empty string`;
			if (binds.has(s.bind as string)) return `Step ${i}: duplicate bind "${s.bind}"`;
			binds.add(s.bind as string);
		}
		// The implicit bind: `stepBind` defaults to `step{index}`, so `$ref: "step3.foo"` is
		// legal without an explicit bind and must be a known name too.
		binds.add(`step${i}`);
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

/**
 * Parse a tool's string content as JSON when it looks like JSON, else return the string.
 *
 * The unwrap (#308): connectors that return remote text fence it at the source, because that is
 * the only place that covers chat, a pipeline step, the tools route and MCP at once. The binder is
 * not a model, and a fenced `web_search` result would make every downstream `$ref` resolve to
 * undefined — so the wrapper is removed before parsing. Non-JSON content is returned AS WRITTEN,
 * fence included: prose bound here can still end up in a prompt, and there it needs its fence.
 */
function parseOutput(content: string): unknown {
	const t = unfenceUntrusted(content).trim();
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
	/**
	 * The delegation pool this RUN draws against (#382), when the definition contains a step that
	 * would open a delegation tree (`lib/pipeline-budget.ts`).
	 *
	 * Threaded so every step — and every `forEach` iteration — shares ONE pool. Without it
	 * `delegateToInstance` took its `??` branch and opened a fresh ROOT pool per call, which made
	 * the #184 per-tree bound inert on the only path that can delegate on a schedule.
	 */
	budgetId?: string;
	/**
	 * The agent's declared tool allowlist (#381), resolved ONCE per run — per step it would be a
	 * D1 query per step.
	 *
	 * Forwarded onto every dispatch, where `runRegistryTool` applies it. Absent means the
	 * capabilities could not be read, and nothing is refused: a failed read is not evidence.
	 */
	declaredTools?: readonly string[];
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
	const def = getRegistryTool(step.tool);
	// The declared-tools gate (#381), refused BEFORE any input is resolved. `runRegistryTool` would
	// refuse it too — that is where the rule is enforced, including for a tool `enrich` names in
	// its inputs — but a `forEach` would refuse once per item, so the whole step is short-circuited
	// here on the same rule rather than N times on the far side of it.
	//
	// `budgetId` rides on the ctx built ONCE for the whole step, so a fan-out draws every iteration
	// against the same pool instead of opening one per item (#382). `stepTool` rides with it so a
	// tool this handler dispatches from inside itself is refused by NAME OF STEP (#396).
	const registryCtx = { env: ctx.env, userId: ctx.userId, instanceId: ctx.instanceId, traceId: ctx.traceId, budgetId: ctx.budgetId, declaredTools: ctx.declaredTools, stepTool: step.tool };
	const undeclared = undeclaredToolRefusal(step.tool, ctx.declaredTools, def?.connector);
	if (undeclared) return { tool: step.tool, bind, success: false, content: undeclared, output: null };

	// What this step will hand to `runRegistryTool` from inside its own handler, when it takes the
	// tool as an input (`enrich`). Read off the RESOLVED inputs, so a `$param`-supplied tool is
	// reported too — the case the trace could never answer before.
	const innerKey = def?.dispatchesFromInput;
	const dispatchedFrom = (input: Record<string, unknown>): string | undefined => {
		const v = innerKey ? input[innerKey] : undefined;
		return typeof v === "string" && v ? v : undefined;
	};

	if (step.forEach !== undefined) {
		const list = resolveInputValue(step.forEach, { outputs, params });
		if (!Array.isArray(list)) {
			return { tool: step.tool, bind, success: false, content: `forEach did not resolve to an array for step ${index}`, output: null };
		}
		const results: unknown[] = [];
		let allOk = true;
		let dispatched: string | undefined;
		for (const item of list) {
			const input = resolveInputs(step.inputs, { outputs, params, item });
			dispatched ??= dispatchedFrom(input);
			const r = await runRegistryTool(step.tool, registryCtx, input);
			if (!r.success) allOk = false;
			results.push(parseOutput(r.content));
		}
		return { tool: step.tool, bind, success: allOk, content: `${results.length} item(s)`, output: results, ...(dispatched ? { dispatched } : {}) };
	}

	const input = resolveInputs(step.inputs, { outputs, params });
	const dispatched = dispatchedFrom(input);
	const r = await runRegistryTool(step.tool, registryCtx, input);
	return { tool: step.tool, bind, success: r.success, content: r.content, output: parseOutput(r.content), ...(dispatched ? { dispatched } : {}) };
}

/**
 * Load a pipeline definition stored on the instance. Definitions live in the instance's
 * existing `agent_instances.config` JSON under `config.pipelines[name]` — the least-invasive
 * store (reuses the row already read by requireOwnedInstance; no new migration, and it's
 * editable via the instance-settings UI/MCP that already round-trips `config`). Returns the
 * def, or null if the instance/pipeline isn't found or the stored def is invalid.
 */
/**
 * Make a stored pipeline answer to exactly ONE name: the config key it is filed under (#173).
 *
 * Lookup has always been `config.pipelines[key]` — nothing resolves by `def.name`, and the prompt's
 * "Available Pipelines" block is built from the keys — so the def's own `name` field was free to
 * say something else, and did. The lead-finder instance was filed under `lead_finder` while its
 * def said `lead-finder`, which split the audit trail in two: `pipeline_runs.pipeline` (and the
 * board, and the console) recorded the KEY, while every log line the workflow writes —
 * `pipeline.start`, the per-step errors, `pipeline "<name>" crashed` — used `def.name`. One run
 * appeared under two spellings, so the run named in a crash message could not be found in the
 * runs table, and a reader reasonably concluded there were two pipelines and a name-mismatch bug.
 *
 * Normalising at ATTACH time fixes it at the source rather than patching each log site, and keeps
 * the key authoritative — which it already was for every decision that matters.
 */
export function pipelineDefForKey<T extends { name: string }>(key: string, def: T): T {
	return def.name === key ? def : { ...def, name: key };
}

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

/** What an instance actually has, split by whether the definition would run. */
export interface PipelineInventory {
	/** Names whose definition passes `validatePipeline` — the ones `loadPipeline` will return. */
	valid: string[];
	/** Names that are present but whose definition does not validate, so they can never run. */
	invalid: string[];
}

/**
 * The pipeline names an instance HAS, rather than whether it has one particular name (#363).
 *
 * `loadPipeline` collapses three different answers into a single `null`: no such name, a name
 * whose definition does not validate, and an instance whose config could not be read at all.
 * That is fine for the run path — all three mean "cannot run it" — but it is why a connection
 * naming a pipeline the target does not have was created without a word: the create-time check
 * could not tell "you typed it wrong" apart from "we could not look".
 *
 * Returns null for the third case only. A row that isn't there or a config that won't parse is a
 * FAILED READ, not evidence of absence, and the asymmetry #354 documents applies — ownership is
 * already proven by the time this runs, so refusing (or warning) on a null would turn a D1 blip
 * into a confidently-wrong claim about the user's wiring.
 */
export async function pipelineNamesFor(env: Env, instanceId: string, userId: string): Promise<PipelineInventory | null> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string }>();
	if (!row) return null;
	let cfg: Record<string, unknown>;
	try {
		cfg = JSON.parse(row.config || "{}") as Record<string, unknown>;
	} catch {
		return null;
	}
	return pipelineInventory(cfg.pipelines);
}

/**
 * Split a stored `config.pipelines` map into valid and invalid names. Pure, so the phrasing
 * rules in `connection-pipeline.ts` can be tested without a database.
 *
 * An instance with NO pipelines block resolves to an empty inventory, not null: "this agent has
 * no pipelines" is a fact we read successfully, and it is exactly the case a connection naming
 * one should be warned about.
 */
export function pipelineInventory(raw: unknown): PipelineInventory {
	const valid: string[] = [];
	const invalid: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { valid, invalid };
	for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
		if (def && validatePipeline(def) === null) valid.push(name);
		else invalid.push(name);
	}
	return { valid: valid.sort(), invalid: invalid.sort() };
}
