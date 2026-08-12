/**
 * A tool that is refused by DECISION on this surface is not offered on it (#517 step 3).
 *
 * ── What happened
 *
 * A creator asked their tmux Operator, on the console's agent page, to list tmux sessions. The call
 * was refused — correctly — by the capability-constraint gate, whose result ends with the true
 * remedy: run this from a subscribed instance. The reply said instead to "go to Settings →
 * Connections in the console and connect a tmux instance", a control that exists on no console
 * screen. Reproduced 5/5 before the prompt clause in connector-tool-prompt.ts, and 4 of 14 after
 * it — a prompt rule made the false statement less likely and could not make it impossible.
 *
 * ── Why the invention was so hard to talk the model out of
 *
 * It was not invented from nothing. `agent-think.ts` reads write consent with
 * `listConsents(env, state.agentId)`, and consent rows are keyed by INSTANCE id — so on the
 * agent-template surface, where that id is an AGENT id, the read returns nothing and
 * `writeConsentOf` reports "required" for every write tool the agent holds. The tmux Operator's
 * five writes therefore each rendered "[write — consent NOT granted …]", and `CONSENT_RULE`
 * directly above instructs the model to point the owner at console → Settings → Connections. The
 * prompt licensed the remedy; the model used it. The precondition was an artefact of asking a
 * per-instance question on a surface that has no instance.
 *
 * ── What this does instead
 *
 * On that surface EVERY tool of a connector in `CONNECTOR_CONSTRAINTS` is refused, always, by a
 * decision recorded in `docs/capability-constraints.md`: `lookupConnectorConstraints` joins
 * `agent_instances` only, and #441 deliberately declined to give it the `agents`-row fallback that
 * `resolveAgentCapabilities` has. So the tools are withheld there, which removes the consent lines
 * whose precondition was false, empties the CONNECTED TOOLS block for an agent that holds only
 * those tools, and leaves the model with nothing to explain and no remedy to substitute.
 *
 * Nothing that worked stops working: the withheld calls could only ever return a refusal.
 *
 * ── Why filtering the DECLARED list is the whole of it
 *
 * A constrained connector's tools are reachable through exactly one path: a declared
 * `capabilities.tools` allowlist. None of `BASE`, `KB_READ`, `KB_WRITE`, `FILES`, `COLLECTIONS`,
 * `APPLY`, `CODING` or their union `FULL` contains a `terminal_*` or `tmux_*` name, so an agent
 * that declares nothing cannot receive one by default — which is what makes this provably a no-op
 * for every agent that does not declare one, asserted by reference equality in the tests rather
 * than reviewed by eye.
 *
 * The empty case is the one trap. `toolNamesFor` treats an empty `tools` array exactly like an
 * absent one and falls through to `FULL`, so an agent whose entire declaration is withheld — the
 * tmux Operator, whose seven tools are all `tmux_*` — would silently GAIN the full toolset. It is
 * given `BASE` explicitly instead, which is not a placeholder but the honest declaration of what
 * is left: `toolNamesFor` seeds `BASE` unconditionally, so the resolved set is identical either
 * way, and the array says so where the empty one would have lied.
 */
import { BASE } from "../agent-do-tools.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import { CONNECTOR_CONSTRAINTS } from "./surface-options.js";
import { registryTools } from "./tool-registry.js";

/** Capabilities as this surface may use them, plus the connectors that lost their tools. */
export interface TemplatePreviewCapabilities {
	capabilities: AgentCapabilities;
	/** Connector ids whose tools were withheld — empty when nothing was, which is the usual case. */
	previewWithheld: string[];
}

/**
 * The connector a tool belongs to, but only when that connector has a constraint vocabulary.
 * Derived from the registry rather than a second list of names: `CONNECTOR_CONSTRAINTS` is keyed
 * by connector, the registry knows each tool's connector, and a third copy of the mapping is how
 * the two would drift the next time a connector gains a ceiling.
 */
export function constrainedConnectorOf(toolName: string): string | null {
	const tool = registryTools().find((t) => t.name === toolName);
	const connector = tool?.connector;
	return connector && CONNECTOR_CONSTRAINTS[connector] ? connector : null;
}

/**
 * Withhold the tools that this surface can only ever refuse.
 *
 * Returns the SAME capabilities object when nothing is withheld — reference equality, so a
 * subscribed instance's prompt and every unconstrained agent's are unreachable from here rather
 * than merely unchanged in the cases someone thought to test.
 */
export function withholdConstrainedConnectorTools(capabilities: AgentCapabilities): TemplatePreviewCapabilities {
	const declared = capabilities.tools;
	if (!declared?.length) return { capabilities, previewWithheld: [] };
	const withheld = new Set<string>();
	const kept = declared.filter((name) => {
		const connector = constrainedConnectorOf(name);
		if (connector) withheld.add(connector);
		return !connector;
	});
	if (withheld.size === 0) return { capabilities, previewWithheld: [] };
	return {
		capabilities: { ...capabilities, tools: kept.length ? kept : [...BASE] },
		previewWithheld: [...withheld].sort(),
	};
}

/**
 * The one true sentence that replaces what was withheld, or "" when nothing was.
 *
 * Withholding alone would leave the model an agent that cannot do the thing it is named for and no
 * account of why — which is the same vacuum the invention grew in. What it must NOT say is that
 * anything can be switched on: the whole defect was a remedy pointing at a control that does not
 * exist, so the sentence states the fact (a ceiling and a machine both belong to an instance) and
 * names the only real action, which is to subscribe.
 */
export function templatePreviewNote(previewWithheld: readonly string[]): string {
	if (previewWithheld.length === 0) return "";
	const list = previewWithheld.join(" and ");
	return (
		`\n\nYou are being PREVIEWED from the agent template, not run from a subscribed instance. Your ${list}` +
		" tools are deliberately not available here and are not in your tool list above: they are resolved per" +
		" subscribed instance — the machine they reach and the limits they run under both belong to one — so from" +
		" a template preview or trial chat there is nothing for them to address. This is NOT a setting, permission" +
		" or connection anyone can switch on, and there is no console page for it. If you are asked to do" +
		` ${list} work, say plainly that it has to be done from a subscribed instance of this agent, and answer` +
		" everything else normally."
	);
}
