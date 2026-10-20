/**
 * How large the MCP tool surface is — one place, checked against reality.
 *
 * `GET /health` answered `tools: 41` for months while the server actually
 * registered 124. That number is the only machine-readable size signal the server
 * publishes, and three docs quote the same figure in prose, so a hand-maintained
 * literal in the handler was guaranteed to rot: nothing failed when a tool was
 * added, and nothing connected the handler's number to the docs' number.
 *
 * These constants are the source both sides read, and they are asserted twice:
 *
 *  - `index.test.ts` runs the REAL registration path and compares
 *    `tools.size` — with every surface gated on, and with none — against
 *    {@link MCP_TOOL_COUNT} and {@link MCP_TOOL_ALWAYS_ON}. Add a tool, that test
 *    fails until the number here moves.
 *  - `scripts/docs-drift.mjs` compares every "N tools" claim in
 *    `platform-docs/mcp.md`, `store/llms-full.txt` and `workers/mcp/README.md`
 *    against {@link MCP_TOOL_COUNT}, and the per-surface gated table against
 *    {@link MCP_TOOL_GATED}.
 */

/** Every tool the server can register, with all surfaces gated on. */
export const MCP_TOOL_COUNT = 367;

/** Registered for every connection, whatever the user is subscribed to. */
export const MCP_TOOL_ALWAYS_ON = 340;

/** Registered only when the user has an agent with the matching console surface
 *  (`apply`, `repo`, `coding`) — so a Repo Chat user never sees `apply_to_job`. */
export const MCP_TOOL_GATED = MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON;

/**
 * How large the surface is ALLOWED to be (#1241): {@link MCP_TOOL_COUNT} may not exceed the last
 * entry's `count`. Append-only — growing the surface means appending an entry that says why, so each
 * new tool is a recorded decision, not a drift the count test merely follows. Merging or retiring
 * tools needs no entry: the ceiling stays and the count drops under it.
 *
 * Before appending, check the tool you are adding has no sibling that already calls the same API
 * route — the #1241 audit found four such pairs (`docs/mcp-tool-audit.md` §4).
 */
export const TOOL_COUNT_CEILINGS: ReadonlyArray<{ count: number; issue: string; date: string; reason: string }> = [
	{ count: 366, issue: "#1241", date: "2026-10-20", reason: "Baseline recorded by the MCP tool surface audit." },
	{ count: 367, issue: "#1247", date: "2026-10-20", reason: "gmail_scout_scan_log: one scan's per-email decisions, paged — too large for gmail_scout_status's receipts, which link to it." },
];
