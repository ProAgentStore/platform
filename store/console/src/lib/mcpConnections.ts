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
	| "credential_expired"
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
	auth?: { protectedResource: boolean; authorizationServer?: string; dynamicRegistration?: boolean; pkceS256?: boolean; unattended?: string };
}

/** A first-party MCP server this deployment knows about (#287). Mirrors lib/mcp-presets.ts. */
export interface McpPreset {
	id: string;
	label: string;
	url: string;
	scope: string | null;
	smokeTool: string | null;
	description: string;
}

export interface McpConnection {
	endpoint: string;
	grants: McpGrant[];
	/** True when a `*` grant is present — the UI says "all tools" instead of listing one row. */
	wildcard: boolean;
}

/**
 * A stored credential's METADATA (#286). There is no `token` field and no reveal route: an MCP
 * server token has no client-side use, so reading it back would be pure attack surface.
 *
 * Mirrors McpCredentialInfo in workers/api/src/lib/mcp-credentials.ts.
 */
export interface McpCredential {
	endpoint: string;
	authMode: "bearer" | "oauth";
	issuer: string | null;
	scopes: string | null;
	expiresAt: string | null;
	expired: boolean;
	accountLabel: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface McpCredentialState {
	credentials: McpCredential[];
	/** The old account-wide token, if the user still has one. Bound to no server, so never sent. */
	legacy: { present: boolean };
}

/**
 * The one-line credential state for a server row.
 *
 * A credential is per (account, endpoint), so this is a lookup and not a join over grants — and
 * the endpoint compared is the normalized one the server returned, never the string the user
 * typed, or a connection would show "token stored" for a URL the connector resolves differently.
 */
export function credentialNote(credentials: readonly McpCredential[], endpoint: string): { label: string; tone: "muted" | "amber" } {
	const cred = credentials.find((c) => c.endpoint === endpoint);
	if (!cred) return { label: "No token", tone: "amber" };
	if (cred.expired) return { label: "Token expired", tone: "amber" };
	return { label: cred.authMode === "oauth" ? "Authorized" : "Token stored", tone: "muted" };
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
		case "credential_expired":
			return { label: "Token expired", tone: "amber" };
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

/**
 * Can this server be authorized in-browser (#180/#258)?
 *
 * The same two conditions `/v1/mcp/oauth/start` enforces, restated here so the button only appears
 * where the flow will actually work. A "Connect" that always fails is worse than no button: it
 * reads as a broken feature rather than a server that wants something else, and it teaches the
 * user to distrust the panel. `pkceS256` must be explicitly true — a server that omits it is one
 * we refuse to authorize as a public client, not one to try optimistically.
 */
export function canAuthorize(report: Pick<McpReport, "auth"> | null | undefined): boolean {
	const a = report?.auth;
	return !!a?.protectedResource && a.dynamicRegistration === true && a.pkceS256 === true;
}

/** The preset that names this endpoint, if any — endpoints are already normalized on both sides. */
export function presetFor(presets: readonly McpPreset[], endpoint: string): McpPreset | undefined {
	return presets.find((p) => p.url === endpoint);
}

/**
 * Read a smoke-test result into a count and a few names.
 *
 * DELIBERATELY SHALLOW. The point of the dogfood test (#287) is "did a real remote tool call go
 * all the way through and come back with something recognisable" — not to render the payload. So
 * it counts and samples NAMES only: an MCP result is remote, attacker-shaped data heading for the
 * DOM, and a panel that displayed whatever fields came back would be a place to put them.
 */
export function summarizeSmoke(raw: unknown): { ok: boolean; count: number | null; sample: string[]; detail: string } {
	let payload: unknown = raw;
	if (typeof raw === "string") {
		try {
			payload = JSON.parse(raw);
		} catch {
			// Not JSON — a plain-text tool result, or a refusal message. Show it as-is, truncated.
			return { ok: true, count: null, sample: [], detail: raw.slice(0, 200) };
		}
	}
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		const r = payload as Record<string, unknown>;
		// The connector's envelope: {tool, ok, data}. `ok:false` is the server reporting that the
		// TOOL failed while the call itself succeeded — surfacing that as success would be the
		// "green badge, nothing works" lie this whole surface exists to avoid.
		if ("ok" in r && "data" in r) {
			const inner = summarizeSmoke(r.data);
			return { ...inner, ok: r.ok === true && inner.ok };
		}
		for (const key of ["agents", "items", "results", "tools"]) {
			if (Array.isArray(r[key])) payload = r[key];
		}
	}
	if (!Array.isArray(payload)) {
		return { ok: true, count: null, sample: [], detail: typeof payload === "object" ? "returned an object" : String(payload).slice(0, 200) };
	}
	const sample = payload
		.slice(0, 3)
		.map((e) => {
			if (e && typeof e === "object") {
				const o = e as Record<string, unknown>;
				const name = o.name ?? o.slug ?? o.title ?? o.id;
				return typeof name === "string" ? name.slice(0, 60) : "";
			}
			return typeof e === "string" ? e.slice(0, 60) : "";
		})
		.filter(Boolean);
	return { ok: true, count: payload.length, sample, detail: "" };
}
