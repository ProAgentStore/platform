# MCP OAuth reconnect: which layer owns a failure (#1327)

A connector in ChatGPT (or any MCP host) can show "Connected" while tool calls still fail. The connection passes through
four layers; each owns different failures, and only one of them is ours to see.

| Layer | Owns | How to tell |
|---|---|---|
| 1. Consent and sign-in (`mcp.proagentstore.online/authorize`, `/authorize/continue`) | the 10-minute authorization request and the browser-binding cookie | `/oauth/callback` answers 400 "invalid or expired nonce" or "not bound to this browser" |
| 2. PAGS code exchange (`POST /v1/auth/mcp/exchange`, `/v1/auth/me`) | the one-time sign-in code and the 30-day PAGS session | `/oauth/callback` answers 400 "invalid or expired code" or "invalid session" |
| 3. Token endpoint (`/token`, `@cloudflare/workers-oauth-provider`) | the authorization code → access/refresh token, the stored grant props | the host reports Connected only after this succeeds; a failure shows as a 4xx on `/token` |
| 4. The host (ChatGPT's callback, token storage, tool session) | whether the host keeps and sends the token | the worker sees **no** `/mcp` request at all, or sees one with no/stale bearer |

Layers 1 and 2 answer the owner with what failed, what to do, and a **Reference** (ten hex characters, a hash of the flow's
nonce; the nonce, code and session are never shown or logged).

## Retrieving the sanitized trace

Every stage logs one JSON line `{"event":"mcp.oauth_flow","stage":…,"ref":…,"outcome":"ok"|"failed",…}` from the
`proagentstore-mcp` worker. Stages: `callback`, `exchange`, `session`, `authorized`. Search the worker log for the owner's
reference (`wrangler tail proagentstore-mcp --format json`, or the Workers Logs view).

- `authorized` with that reference and then still "authentication required" in the host: layers 1–2 succeeded; look at
  layer 3 (`/token` traffic for the same minute) and layer 4.
- No `mcp.oauth_flow` line and no `/mcp` request during a stalled "Connect" button: the host never called us. That is
  layer 4, and nothing the worker can repair.

## What is not proven

The text "MCP authentication required. Reconnect to continue using this server." is not produced by this repository; it is
the host's message. This change makes layers 1–2 diagnosable. It does not establish why a particular ChatGPT reconnect
left the host without a usable token; that needs a worker trace for a failing reconnect.
