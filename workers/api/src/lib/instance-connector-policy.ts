// Instance connector policy — which CONNECTORS are part of this agent, and why (#352).
//
// `instance-tool-policy.ts` answers exactly this question for tools, and for eleven of the
// fourteen connectors that IS the answer: a connector belongs to an agent precisely when one of
// its tools does. The three connected accounts declared in #352 Stage 1 break that rule, because
// they declare `tools: []` on purpose. Drive and WorkDrive are INGESTION sources — the user
// imports, or a `sync_connector` trigger does — not things an agent calls mid-turn, and inventing
// a `drive_read_file` so the tool gate had something to bite on was rejected on the issue as
// designing the gate backwards.
//
// The consequence was that they had no gate at all. Connect Drive ONCE, at account level, and the
// per-agent folder-grant panel came back on every instance the owner has, including terminal
// Operators that will never read a document. #353 and #355 both narrowed the same panel and
// neither could reach this, because both judged the ACCOUNT's state (can this deployment connect
// it, have you connected it) — which is identical for every agent by construction.
//
// The axis that separates agents already exists and is already declared: the tool allowlist. A
// file connector's ENTIRE effect on an agent is documents in that agent's knowledge base —
// `routes/drive.ts` says so in its own header, and the sync trigger takes the same path — so an
// agent that may not read its knowledge base cannot use one, whatever is connected. That is why
// this module adds no capability field and no new tool: it asks the SAME `toolNamesFor` set the
// chat runtime builds about a different tool.
//
// It began as an OFFER rule and is now also an ENFORCED one, in exactly one place: creating a
// folder grant. The two are the same question asked at different doors, and leaving the second
// unanswered left the first decorative — the console stopped showing the grant panel to an agent
// that cannot read a document, while MCP's `grant_instance_connector_folder` (and a bare curl at
// the same route) went on creating the grant anyway. `connectorRefusal` is the sentence that
// refusal uses, so the picker and the gate cannot say different things.
//
// What it is still NOT is a second gate on READING a folder already granted. That stays
// `requireConnectorGrant` on every Drive route plus the descent check, unchanged: an existing
// grant keeps working, because a rule about which agents may be GIVEN reach must not retroactively
// break the reach somebody already has and may still be using.
import { KB_READ } from "../agent-do-tools.js";
import type { Connector } from "./connectors/types.js";

/**
 * Why a connector is, or is not, part of this agent.
 *
 *   tools        — it provides tools and at least one of them is allowed here. The ordinary case,
 *                  and the same verdict `resolveToolPolicy` reached; this just reports it per
 *                  connector instead of per tool.
 *   knowledge    — it provides no tools and its content reaches the agent through the knowledge
 *                  base, which this agent may read.
 *   permission   — it provides no tools and holds no per-instance grant either, so its reach is
 *                  decided elsewhere: Gmail's `find_confirmation_link` is granted at runtime by
 *                  the owner's `AgentState.permissions.email` flag, which this policy deliberately
 *                  does not evaluate. Reporting it as allowed is the honest answer — softening or
 *                  duplicating that gate here would be a security change wearing a refactor's
 *                  clothes.
 *   no_tools     — it provides tools and this agent declares none of them.
 *   no_knowledge — it is an ingestion source and this agent may not read its knowledge base, so
 *                  nothing it imported could ever be seen.
 */
export type ConnectorPolicyReason = "tools" | "knowledge" | "permission" | "no_tools" | "no_knowledge";

export interface ConnectorPolicyEntry {
	id: string;
	label: string;
	grantModel: Connector["grantModel"];
	/**
	 * What granting this connector's WRITE scope permits, in the owner's terms (#720) — the
	 * connector's own `writeMeaning`, carried here so the console's consent checkbox can render a
	 * per-connector statement instead of one shared paragraph describing a browser.
	 *
	 * Absent for a read-only connector, and absent from an older API. The console falls back to the
	 * connector id and STILL RENDERS THE CHECKBOX: an unchecked box is a claim that the agent
	 * cannot act as you, so a missing sentence must cost the sentence and never the control.
	 *
	 * This does NOT make the connectors endpoint the source of the checkbox SET. That stays
	 * `writeConnectors(toolPolicy)` — the server's own tool verdict (#351) — so the gate and the UI
	 * cannot disagree about which grant a refusal is asking for. This is a lookup.
	 */
	writeMeaning?: string;
	/** The connector's own tool names — empty for the three connected accounts. */
	tools: string[];
	/** Is this connector part of this agent at all? */
	allowed: boolean;
	reason: ConnectorPolicyReason;
}

/** One connector's verdict, given the tool names this instance may actually run. */
export function connectorPolicyOf(connector: Connector, allowedTools: ReadonlySet<string>): ConnectorPolicyEntry {
	const tools = connector.tools.map((t) => t.name);
	const base = {
		id: connector.id,
		label: connector.label,
		grantModel: connector.grantModel,
		...(connector.writeMeaning ? { writeMeaning: connector.writeMeaning } : {}),
		tools,
	};
	if (tools.length > 0) {
		const allowed = tools.some((name) => allowedTools.has(name));
		return { ...base, allowed, reason: allowed ? "tools" : "no_tools" };
	}
	// A tool-less connector whose reach is a per-instance resource grant is a file connector: the
	// grant lets the platform import, and the import lands in the knowledge base. Keyed on the
	// declared `grantModel` rather than on the two ids, so a third file connector is gated by
	// declaring itself — which is the whole point of the registry.
	if (connector.grantModel === "instance-resource") {
		const allowed = KB_READ.some((name) => allowedTools.has(name));
		return { ...base, allowed, reason: allowed ? "knowledge" : "no_knowledge" };
	}
	return { ...base, allowed: true, reason: "permission" };
}

/**
 * Every connector's verdict for one instance. Pure — the caller resolves the allowed tool names,
 * so the same rule is testable in isolation and cannot drift between the route and the console.
 *
 * Returns EVERY connector, not just the allowed ones, for the reason `resolveToolPolicy` gives:
 * "what can this agent do" is only answerable if the answer says what it cannot, and why.
 */
export function resolveConnectorPolicy(
	connectors: readonly Connector[],
	allowedTools: ReadonlySet<string>,
): ConnectorPolicyEntry[] {
	return connectors.map((c) => connectorPolicyOf(c, allowedTools));
}

/**
 * Why this agent may not be given reach on this connector — the sentence a REFUSAL uses, or null
 * when nothing is in the way.
 *
 * Separate from `allowed` for the reason `explainWriteConsent` is separate from `writeConsent`: a
 * verdict is rendered by a console that can show its own words, but a 403 has one line to say what
 * happened and what to do instead, and that line must not be written twice. Both the grant routes
 * and anything else that refuses on this rule read it from here.
 *
 * It names the tools rather than the concept, because "declare a knowledge tool" is not actionable
 * and `search_knowledge` is: the fix is a capability edit on the agent, and the owner has to know
 * which field.
 */
export function connectorRefusal(entry: ConnectorPolicyEntry): string | null {
	if (entry.allowed) return null;
	if (entry.reason === "no_knowledge") {
		return `This agent cannot use ${entry.label}: everything a file connector imports lands in the agent's knowledge base, and this agent declares none of the tools that read one (${KB_READ.join(", ")}). Give the folder to an agent that reads its knowledge base, or declare one of those tools on this one.`;
	}
	if (entry.reason === "no_tools") {
		return `This agent cannot use ${entry.label}: it declares none of that connector's tools (${entry.tools.join(", ")}). Declare one on the agent, or pick an agent that has it.`;
	}
	return null;
}
