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
import type { McpEra, McpFailureClass, McpSurfaceProbe, McpSurfaceState } from "./connectors/mcp.js";

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

/**
 * One read surface — resources or prompts (#263) — as the connection test found it.
 *
 * WHY THIS IS NOT FOLDED INTO `gates`. The read surfaces pass a DIFFERENT set of gates from
 * `mcp_call_tool`, and saying otherwise would be the same lie in a new place. They are
 * read-scoped, so the connector-level write kill switch and the per-(endpoint, tool) grant do
 * not apply to them at all — the ONLY gate is the agent's declared tool allowlist. Reporting
 * `writeConsent` next to a resource count would send an owner to flip a switch that changes
 * nothing here.
 *
 * WHY `listEnabled` MATTERS EVEN THOUGH WE GOT A COUNT. The probe runs server-side, on the
 * owner's authority, so it enumerates a server the AGENT may be unable to enumerate. A report
 * that printed "3 resources" without saying the agent cannot run `mcp_list_resources` would be
 * exactly #266's failure: true about the server, false about what will happen.
 */
export interface McpSurfaceReport {
	state: McpSurfaceState;
	/** What the server published on the first page — before any gate. */
	count: number;
	/** The server paged; `count` is a page, not a total. */
	more: boolean;
	/** Can this agent run the LIST tool (`mcp_list_resources` / `mcp_list_prompts`)? */
	listEnabled: boolean;
	/** Can this agent run the READ tool (`mcp_read_resource` / `mcp_get_prompt`)? */
	readEnabled: boolean;
	/** One actionable sentence, in the same voice as `detail`. */
	detail: string;
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
	/**
	 * The read surfaces (#263). Absent when the connection itself failed — a server we could not
	 * reach taught us nothing about what it publishes, and a confident "no resources" for a host
	 * that was briefly down is a worse answer than saying nothing.
	 */
	resources?: McpSurfaceReport;
	prompts?: McpSurfaceReport;
	/**
	 * What the server's own OAuth metadata says, when it published any (#180/#181).
	 *
	 * `dynamicRegistration` + `pkceS256` together are the precondition for the Connect button:
	 * they are exactly what `/v1/mcp/oauth/start` requires, so the console can offer the flow only
	 * where it will actually work instead of showing a button that fails on click.
	 */
	auth?: {
		protectedResource: boolean;
		authorizationServer?: string;
		dynamicRegistration?: boolean;
		pkceS256?: boolean;
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
		// A server→client ask reaching HERE (#264) is one this client could not park for the owner
		// to answer — a `tools/list` probe (the only method this status is ever computed for) has
		// nobody to ask and nothing to resume, and a `tools/call` that CAN be parked never returns
		// this failure to a connection test at all. So it is a missing client capability seen from
		// the other side, and it lands on the existing status rather than getting a ninth: the
		// remedy is the one `missing_capability` already describes, and a console that has never
		// heard of a new status renders the connection as unknown instead of a protocol shortfall.
		case "input_required":
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
	inputSchema?: unknown;
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
 *
 * `inputSchema` is carried through (#261) because it is the whole point of speaking MCP: it is
 * what lets a granted remote tool be projected as a real function tool instead of a stringly-typed
 * passthrough. Kept only when it is an OBJECT — an array or a scalar is not a schema, and passing
 * one on would produce malformed calls that read to a user as the agent being confused.
 */
export function parseToolCatalog(raw: unknown): Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> {
	let list: unknown = raw;
	if (list && typeof list === "object" && !Array.isArray(list)) {
		const r = list as Record<string, unknown>;
		list = Array.isArray(r.tools) ? r.tools : Array.isArray(r.result) ? r.result : (r.result as Record<string, unknown> | undefined)?.tools;
	}
	if (!Array.isArray(list)) return [];
	const out: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
	for (const entry of list.slice(0, 500)) {
		if (!entry || typeof entry !== "object") continue;
		const t = entry as RawTool;
		const name = typeof t.name === "string" ? t.name.trim() : "";
		if (!name) continue;
		const description = typeof t.description === "string" && t.description.trim() ? t.description.trim().slice(0, 300) : undefined;
		const inputSchema = t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema) ? (t.inputSchema as Record<string, unknown>) : undefined;
		out.push({ name, description, inputSchema });
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

/** What the two surfaces are called in prose, and which tools gate each. */
const SURFACE_WORDS = {
	resources: { one: "resource", many: "resources", list: "mcp_list_resources", read: "mcp_read_resource", verb: "read" },
	prompts: { one: "prompt", many: "prompts", list: "mcp_list_prompts", read: "mcp_get_prompt", verb: "fetch" },
} as const;

/**
 * Turn a read-surface probe into what the OWNER needs to know (#263).
 *
 * Held to the same standard as the tool list: the sentence must never report availability that
 * permission would refuse. Three distinct outcomes, deliberately not merged —
 *
 *   unsupported → the server said `-32601`. It has none. Nothing to enable, nothing to fix.
 *   unreadable  → we could not ask. Keeps the transport's own sentence rather than inventing
 *                 "none", because a silent zero for a surface that exists is undetectable.
 *   available   → a count, AND what the agent may do with it. The probe ran on the owner's
 *                 authority, so a count says nothing about the agent's reach on its own.
 */
export function summarizeSurface(kind: "resources" | "prompts", probe: McpSurfaceProbe, gates: { listEnabled: boolean; readEnabled: boolean }): McpSurfaceReport {
	const w = SURFACE_WORDS[kind];
	const base = { state: probe.state, count: probe.count, more: probe.more, ...gates };
	if (probe.state === "unsupported") return { ...base, detail: `This server publishes no ${w.many}.` };
	if (probe.state === "unreadable") return { ...base, detail: `Could not read this server's ${w.many}: ${probe.detail}` };
	if (probe.count === 0) return { ...base, detail: `This server answers \`${kind}/list\` but currently offers none.` };

	const n = `${probe.count}${probe.more ? "+" : ""} ${probe.count === 1 && !probe.more ? w.one : w.many}`;
	// Order matters, exactly as it does for a blocked tool: name the gate that must be fixed
	// FIRST, so nobody is told to enable the second tool while the first still hides the list.
	if (!gates.listEnabled) return { ...base, detail: `${n} published, but this agent can't run \`${w.list}\`, so it can't see them. Enable it under Tools.` };
	if (!gates.readEnabled) return { ...base, detail: `${n} — this agent can list them but can't run \`${w.read}\`, so it can ${w.verb} none. Enable it under Tools.` };
	// No consent line here on purpose: these are read-scoped, so there is no grant to tick and
	// no write switch to flip. Saying so is the point — the alternative is an owner hunting for
	// an approval that does not exist.
	return { ...base, detail: `${n} — this agent can list and ${w.verb} them. Reads need no per-item approval.` };
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
