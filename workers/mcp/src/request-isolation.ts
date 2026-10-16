/**
 * One MCP session, one in-flight use of each JSON-RPC request id (#1111).
 *
 * ── The defect, as measured
 *
 * `agents/mcp`'s Streamable HTTP transport (0.3.10, `dist/mcp/index.js`) turns every HTTP POST into a
 * connection on the session's Durable Object and records the request ids it carries on that
 * connection (`connection.setState({ requestIds })`). A reply is then routed to
 *
 *     Array.from(agent.getConnections()).find((conn) => conn.state?.requestIds?.includes(requestId))
 *
 * — the FIRST open connection that lists the id. That is correct only while ids are unique within a
 * session, which the MCP spec requires of the client ("MUST NOT have been previously used by the
 * requestor within the same session"). On 2026-10-16 a client did not: the audit ledger shows one
 * session (`364ba152…`) carrying ~60 different tool calls, all with request id `0`, several in
 * flight at once (three `github_list_issues` inside one second). Each reply went to whichever of
 * those connections the `find` reached first, so concurrent calls received each other's results —
 * the crossed responses of #1111 and #1110. The client is at fault for reusing the id; the server was
 * at fault for delivering on it.
 *
 * ── What this does
 *
 * Before a POST is handed to the transport, its request ids are compared with the ids every OTHER
 * open connection of this session still holds. A request whose id is in flight elsewhere is refused
 * with a JSON-RPC error on its own connection and never dispatched, so no two open connections can
 * hold the same id and the transport's `find` has exactly one candidate: a reply can only reach the
 * request it answers. Refusing is the fail-closed choice: the caller learns its call did not run,
 * instead of reading someone else's data as its answer.
 *
 * The ids are read from the transport's own per-connection state, not from a set kept here — one
 * record of "what is in flight", which leaves with the connection when it closes. An id reused AFTER
 * its request completed is not refused (its connection is gone, so nothing can cross); only
 * concurrent reuse can deliver a reply to the wrong caller.
 *
 * Sessions are already separate: each is its own Durable Object (`streamable-http:<session id>`), so
 * there is no shared in-flight state across sessions to isolate.
 */

/** The headers `McpAgent.serve` uses to hand a POST to the DO (agents 0.3.10). Pinned by a test against the installed package. */
export const MCP_METHOD_HEADER = "cf-mcp-method";
export const MCP_MESSAGE_HEADER = "cf-mcp-message";
/** The WS message the transport sends the Worker for each SSE event it should write (`MessageType.CF_MCP_AGENT_EVENT`). */
export const MCP_AGENT_EVENT = "cf_mcp_agent_event";

/** JSON-RPC "Invalid Request". */
export const REUSED_ID_ERROR_CODE = -32600;

export type RequestId = string | number;

/** The two things this needs from a partyserver connection. */
export interface IsolationConnection {
	id: string;
	state?: unknown;
	send(message: string): void;
}

/** The JSON-RPC request ids a POST body carries (a single message or a batch). Notifications and responses carry none. */
export function requestIdsIn(body: unknown): RequestId[] {
	const messages = Array.isArray(body) ? body : [body];
	const ids: RequestId[] = [];
	for (const m of messages) {
		const msg = m as { method?: unknown; id?: unknown } | null;
		if (msg && typeof msg.method === "string" && (typeof msg.id === "string" || typeof msg.id === "number")) ids.push(msg.id);
	}
	return ids;
}

/** The POST body the DO was handed, or null when this is not a Streamable HTTP POST (a GET stream, the legacy SSE transport). */
export function postedBody(request: Request): unknown {
	if (request.headers.get(MCP_METHOD_HEADER) !== "POST") return null;
	const raw = request.headers.get(MCP_MESSAGE_HEADER);
	if (!raw) return null;
	try {
		// base64 of UTF-8 JSON, as the transport decodes it (`Buffer.from(raw, "base64").toString("utf-8")`).
		return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
	} catch {
		return null; // the transport reports an undecodable body itself; this guard only refuses what it can read
	}
}

/** Same id as JSON-RPC means it: `0` and `"0"` are different ids, so compare type as well as value. */
const sameId = (a: RequestId, b: RequestId) => typeof a === typeof b && a === b;

/** The ids in `incoming` that another open connection of this session is still answering. */
export function idsInFlightElsewhere(incoming: readonly RequestId[], connections: Iterable<IsolationConnection>, self: IsolationConnection): RequestId[] {
	if (!incoming.length) return [];
	const held: RequestId[] = [];
	for (const conn of connections) {
		if (conn === self || conn.id === self.id) continue;
		const ids = (conn.state as { requestIds?: unknown } | undefined)?.requestIds;
		if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" || typeof id === "number") held.push(id);
	}
	return incoming.filter((id) => held.some((h) => sameId(h, id)));
}

/**
 * Ids this POST carries more than once. A batch that repeats an id gets two replies with that one id,
 * and the caller cannot tell which reply answers which request — the same crossing, inside one POST.
 */
export function idsRepeatedWithin(incoming: readonly RequestId[]): RequestId[] {
	return incoming.filter((id, i) => incoming.some((other, j) => j < i && sameId(other, id)));
}

/** The JSON-RPC error a refused request gets. Names the rule, so the client can be fixed from the message alone. */
export function reusedIdError(id: RequestId, clashed = true): { jsonrpc: "2.0"; id: RequestId; error: { code: number; message: string } } {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: REUSED_ID_ERROR_CODE,
			message: !clashed
				? `Request id ${JSON.stringify(id)} was not run: another request in the same batch reuses a request id that is still in flight in this MCP session, so the batch was refused whole. Send each request with a new id.`
				: `Request id ${JSON.stringify(id)} is already in use by another request in flight in this MCP session, so this request was not run. Concurrent reuse of a request id is not permitted (MCP: a request id MUST NOT have been previously used within the same session) — it is how one call receives another's response. Send each request with a new id.`,
		},
	};
}

/**
 * Refuse a POST whose request ids are in flight elsewhere in the session, or repeat within the POST
 * itself (a batch reusing one id), before it is dispatched.
 * Answers every request in the POST (a batch is refused whole: its replies share one stream), then
 * closes it. Returns the refused ids; empty means "dispatch as normal".
 */
export function refuseReusedRequestIds(request: Request, connections: Iterable<IsolationConnection>, self: IsolationConnection): RequestId[] {
	const incoming = requestIdsIn(postedBody(request));
	const clashing = [...idsInFlightElsewhere(incoming, connections, self), ...idsRepeatedWithin(incoming)];
	if (!clashing.length) return [];
	incoming.forEach((id, i) => {
		const error = reusedIdError(id, clashing.some((c) => sameId(c, id)));
		self.send(JSON.stringify({ type: MCP_AGENT_EVENT, event: `event: message\ndata: ${JSON.stringify(error)}\n\n`, close: i === incoming.length - 1 }));
	});
	return clashing;
}
