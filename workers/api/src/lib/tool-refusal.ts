/**
 * WHY a tool is refused, the sentence that says so, and the declared-allowlist rule itself — a
 * leaf (#381).
 *
 * These declarations are pure and shared by every surface that can refuse a tool call:
 * `instance-tool-policy.ts` (the generic invoker + the console listing), `runRegistryTool` (the
 * single dispatch path) and `pipeline-tool-policy.ts` (a pipeline definition, checked at authoring
 * time). They lived inside `instance-tool-policy.ts`, which imports the tool catalog, the registry
 * and the consent store — so a module that wanted nothing but the rule had to take the whole
 * capability graph with it, and in this Worker that closes a cycle through `tool-registry` →
 * `steps` → … → `pipeline-run-start` (see `import-graph.test.ts`).
 *
 * Same move `connectors/types.ts` made for the tool contract, for the same reason: the old home
 * re-exports the names it used to own, so every existing import keeps working.
 *
 * Keep this file a LEAF. It imports nothing; adding an import is how the cycle comes back.
 */

/**
 * Why a tool is or isn't runnable — surfaced to the UI/MCP so "blocked" is never a mystery.
 *
 * `needs_permission` (#721) is the fourth, and it exists because `not_declared` was answering for
 * it and answering wrongly. A tool granted by an OWNER PERMISSION rather than by the creator's
 * `capabilities.tools` — today only `find_confirmation_link`, which reads the owner's Gmail on
 * `AgentState.permissions.email` — can never appear in a declaration, so the listing could only
 * ever say "not one of this agent's tools". That is false in the way that matters: it IS this
 * agent's, one checkbox away, and the checkbox is thirty-one pixels below the panel saying
 * otherwise. The two need different fixes (edit the agent vs. tick a permission), which is the
 * same distinction `disabled_by_owner` was split out for.
 */
export type ToolPolicyReason = "ok" | "not_declared" | "disabled_by_owner" | "needs_permission";

/** Human-readable refusal, so an API 403, a pipeline step and an agent's own error all say the
 *  same thing about the same tool. */
export function explainRefusal(name: string, reason: ToolPolicyReason): string {
	if (reason === "disabled_by_owner") {
		return `"${name}" is switched off for this agent. Turn it back on in the console (Settings → Tools) to use it.`;
	}
	if (reason === "needs_permission") {
		return `"${name}" needs a permission this agent has not been given. Grant it in the console (Settings → Permissions & Connections) to use it.`;
	}
	return `"${name}" is not one of this agent's tools. It can only run the tools its agent declares.`;
}

/**
 * Does this verdict mean the tool is not part of this agent AT ALL — as opposed to being its tool
 * with the owner's switch off?
 *
 * Two members answer yes and they are not interchangeable with each other, only with respect to
 * this one question: an undeclared tool needs a capability edit, an ungranted one needs a
 * permission ticked. Both are "there is nothing here to switch", which is what every caller
 * refusing on absence actually wants — and writing that as a two-armed `||` at each of them is how
 * `needs_permission` would have been forgotten at the second one (#721).
 */
export function agentLacksTool(reason: ToolPolicyReason): boolean {
	return reason === "not_declared" || reason === "needs_permission";
}

/**
 * The same refusal, when the tool was reached from INSIDE another one (#396).
 *
 * `geocode`, `fan_out` and `enrich` dispatch a registry tool their step never names, so the plain
 * sentence above sends the author hunting through a definition for `http_request` and finding
 * nothing. Naming the step is the difference between a message that is true and one that is
 * actionable — it says which line to look at and which two fixes exist.
 */
export function explainNestedRefusal(name: string, stepTool: string): string {
	return `"${stepTool}" needs "${name}", which is not one of this agent's tools. It can only run the tools its agent declares — add "${name}" to them, or drop the "${stepTool}" step.`;
}

/**
 * The declared-allowlist rule for ONE tool call — the refusal to report, or null to proceed (#381).
 *
 * Three ways to pass, and each is a decision worth stating:
 *
 *  • `declaredTools` absent — the CALLER did not resolve an allowlist, so nothing is asserted and
 *    nothing is refused. That covers every surface with its own gate (the chat runtime builds its
 *    tool list from `toolNamesFor`; the /tools invoker consults `resolveToolPolicy`) and it covers
 *    a capability lookup that came back empty, which is a FAILED READ rather than evidence — the
 *    asymmetry `instanceToolPolicy` and `delegationDenial` already document.
 *  • no `connector` — the tool is not in `TOOL_CATALOG` and no creator could declare it. The
 *    pipeline step library (`steps.ts`) and the connector-less first-party tools are in this class:
 *    gating them would refuse work against a vocabulary that cannot express it. Derived from the
 *    tool's own declaration, so a tool that later gains a connector comes under the rule by itself.
 *  • the allowlist names it — the ordinary allow.
 *
 * Deliberately NOT the owner's per-instance off-switch (`config.disabledTools`). That gate answers
 * "has the subscriber vetoed their own copy", not "is this tool part of this agent", and folding
 * the two is what `instance-tool-policy.ts` explicitly refuses to do.
 */
export function undeclaredToolRefusal(
	name: string,
	declaredTools: readonly string[] | null | undefined,
	connector: string | undefined,
	/** The step whose handler is dispatching this, when it is not the step's own tool (#396). */
	stepTool?: string,
): string | null {
	if (!declaredTools || !connector || declaredTools.includes(name)) return null;
	return stepTool && stepTool !== name ? explainNestedRefusal(name, stepTool) : explainRefusal(name, "not_declared");
}
