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
// Keep this file a LEAF: it takes the tool lookup as an argument rather than importing the
// registry, because the registry's own kick path (`tool-registry` → `pipeline-run-start`) reaches
// back here, and `import-graph.test.ts` fails on a module that joins that loop uninvited.
import { undeclaredToolRefusal } from "./tool-refusal.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

/** The only part of a pipeline definition this module reads. */
export interface ToolNamingSteps {
	steps: ReadonlyArray<{ tool: string }>;
}

/**
 * What the caller must be able to tell us about a tool: which connector provides it, if any.
 *
 * Structurally `getRegistryTool`, so the call site passes that function unchanged and a test can
 * pass a literal.
 */
export type RegistryToolLookup = (name: string) => { connector?: string } | undefined;

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
 * The distinct tools a definition's STEPS name that its agent does not declare, in first-use order.
 *
 * Steps only — the `enrich`-style nested tool is a value inside an input template and is not
 * knowable before the run, which is precisely why the enforcing gate is in `runRegistryTool` and
 * this one is an early warning rather than the whole answer.
 */
export function undeclaredPipelineTools(
	def: ToolNamingSteps,
	capabilities: AgentCapabilities | null | undefined,
	lookup: RegistryToolLookup,
): string[] {
	const declared = declaredToolsFor(capabilities);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const step of def.steps ?? []) {
		const name = step?.tool;
		if (typeof name !== "string" || seen.has(name)) continue;
		seen.add(name);
		if (undeclaredToolRefusal(name, declared, lookup(name)?.connector)) out.push(name);
	}
	return out;
}

/**
 * The AUTHORING-time refusal, or null when every step is declared.
 *
 * A definition naming a tool its agent cannot run is an authoring error, and finding it when the
 * pipeline is attached is strictly better than finding it eight steps into a run that has already
 * created a site. The human is present NOW; at run time nobody is.
 */
export function pipelineDeclarationError(
	def: ToolNamingSteps,
	capabilities: AgentCapabilities | null | undefined,
	lookup: RegistryToolLookup,
): string | null {
	const undeclared = undeclaredPipelineTools(def, capabilities, lookup);
	if (!undeclared.length) return null;
	return (
		`This pipeline uses ${undeclared.length === 1 ? "a tool" : "tools"} the agent does not declare: ${undeclared.join(", ")}. ` +
		"A pipeline can only run the tools its agent's capabilities.tools allows, so every step naming one of these would be refused. " +
		"Add them to the agent's declared tools, or change the pipeline."
	);
}
