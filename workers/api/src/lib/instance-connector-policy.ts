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
// What this is NOT: a new enforcement point. The connectors it can answer `false` for have no
// tools, so there is nothing to enforce against and nothing here fails closed — the reach of a
// folder grant is still `requireConnectorGrant` on every Drive route, unchanged. What it governs
// is whether an agent is OFFERED a connector, which is the comprehension problem #352 is about.
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
	/** The connector's own tool names — empty for the three connected accounts. */
	tools: string[];
	/** Is this connector part of this agent at all? */
	allowed: boolean;
	reason: ConnectorPolicyReason;
}

/** One connector's verdict, given the tool names this instance may actually run. */
export function connectorPolicyOf(connector: Connector, allowedTools: ReadonlySet<string>): ConnectorPolicyEntry {
	const tools = connector.tools.map((t) => t.name);
	const base = { id: connector.id, label: connector.label, grantModel: connector.grantModel, tools };
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
