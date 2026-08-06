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
export const MCP_TOOL_COUNT = 124;

/** Registered for every connection, whatever the user is subscribed to. */
export const MCP_TOOL_ALWAYS_ON = 106;

/** Registered only when the user has an agent with the matching console surface
 *  (`apply`, `repo`, `coding`) — so a Repo Chat user never sees `apply_to_job`. */
export const MCP_TOOL_GATED = MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON;
