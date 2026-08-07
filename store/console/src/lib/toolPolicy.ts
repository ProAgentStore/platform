// What the Settings tab SAYS about an agent's tools — the console's half of #351.
//
// The server already resolves the two verdicts (`workers/api/src/lib/instance-tool-policy.ts`,
// exhaustively tested there): `allowed` answers "is this tool part of this agent", and the
// separate `writeConsent` answers "will the consent gate refuse it anyway". Both arrive on every
// row of `GET /v1/instances/:id/tools`.
//
// The console then made three READINGS of that list — the sentence above the switches, the chip
// beside each switch, and the set of write-access checkboxes underneath — and two of them
// disagreed, because each was written where it was rendered:
//
//   • the checkbox set counted a tool as write-capable when `scope === "write"` OR
//     `writeConsent === "per_call"`, which is what #351 fixed so `http_request` — honestly
//     scope:"read", because the CALLER picks the verb — has a switch for the grant its mutating
//     calls are refused for;
//   • the sentence counted only `scope === "write"`.
//
// So an agent whose one tool is `http_request` read: "This agent has no write tools — it can only
// read", directly above a checkbox offering to let it "act as you", with a chip on the very same
// row reading "writes need http access". Three statements, one list, no agreement.
//
// They are here, together, deriving from ONE predicate, so the next reading added is a call rather
// than a fourth opinion. Pure: no fetch, no JSX — the page renders what these return.

/** Mirrors ToolWriteConsent in workers/api/src/lib/instance-tool-policy.ts. */
export type ToolWriteConsent = "n/a" | "granted" | "required" | "per_call";

/** One row of `GET /v1/instances/:id/tools`, as the console reads it. */
export interface ToolPolicyEntry {
	name: string;
	connector?: string;
	scope: "read" | "write";
	description: string;
	allowed: boolean;
	disabled: boolean;
	reason: "ok" | "not_declared" | "disabled_by_owner";
	writeConsent?: ToolWriteConsent;
}

/**
 * The rows the tab lists: what this agent HAS, whether or not the owner has it switched on.
 *
 * `allowed || disabled` rather than `allowed`, because the two are the on and off positions of the
 * same switch — a tool the owner turned off is still one of this agent's tools, and it has to stay
 * on screen or there is nothing to turn back on. Everything else in the registry is `not_declared`
 * and belongs to some other agent.
 */
export function listedTools(policy: readonly ToolPolicyEntry[]): ToolPolicyEntry[] {
	return policy.filter((t) => t.allowed || t.disabled);
}

/**
 * Can this tool change something outside the platform — now, or the moment its connector is
 * granted?
 *
 * `scope` alone is not the question. A tool is scope:"read" when the tool itself does not choose
 * to write, which is exactly true of `http_request` (the caller names the method) and exactly
 * irrelevant to the person deciding whether to hand the agent a grant. `per_call` is the server
 * saying "this one is decided at call time" — i.e. it CAN write, subject to a gate. Both belong on
 * the same side of that decision.
 */
export function mayWrite(t: ToolPolicyEntry): boolean {
	return t.scope === "write" || t.writeConsent === "per_call";
}

/**
 * The connectors that get a write-access checkbox: every connector named by a write-capable tool
 * this agent has.
 *
 * Read off the server's own verdict rather than re-derived from tool names — the gate and the UI
 * must not be able to disagree about which grant a refusal is asking for. Stable under the tool
 * switches above it, because `listedTools` is: switching a tool off must not remove the grant
 * control for it, or turning it back on would silently re-arm an access the owner can no longer see.
 */
export function writeConnectors(policy: readonly ToolPolicyEntry[]): string[] {
	const out = new Set<string>();
	for (const t of listedTools(policy)) if (t.connector && mayWrite(t)) out.add(t.connector);
	return [...out];
}

/**
 * The sentence above the switches. Leading space: it is appended to the paragraph before it.
 *
 * Derived from {@link writeConnectors} — the checkbox set — and not from `scope`, so the claim and
 * the controls it points at ("granted below") are the same fact read twice rather than two facts.
 *
 * A write-capable tool with NO connector falls on the read side here, and that is correct rather
 * than a gap: `runRegistryTool` refuses a connector-less write tool outright, so operationally the
 * agent cannot use it to change anything, and there is no grant to offer for it either.
 */
export function toolScopeSummary(policy: readonly ToolPolicyEntry[]): string {
	return writeConnectors(policy).length > 0
		? " This agent has tools that can change things; each one also needs its connector granted below."
		: " This agent has no tools that can change anything — it can only read.";
}

/**
 * The consent state as a short chip, or null when nothing is in the way.
 *
 * Amber, not red, wherever this renders: an ungranted write tool is a switch the owner has not
 * flipped yet, not a fault. Null for a tool that is already refused for a reason the row states —
 * two explanations for one disabled switch is worse than one.
 */
export function consentChip(t: ToolPolicyEntry): string | null {
	if (!t.allowed) return null;
	if (t.writeConsent === "required") return `needs ${t.connector ?? "connector"} write access`;
	if (t.writeConsent === "per_call") {
		// MCP names its remote system at call time, so the connector row is only the outer gate and
		// the real reach is per (server, tool). Saying "needs mcp access" would point at a checkbox
		// that is already ticked.
		return t.connector === "mcp" ? "granted per server + tool" : `writes need ${t.connector ?? "connector"} access`;
	}
	return null;
}
