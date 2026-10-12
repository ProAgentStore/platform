/**
 * Which MCP request a tool call is answering (#1038).
 *
 * A Streamable HTTP reply can be lost after the tool has run: the DO sends the result down the
 * per-request bridge, and if that bridge has closed (`agents/mcp`'s `send` finds no connection for
 * the request id) the result goes nowhere. The caller then has a write that may or may not have
 * landed, and the only record is the audit ledger — which carried a random event id and nothing the
 * caller knew. Every audit row now carries the JSON-RPC `requestId` and the `mcp-session-id` of the
 * call that wrote it, so `mcp_audit_log` can answer "did request 7 of session X run?".
 *
 * One `PagsMcp` DO serves one session but can run several calls at once, so the ids are carried in
 * AsyncLocalStorage around each handler (`registration.ts`) rather than on the DO. Kept out of
 * `safety.ts` and `audit-ledger.ts`, which other stores vendor and which import nothing: `safety()`
 * in `index.ts` hands the reader to the audit as `SafetyContext.correlation`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface CallCorrelation {
	/** The JSON-RPC id of the `tools/call` — unique only within its session. */
	requestId?: string;
	mcpSessionId?: string;
}

const store = new AsyncLocalStorage<CallCorrelation>();

export function withCallCorrelation<T>(correlation: CallCorrelation, fn: () => T): T {
	return store.run(correlation, fn);
}

export function currentCallCorrelation(): CallCorrelation | undefined {
	return store.getStore();
}

/** The ids the MCP SDK hands every tool handler as its second argument (`RequestHandlerExtra`). */
export function correlationFromExtra(extra: unknown): CallCorrelation {
	const e = (extra ?? {}) as { requestId?: unknown; sessionId?: unknown };
	const out: CallCorrelation = {};
	if (typeof e.requestId === "string" || typeof e.requestId === "number") out.requestId = String(e.requestId);
	if (typeof e.sessionId === "string" && e.sessionId) out.mcpSessionId = e.sessionId;
	return out;
}
