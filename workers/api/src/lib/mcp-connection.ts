// Connection diagnostics for a user-named outbound MCP endpoint (#266, and the
// "connection test exposes actionable diagnostics" half of #265).
//
// WHY A SEPARATE MODULE. The connector (connectors/mcp.ts) knows how to talk to a server; it
// does not know what the OWNER is allowed to do with it. A test that answers only "did the
// HTTP call work" is the lie this module exists to prevent: an endpoint can be perfectly
// reachable and still be unable to run a single tool, because reach is granted per (instance,
// endpoint, tool) (#262) UNDER the connector-level write gate (#90) UNDER the agent's declared
// tool allowlist. Three independent gates, any of which silently makes "connected" useless.
//
// So the report answers the whole question in one shape:
//
//   reachable?  →  status + failure class + the actionable detail text
//   which era?  →  era + negotiated protocol version
//   what tools? →  the server's own catalog (tools/list — read-scoped, needs no consent, which
//                  is exactly what makes per-tool consent usable: you cannot approve tools you
//                  cannot enumerate)
//   may I call them?  →  per tool: granted / callable / what is blocking it
//
// Everything here is PURE. The network lives in connectors/mcp.ts (behind safeFetch) and the
// D1 reads live in the route; this file only decides what the answer MEANS, so the taxonomy the
// console renders and the taxonomy the tests assert on cannot drift apart.
//
// DESTRUCTIVENESS IS STILL JUDGED ON THE NAME. A server publishes `annotations.destructiveHint`
// on each tool and it is right there in the catalog we just parsed. It is deliberately ignored:
// the annotation is authored by the party being defended against, so believing it would let a
// server relabel `delete_everything` as safe and collect a wildcard grant. `isDestructiveToolName`
// runs on the name WE would put on the wire, exactly as the enforcement does.
import { ALL_TOOLS, grantsAllowTool, isDestructiveToolName, type McpConsentRow } from "./mcp-consent.js";
import type { McpEra, McpFailureClass } from "./connectors/mcp.js";

/**
 * What a connection attempt concluded. Deliberately finer-grained than ok/failed, because each
 * of these has a DIFFERENT remedy and a single "connection failed" sends the user to check the
 * wrong thing.
 *
 * On a REJECTED token: a server answers 401/403 and says nothing about why, so expired, revoked
 * and never-valid are indistinguishable on the wire. There is no status that claims otherwise —
 * `auth_required` names what we actually know and the detail text says the token was rejected.
 *
 * `credential_expired` is the one case where expiry is a FACT rather than a guess: we stored an
 * expiry alongside the credential ourselves (#286), it has passed, and nothing was sent. It is
 * distinct from `credential_missing` because the remedies differ — reconnect that server, versus
 * add a token for it — and a single "not connected" sends people to do the wrong one.
 */
export type McpConnectionStatus =
	| "connected"
	| "credential_missing"
	| "credential_expired"
	| "auth_required"
	| "unsupported_protocol"
	| "unreachable"
	| "blocked"
	| "permission_denied"
	| "invalid_url";

/** Why a discovered tool cannot be called right now. Null when it can. */
export type McpToolBlocker = "no_grant" | "wildcard_excludes_destructive" | "no_write_consent" | "tool_disabled";

export interface McpToolSummary {
	name: string;
	description?: string;
	/** Our own name test — never the server's `destructiveHint`. */
	destructive: boolean;
	/** Does a per-(endpoint, tool) grant cover it? */
	granted: boolean;
	/** Could `mcp_call_tool` actually run it right now — all three gates satisfied? */
	callable: boolean;
	blockedBy?: McpToolBlocker;
}

/** The three gates a real call passes, reported so "connected but useless" is never silent. */
export interface McpGateState {
	/** The agent declares `mcp_call_tool` and the owner has not switched it off. */
	callToolEnabled: boolean;
	/** Connector-level write consent for `mcp` (#90) — the kill switch. */
	writeConsent: boolean;
}

export interface McpConnectionReport {
	/** Normalized endpoint — the form consent and the trace log key on. */
	endpoint: string;
	status: McpConnectionStatus;
	/** One actionable sentence. Already redacted upstream; never contains a credential. */
	detail: string;
	failure?: McpFailureClass;
	era?: McpEra;
	protocolVersion?: string;
	httpStatus?: number;
	durationMs: number;
	tools: McpToolSummary[];
	/** How many tools the server published (before any gate). */
	toolCount: number;
	/** How many of them this instance could actually call right now. */
	callableCount: number;
	gates: McpGateState;
	/** What the server's own OAuth metadata says, when it published any (#180/#181). */
	auth?: {
		protectedResource: boolean;
		authorizationServer?: string;
		dynamicRegistration?: boolean;
		unattended?: string;
	};
}

/**
 * Map a connector failure class onto the connection taxonomy. Kept as a total function over the
 * union so a new failure class in connectors/mcp.ts is a typecheck failure here rather than a
 * silent fall-through to "unreachable" — which is the reading that sends a user to check their
 * network when the real problem was their token.
 */
export function connectionStatusFor(failure: McpFailureClass | undefined, ok: boolean): McpConnectionStatus {
	if (ok) return "connected";
	switch (failure) {
		case "bad_input":
			return "invalid_url";
		case "no_credential":
			return "credential_missing";
		case "credential_expired":
			return "credential_expired";
		case "auth":
			return "auth_required";
		case "denied":
			return "permission_denied";
		case "unsupported_version":
		case "header_mismatch":
		case "missing_capability":
			return "unsupported_protocol";
		case "blocked":
			return "blocked";
		case "rpc_error":
		case "tool_error":
		case "unparseable":
		case "network":
		case undefined:
			return "unreachable";
		default:
			return "unreachable";
	}
}

/** A raw entry as published by a server's `tools/list`. */
interface RawTool {
	name?: unknown;
	description?: unknown;
}

/**
 * Pull the tool catalog out of a `tools/list` result.
 *
 * Tolerant on shape and hard on content: a server may answer `{tools:[…]}` (the spec), a bare
 * array, or wrap it a level deeper, and none of those should read as "this server has no tools"
 * — but a name that isn't a non-empty string is dropped, because everything downstream (the
 * consent row, the `Mcp-Name` header) treats the name as an identifier.
 *
 * Bounded at 500 entries and 300 description characters: the catalog is remote, attacker-shaped
 * data on its way into a JSON response and a rendered list.
 */
export function parseToolCatalog(raw: unknown): Array<{ name: string; description?: string }> {
	let list: unknown = raw;
	if (list && typeof list === "object" && !Array.isArray(list)) {
		const r = list as Record<string, unknown>;
		list = Array.isArray(r.tools) ? r.tools : Array.isArray(r.result) ? r.result : (r.result as Record<string, unknown> | undefined)?.tools;
	}
	if (!Array.isArray(list)) return [];
	const out: Array<{ name: string; description?: string }> = [];
	for (const entry of list.slice(0, 500)) {
		if (!entry || typeof entry !== "object") continue;
		const t = entry as RawTool;
		const name = typeof t.name === "string" ? t.name.trim() : "";
		if (!name) continue;
		const description = typeof t.description === "string" && t.description.trim() ? t.description.trim().slice(0, 300) : undefined;
		out.push({ name, description });
	}
	return out;
}

/**
 * Decide, per discovered tool, whether a real `mcp_call_tool` would go through — and if not,
 * which gate stops it. The order matters: it reports the gate the user must fix FIRST, so
 * "grant this tool" is never suggested to someone whose connector write access is off (they
 * would grant it and still be refused, which reads as the grant not working).
 *
 * `grantsAllowTool` is the same predicate the enforcement runs, imported rather than restated —
 * a diagnostic that re-derives the rule is a diagnostic that will eventually disagree with it.
 */
export function summarizeTools(
	discovered: ReadonlyArray<{ name: string; description?: string }>,
	grantsForEndpoint: ReadonlyArray<Pick<McpConsentRow, "tool">>,
	gates: McpGateState,
): McpToolSummary[] {
	const hasWildcard = grantsForEndpoint.some((g) => g.tool === ALL_TOOLS);
	return discovered.map((t) => {
		const destructive = isDestructiveToolName(t.name);
		const granted = grantsAllowTool(grantsForEndpoint, t.name);
		let blockedBy: McpToolBlocker | undefined;
		if (!gates.callToolEnabled) blockedBy = "tool_disabled";
		else if (!gates.writeConsent) blockedBy = "no_write_consent";
		else if (!granted) blockedBy = hasWildcard && destructive ? "wildcard_excludes_destructive" : "no_grant";
		return { name: t.name, description: t.description, destructive, granted, callable: !blockedBy, blockedBy };
	});
}

/** Human-readable remedy for a blocked tool — one string, shared by the console and any API caller. */
export function explainBlocker(blocker: McpToolBlocker, tool: string): string {
	switch (blocker) {
		case "tool_disabled":
			return `This agent cannot run mcp_call_tool, so no MCP tool is callable. Enable it under Settings → Tools.`;
		case "no_write_consent":
			return `MCP write access is off for this agent, so nothing on any server is callable. Turn it on under Agent write access.`;
		case "wildcard_excludes_destructive":
			return `"${tool}" reads as destructive, so the "all tools" grant deliberately does not cover it — approve it by name.`;
		case "no_grant":
			return `This agent has no grant for "${tool}" on this server.`;
	}
}

/**
 * The headline sentence. Written so the status alone is never the whole message: a "connected"
 * that can call nothing is the exact outcome this ticket calls a lie, so the success text keeps
 * counting until the numbers agree.
 */
export function summarizeConnection(report: Omit<McpConnectionReport, "detail">, transportDetail: string): string {
	if (report.status !== "connected") return transportDetail;
	const { toolCount, callableCount } = report;
	const era = report.protocolVersion ? ` Protocol ${report.protocolVersion} (${report.era} transport).` : "";
	if (toolCount === 0) return `Connected, but this server publishes no tools.${era}`;
	if (callableCount === 0) {
		return `Connected — ${toolCount} tool${toolCount === 1 ? "" : "s"} found, but this agent may call none of them yet.${era}`;
	}
	if (callableCount === toolCount) return `Connected — all ${toolCount} tool${toolCount === 1 ? "" : "s"} are callable by this agent.${era}`;
	return `Connected — ${callableCount} of ${toolCount} tools are callable by this agent.${era}`;
}
