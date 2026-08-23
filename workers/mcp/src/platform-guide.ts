import { MCP_TOOL_ALWAYS_ON, MCP_TOOL_COUNT, MCP_TOOL_GATED } from "./tool-count.js";

/**
 * What the always-on `platform_guide` tool returns — the capability document a MODEL reads (#703).
 *
 * ── Why it is a module, and why it interpolates
 *
 * It was a hand-maintained inventory inside `index.ts` that listed 26 of the then 141 registered
 * tools and named no coding tool and no observability tool at all. So a model asking this tool
 * "can I see inside a running loop?" got a document in which the answer was no — three days after
 * `coding_timeline` shipped, and while the owner's client was serving a `tools/list` cached from
 * before that deploy.
 *
 * The list is the part that rots, and it is also the part `workers/mcp/README.md`'s table already
 * maintains correctly under a guard that fails on an omitted tool AND on a phantom one. So the
 * list is gone: what remains is the SHAPE of the surface, interpolated from `tool-count.ts` so it
 * cannot drift, plus the instruction to enumerate the real set with `tools/list`.
 *
 * ── The sentence this document exists for
 *
 * "If `tools/list` gave you fewer than N tools, it is cached and stale." MCP gives a server no way
 * to invalidate a cache across sessions — `tools/list_changed` is a notification to a CONNECTED
 * client, and the client that needs this warning is by definition one that was disconnected when
 * the surface grew. `SERVER_INSTRUCTIONS` cannot carry it either: instructions are delivered at
 * `initialize`, the same moment a fresh list would be, so a client stale enough to need the
 * warning is stale enough not to have re-read it. It has to ride on a tool that was ALREADY in the
 * cache, and `platform_guide` has been on the surface since long before any current cache was
 * taken. That makes this the only sentence in the system that can reach a model THROUGH a stale
 * list and tell it the list is stale.
 *
 * ── What may and may not be written here
 *
 * `scripts/lib/platform-guide.mjs` holds this string to the registered surface: every snake_case
 * token must be a REGISTERED tool name (so `coding_loop_*` is a failure, not a wildcard — a model
 * cannot call a wildcard), every count claim must equal the constants, and the numbers must be
 * interpolated rather than typed. It deliberately does NOT require that every tool be named: a
 * guide that lists all {@link MCP_TOOL_COUNT} of them is the README with the table removed.
 *
 * It lives in its own file rather than in `index.ts` because it now IMPORTS the constants and is
 * checked against them — a dependency and a contract, which is more than a string literal beside a
 * registration deserves to be. `SDK_REFERENCE` stays in `index.ts`: it describes the npm package,
 * not this surface, so it has neither the import nor the guard.
 */
export const PLATFORM_GUIDE = `# ProAgentStore Platform Guide

Marketplace for server-powered AI agents. Creators build agent templates, clients subscribe and run them on their own data.

## Agent Types: Agents | Workers | Tools
## CLI: pags init <name> --template worker|cron|api, pags check, pags publish
## Tools: ${MCP_TOOL_COUNT} tools registered — ${MCP_TOOL_ALWAYS_ON} are always on, ${MCP_TOOL_GATED} are gated to the console surfaces of the agents you are subscribed to (apply, repo, coding). Call tools/list for the current set; the groups below name entry points, not the whole surface. If tools/list gave you fewer than ${MCP_TOOL_COUNT} tools, your list is CACHED AND STALE — refresh it before concluding a capability is missing.
## Creator: scaffold an agent from a template, read and write the files in its repo, configure its board, publish it and watch the deploy.
## Subscriber runtime: subscribe_agent then my_instances for what you own; chat_with_instance to talk to one; add documents, settings, triggers and connector tools per instance; register a local machine and queue work on it.
## Instance tools — an agent's OWN tools are one level down from this surface, and are usually the DIRECT path: list_instance_tools names what one instance may actually run (its GitHub, HTTP and search connectors as well as its own memory, files and knowledge) with a per-tool verdict, and call_instance_tool invokes one. Check there BEFORE reaching for coding_session_message: making a terminal shell out for something an instance tool already does returns a truncated pane instead of structured data, and is the fallback rather than the first path.
## Coding — watching and driving a run on your own machine: coding_timeline is what a run is DOING and what a finished one did (objective, every instruction, tool calls, outcome). coding_session_capture reads the live pane; a session that has ENDED answers it empty, and coding_terminal returns that run's stored pane text in full instead. coding_loop_start gives an agent an objective and returns immediately — supervise it with coding_loop_status and end it with coding_loop_stop.
## Observability — what an agent actually did, and what it cost: agent_trace first (chat turns, run steps and failures interleaved on one timeline, filterable by trace or source), then instance_activity for an instance's own record, list_errors for the durable error log, instance_board for the work it is tracking, and usage_summary for tokens and spend.
## Public trial: chat_with_agent calls /v1/public/agents/:id/try and is for previews, not the main user runtime
## URLs: Store proagentstore.online, API api.proagentstore.online, MCP mcp.proagentstore.online/mcp
## Key endpoints: GET /v1/agents, POST /v1/public/agents/:id/try, POST /v1/instances/:id/subscribe, POST /v1/instances/:instanceId/chat`;
