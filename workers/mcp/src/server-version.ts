/**
 * What version of this MCP server a client is talking to — ONE place, checked against the
 * places that cannot import it.
 *
 * ── Why this file exists (#573)
 *
 * `initialize` is the only moment a client learns what build it reached, and this server
 * answered it with two hand-typed literals that had never agreed:
 *
 *   - `index.ts:43`  — `new McpServer({ name: "ProAgentStore", version: "0.1.0" })`, i.e.
 *     what a connecting client reads out of `serverInfo.version`.
 *   - `server.json:6` — `"version": "0.1.1"`, the public MCP-registry manifest that
 *     `.github/workflows/publish-mcp-registry.yml` publishes.
 *
 * Neither moved for any of #561's four commits, which between them annotated all 135 tools,
 * added a server `instructions` string, and changed `my_instances` from a bare array to
 * `{"instances":[…]}`.
 *
 * `index.ts` now IMPORTS this constant, so that half cannot diverge at all. `server.json` is
 * JSON consumed by an external publisher and can import nothing, so its agreement is
 * enforced by `scripts/docs-drift.mjs`'s wire-surface check — which also fails if anyone
 * types a literal back into the `McpServer` constructor. Same shape as `tool-count.ts`, and
 * for the same reason: a number two files restate by hand is a number that rots.
 *
 * **The value is deliberately NOT bumped here.** `0.1.1` is the manifest's, and BOTH numbers
 * are live in the public registry. Measured 2026-08-15 —
 * `GET https://registry.modelcontextprotocol.io/v0/servers?search=ProAgentStore` returns two
 * entries for `io.github.ProAgentStore/platform`: `0.1.0`, published 2026-06-20T12:34:01Z with
 * `isLatest: false`, and `0.1.1`, published nine hours later with `isLatest: true`. So
 * `index.ts` was not merely disagreeing with `server.json`; it was advertising the entry the
 * registry has itself SUPERSEDED, and a client that discovered this server as `0.1.1` and
 * connected was told by `serverInfo` that it had reached `0.1.0`. Taking the registry's latest
 * is the only reconciliation that does not downgrade a public artefact. Reconciling the two is
 * not the same act as picking a new number.
 *
 * ── WHEN TO BUMP IT
 *
 * When the SERVED SURFACE changes — what `initialize` and `tools/list` publish — not when a
 * handler's internals change. Concretely, every field of a published tool definition except
 * `description`, plus the server `instructions`:
 *
 *   · the set of tool NAMES registered, or which of them are surface-gated
 *     (`tool-count.ts`, and any new `server.tool(` call site)
 *   · a tool's `inputSchema` — the argument names and types a cached client would send
 *   · a tool's `annotations` — `TOOL_RISK` / `ToolAnnotations` in `tool-metadata.ts`
 *   · which tools declare an `outputSchema`, and the payload key it wraps (`TOOL_OUTPUT`)
 *   · `SERVER_INSTRUCTIONS`
 *
 * Explicitly NOT a surface change, and this list is as load-bearing as the one above:
 *
 *   · a tool's DESCRIPTION. A description is prose a model reads, not a contract a client
 *     builds against; making every wording fix a version bump would train people to skip
 *     the bump, which costs more than it buys.
 *   · a handler's internals, a bug fix inside an already-declared shape, or anything in
 *     `safety.ts` that changes WHEN a call is refused rather than WHAT is published.
 *   · `title`, which `titleFor()` derives from the tool name and therefore moves only when
 *     a name does — already covered by the first bullet.
 *
 * The reason for that boundary is what a caching host keys on. Hosts cache the tool list;
 * the ProAgentStore connector in ChatGPT served the pre-`b2b0ac4` unannotated list until it
 * was refreshed by hand, and "hit Refresh" is not an invalidation mechanism. A monotonic
 * `serverInfo.version` is the standard signal a host has for noticing — though note this is
 * the standard mechanism rather than a measured cause: that a bump would specifically have
 * made OpenAI's client re-fetch was NOT tested against it.
 *
 * Nothing enforces the bump today; `docs-drift.mjs` enforces only that the three statements
 * of the version agree. A fingerprint over the published surface, ratcheted against this
 * constant, is the check that would — `conformance.test.ts` already holds the wire objects
 * a fingerprint would be taken from — and it is its own piece of work, not a rider here.
 */

/** Advertised in `serverInfo.version`, and restated in `server.json` and `platform-docs/mcp.md`. */
export const MCP_SERVER_VERSION = "0.1.2";
