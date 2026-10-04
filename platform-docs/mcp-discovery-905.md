# MCP discovery investigation — #905

Observed 2026-10-03. This records evidence, not a reconstruction of the external host's cache internals.

The host inventory was measured with `ALL_TOOLS.filter(t => t.name.startsWith("mcp__codex_apps__proagentstore_2_")).length`. Public deployment probes used `curl -fsS https://mcp.proagentstore.online/health` and `curl -fsS https://proagentstore.online/.well-known/mcp-server.json`; the deployment result came from `gh run view 37044802501 --repo ProAgentStore/platform`. Account capabilities were read through the configured MCP connector's `my_instances`, without private API access.

## Evidence

- The configured ProAgentStore 2 connector advertised an inventory of 135 entries in the agent's tool registry. Neither `mcp_server_info` nor `coding_engine_reauth` was present.
- Calling that connector's existing `platform_guide` returned live text describing 246 tools registered: 219 are always on and 27 are gated.
- `my_instances` on the same connector confirmed instances with `coding`, `apply` and `repo` console surfaces. The coding subscription gate therefore does not explain the missing reauthentication tool on the platform endpoint.
- Public production health reported 246 tools. The production server manifest advertised version `0.1.72`; the MCP deployment for commit `4f7f7fe0` succeeded.
- Current source registers `mcp_server_info` on platform, instance-pinned and type-pinned endpoints. `coding_engine_reauth` is registered with the coding group on the platform endpoint; its runtime permission is checked on invocation.
- There is no repository-managed ChatGPT ingress tool whitelist or OpenAPI schema. `store/openapi.yaml` documents the REST API, `store/manifest.json` is a PWA manifest, and platform connector manifests describe outbound agent integrations.

The host-advertised inventory differs from the deployed catalog and from live responses over the same connection. Deployment omission and the account's coding subscription gate do not account for these observations. The exact host import, filtering or cache mechanism remains unverified: public health and a live guide are evidence of the deployment, not an authenticated production `tools/list` capture for this connection.

## Repository remedy

The existing guide now reports the server version and deterministic schema revision through a tool already available in the older inventory. It explains the expected diagnostic and coding reauthentication visibility and replaces the incorrect blanket assertion that every list below the full catalog count is stale. Subscription gating and pinned endpoints legitimately publish smaller catalogs.

Fresh discovery regression tests protect server-side publication. These tests cannot certify what an external host imports or make a host refresh its catalog.

Public `/health` now returns the same server, schema and build identity as `mcp_server_info`, without an account lookup. The deployment workflow records the Git commit and UTC timestamp in Worker bindings, and its smoke test rejects a healthy response from the wrong build, version or schema. These checks establish deployment identity; they do not replace authenticated discovery or a host-catalog comparison.

## Verify the host boundary

1. Record the exact connection endpoint and account; confirm platform versus pinned surface and the account's console capabilities.
2. Obtain fresh `initialize` and `tools/list` through the configured MCP connection; compare server identity and the expected tool names with the host's advertised inventory.
3. For a ChatGPT developer-mode connection, explicitly refresh tool metadata, inspect the advertised tools, then test in a new conversation. Reconnect and a fresh chat alone do not prove that metadata refresh occurred.
4. If the inventories still disagree, preserve both inventories, version/schema revision and timestamp for host support. Do not claim that a server-side deployment can force refresh the external catalog.

OpenAI documents the explicit developer-mode refresh procedure and distinguishes the published-plugin review path in [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).
