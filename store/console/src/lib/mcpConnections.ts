// MCP connection setup — the pure half (#266).
//
// A "connection" here is NOT a stored record. It is the set of grants an instance holds on one
// normalized endpoint, plus whatever the last test learned about that endpoint. That is a
// deliberate constraint, not a shortcut:
//
//   • The endpoint URL already IS the identity — consent rows key on it, the trace keys on it,
//     and the connector normalizes to it before every call. A second stored record with its own
//     id and nickname would be a second name for the same thing, and the two would drift the
//     first time someone edited one. So there is no migration here and no `rename`: the panel
//     names a server by the URL that enforcement uses.
//   • Multiple endpoints per instance therefore fall out for free — a connection appears the
//     moment you grant anything on a new URL and disappears when you revoke the last grant.
//
// Everything in this file is pure so the status vocabulary the panel renders is testable
// without a browser and cannot quietly disagree with the server's.

/** Mirrors McpConnectionStatus in workers/api/src/lib/mcp-connection.ts. */
export type McpStatus =
	| "connected"
	| "credential_missing"
	| "auth_required"
	| "unsupported_protocol"
	| "unreachable"
	| "blocked"
	| "permission_denied"
	| "invalid_url";

export type McpBlocker = "no_grant" | "wildcard_excludes_destructive" | "no_write_consent" | "tool_disabled";

export interface McpGrant {
	endpoint: string;
	tool: string;
	destructive?: boolean;
}

export interface McpReportTool {
	name: string;
	description?: string;
	destructive: boolean;
	granted: boolean;
	callable: boolean;
	blockedBy?: McpBlocker;
}

export interface McpReport {
	endpoint: string;
	status: McpStatus;
	detail: string;
	failure?: string;
	era?: string;
	protocolVersion?: string;
	httpStatus?: number;
	durationMs?: number;
	tools: McpReportTool[];
	toolCount: number;
	callableCount: number;
	gates: { callToolEnabled: boolean; writeConsent: boolean };
	auth?: { protectedResource: boolean; authorizationServer?: string; dynamicRegistration?: boolean; unattended?: string };
}

export interface McpConnection {
	endpoint: string;
	grants: McpGrant[];
	/** True when a `*` grant is present — the UI says "all tools" instead of listing one row. */
	wildcard: boolean;
}

/** Group an instance's grants into one entry per server, endpoints in stable alphabetical order. */
export function connectionsFromGrants(grants: readonly McpGrant[]): McpConnection[] {
	const byEndpoint = new Map<string, McpGrant[]>();
	for (const g of grants) {
		const list = byEndpoint.get(g.endpoint);
		if (list) list.push(g);
		else byEndpoint.set(g.endpoint, [g]);
	}
	return [...byEndpoint.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([endpoint, list]) => ({ endpoint, grants: list, wildcard: list.some((g) => g.tool === "*") }));
}

/**
 * Client-side mirror of `normalizeMcpEndpoint`. Used only to decide which stored connection a
 * fresh test result belongs to — never as a substitute for the server's answer, which is what
 * every displayed endpoint comes from. Returns null for anything that isn't an https URL, so
 * the Test button can refuse locally instead of spending a request to be told the same thing.
 */
export function normalizeEndpoint(raw: string): string | null {
	let u: URL;
	try {
		u = new URL(String(raw ?? "").trim());
	} catch {
		return null;
	}
	if (u.protocol !== "https:") return null;
	return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * The badge. `tone` maps to the console's existing colour words rather than a hex, so the panel
 * inherits the theme.
 *
 * `credential_missing` and `auth_required` are amber, not red: the server is there and the
 * remedy is one field away. Colouring them like an outage sends people to check a host that is
 * fine — which is the same mistake as collapsing them into one status in the first place.
 */
export function statusBadge(status: McpStatus): { label: string; tone: "green" | "amber" | "red" } {
	switch (status) {
		case "connected":
			return { label: "Connected", tone: "green" };
		case "credential_missing":
			return { label: "Token needed", tone: "amber" };
		case "auth_required":
			return { label: "Credential rejected", tone: "amber" };
		case "permission_denied":
			return { label: "Not permitted", tone: "amber" };
		case "unsupported_protocol":
			return { label: "Protocol mismatch", tone: "red" };
		case "blocked":
			return { label: "Blocked", tone: "red" };
		case "invalid_url":
			return { label: "Invalid URL", tone: "red" };
		case "unreachable":
			return { label: "Unreachable", tone: "red" };
	}
}

/**
 * The one-line remedy for a tool that isn't callable. Mirrors the server's `explainBlocker` in
 * intent, but is phrased for the panel the user is already looking at ("below", "above").
 */
export function blockerHint(blocker: McpBlocker): string {
	switch (blocker) {
		case "tool_disabled":
			return "mcp_call_tool is switched off for this agent — turn it back on under Tools.";
		case "no_write_consent":
			return "MCP write access is off — enable it under Agent write access above.";
		case "wildcard_excludes_destructive":
			return "Looks destructive, so “all tools” doesn’t cover it. Allow it by name.";
		case "no_grant":
			return "Not allowed yet — tick it to grant this agent access.";
	}
}

/**
 * Should the MCP Connections panel appear at all? True when the agent has ANY outbound-MCP tool,
 * read or write.
 *
 * Gating on write access alone (the previous behaviour) hid the panel from an agent that can
 * only discover servers, and — worse — hid it until the user had already granted the connector,
 * so the first thing they saw was a kill switch for a capability they could not yet see.
 */
export function hasMcpCapability(tools: ReadonlyArray<{ connector?: string; allowed: boolean; disabled: boolean }>): boolean {
	return tools.some((t) => t.connector === "mcp" && (t.allowed || t.disabled));
}
