// Is a pipeline's tool part of the agent that runs it? (#381)
//
// `capabilities.tools` is the authoritative allowlist of what an agent may reach, and three
// surfaces enforce it through `toolNamesFor`: the chat runtime (`agent-think.ts`), the generic
// invoker (`instance-tool-policy.ts`, which reports an undeclared tool as `not_declared`) and the
// supervision wiring check (`supervision-capability.ts`). `lib/pipeline.ts` did not. Its step
// dispatch goes through `runRegistryTool`, which enforces connector SCOPE (#86) and per-instance
// write CONSENT (#90) — different questions, both about the external system, neither about whether
// the tool belongs to this agent at all. So a stored pipeline definition could call ANY tool in the
// registry, including one the agent's own console renders as `not_declared`.
//
// That matters most on this surface precisely because a pipeline is DATA: `agents.config.pipelines`
// is copied into every new instance on subscribe, and #141 lets capabilities be declared from
// config. The declared allowlist is the mechanism that is supposed to make that safe. It also
// matters most in cost and reach: a pipeline is the one caller that runs on a timer with nobody
// present, and `tmux_run_command` is a registry tool.
//
// ── Where the gate actually lives
//
// The RULE is `undeclaredToolRefusal` (`tool-refusal.ts`) and it is applied inside
// `runRegistryTool`, the one path every dispatch goes through — NOT only against a step's `tool`
// field. That distinction is load-bearing: `enrich` takes the tool to run as an INPUT and
// re-dispatches it per record, so a gate that only read step names would have been walked straight
// past by `{"tool":"enrich","inputs":{"tool":"tmux_run_command"}}`.
//
// What lives HERE is the same rule asked of a whole definition ahead of time, so an authoring
// mistake is a 400 on attach rather than a refusal eight steps into a run that has already spent
// money. Same argument `create_connection` makes for validating its filter at create time.
//
// ── What a step NAMES vs what it RUNS (#396)
//
// The first version of this check read only `steps[].tool`, and three step handlers dispatch a
// connector tool from inside themselves: `geocode` and `fan_out` (`http_request`) and `enrich` (a
// tool named in its own inputs). All three are step-library tools with no `connector`, so they are
// exempt by the rule above — which meant a definition built entirely from them passed attach AND
// kick, and was then refused by `runRegistryTool` mid-run. The guarantee inverted: the run started,
// spent, and stopped part-way, which is the outcome the kick check exists to prevent.
//
// So a handler now DECLARES what it may dispatch (`ToolDef.dispatches` / `dispatchesFromInput`),
// beside the handler that does it, and this walk unions those with the step names. The declaration
// cannot be forgotten because `step-dispatch.test.ts` derives the same table from the handler
// source and fails when a `runRegistryTool` call is not covered by it.
//
// Keep this file a LEAF: it takes the tool lookup as an argument rather than importing the
// registry, because the registry's own kick path (`tool-registry` → `pipeline-run-start`) reaches
// back here, and `import-graph.test.ts` fails on a module that joins that loop uninvited.
import { undeclaredToolRefusal } from "./tool-refusal.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

/** The only part of a pipeline definition this module reads. */
export interface ToolNamingSteps {
	steps: ReadonlyArray<{ tool: string; inputs?: Record<string, unknown> }>;
}

/**
 * What the caller must be able to tell us about a tool: which connector provides it, and what it
 * dispatches from inside itself.
 *
 * Structurally `getRegistryTool`, so the call site passes that function unchanged and a test can
 * pass a literal.
 */
export type RegistryToolLookup = (
	name: string,
) => { connector?: string; dispatches?: readonly string[]; dispatchesFromInput?: string } | undefined;

/** One tool a definition would reach, and the step that reaches it. */
export interface PipelineToolUse {
	/** The registry tool that will actually be dispatched. */
	tool: string;
	/** Index of the step that reaches it — where the author has to look. */
	index: number;
	/** The step's own `tool` field, i.e. the name that appears in the definition. */
	step: string;
	/** How the step reaches it: it IS the step, the handler dispatches it, or its inputs name it. */
	via: "step" | "dispatch" | "input";
}

/**
 * Every registry tool a single step would reach — itself, plus whatever its handler dispatches.
 *
 * `dispatchesFromInput` is resolved only for a LITERAL string, which is what an author writes and
 * what every reference pipeline contains. A `{"$param":"tool"}` is not knowable here at all, and
 * pretending otherwise would put a guess in a message the author is meant to trust.
 */
function stepToolUses(step: { tool: string; inputs?: Record<string, unknown> }, index: number, lookup: RegistryToolLookup): PipelineToolUse[] {
	const name = step?.tool;
	if (typeof name !== "string") return [];
	const uses: PipelineToolUse[] = [{ tool: name, index, step: name, via: "step" }];
	const def = lookup(name);
	for (const nested of def?.dispatches ?? []) uses.push({ tool: nested, index, step: name, via: "dispatch" });
	const key = def?.dispatchesFromInput;
	const fromInput = key ? step?.inputs?.[key] : undefined;
	if (typeof fromInput === "string" && fromInput) uses.push({ tool: fromInput, index, step: name, via: "input" });
	return uses;
}

/** The one-line "step N runs X" clause, so the author reads a location rather than a bare name. */
function describeUse(use: PipelineToolUse): string {
	if (use.via === "step") return `step ${use.index} runs "${use.tool}"`;
	if (use.via === "input") return `step ${use.index} ("${use.step}") runs "${use.tool}" per record`;
	return `step ${use.index} ("${use.step}") needs "${use.tool}"`;
}

/**
 * The allowlist to carry on a run's tool context, or undefined when there is nothing to assert.
 *
 * Undefined for a capability lookup that came back null — a failed read is not evidence that the
 * agent declared nothing, and refusing on evidence we do not have would turn a D1 blip into a
 * stopped pipeline. An agent that resolved fine but declares no `tools` yields an EMPTY array,
 * which is a real assertion: it declares no connector tools, exactly as its chat has always had
 * none (`toolNamesFor`'s surface defaults contain no connector tool either).
 */
export function declaredToolsFor(capabilities: AgentCapabilities | null | undefined): string[] | undefined {
	return capabilities ? (capabilities.tools ?? []) : undefined;
}

/**
 * Every undeclared tool a definition would REACH, in first-use order, each with the step that
 * reaches it.
 *
 * Deduped by TOOL rather than by (step, tool): the first step that needs it is the one worth
 * naming, and repeating "add http_request" six times trains the reader to skim. Still an early
 * warning rather than the whole answer — a step whose `enrich` tool comes from a `$param` is only
 * knowable at dispatch, which is where the enforcing gate is.
 */
export function undeclaredPipelineTools(
	def: ToolNamingSteps,
	capabilities: AgentCapabilities | null | undefined,
	lookup: RegistryToolLookup,
): PipelineToolUse[] {
	const declared = declaredToolsFor(capabilities);
	const out: PipelineToolUse[] = [];
	const seen = new Set<string>();
	const steps = def.steps ?? [];
	for (let i = 0; i < steps.length; i++) {
		for (const use of stepToolUses(steps[i], i, lookup)) {
			if (seen.has(use.tool)) continue;
			seen.add(use.tool);
			if (undeclaredToolRefusal(use.tool, declared, lookup(use.tool)?.connector)) out.push(use);
		}
	}
	return out;
}

/**
 * The AUTHORING-time refusal, or null when every step is declared.
 *
 * A definition naming a tool its agent cannot run is an authoring error, and finding it when the
 * pipeline is attached is strictly better than finding it eight steps into a run that has already
 * created a site. The human is present NOW; at run time nobody is.
 *
 * The message leads with the STEP, not the tool (#396). "http_request is not declared" against a
 * definition whose steps are `geocode` and `map` reads as a bug in the platform; `step 0
 * ("geocode") needs "http_request"` reads as something to fix.
 */
export function pipelineDeclarationError(
	def: ToolNamingSteps,
	capabilities: AgentCapabilities | null | undefined,
	lookup: RegistryToolLookup,
): string | null {
	const undeclared = undeclaredPipelineTools(def, capabilities, lookup);
	if (!undeclared.length) return null;
	const names = undeclared.map((u) => u.tool);
	return (
		`This pipeline uses ${undeclared.length === 1 ? "a tool" : "tools"} the agent does not declare: ${undeclared.map(describeUse).join("; ")}. ` +
		"A pipeline can only run the tools its agent's capabilities.tools allows, so those steps would be refused. " +
		`Add ${names.join(", ")} to the agent's declared tools, or change the pipeline.`
	);
}
