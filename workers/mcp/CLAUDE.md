# CLAUDE.md — `workers/mcp`

Guidance for a Claude session working **in this directory**. For calling the deployed
server, read [`AGENTS.md`](./AGENTS.md). For the tool table, read [`README.md`](./README.md).

## What this worker is

`proagentstore-mcp` — the ProAgentStore MCP server. A Cloudflare Worker whose entry
point is a `@cloudflare/workers-oauth-provider` instance wrapping a Durable Object
(`PagsMcp`, an `McpAgent`) that registers the tools and proxies them to
`api.proagentstore.online`.

It is a **separate deployable** from `workers/api`. It cannot import from the API
worker; anything shared is deliberately copied (see the `columnFor` comment in
`src/instance-tools/shared.ts`). If you change one copy, change the others.

The worker holds almost no logic of its own. Nearly every tool is
`requirePermission → optional dry_run → authedCall(<API route>) → jsonText`. If a tool
behaves wrongly, the bug is usually in `workers/api`, not here.

## Connection

| | |
|---|---|
| Endpoint | `https://mcp.proagentstore.online/mcp` (Streamable HTTP) |
| Health | `https://mcp.proagentstore.online/health` |
| Route | `mcp.proagentstore.online/*`, zone `proagentstore.online` (`wrangler.toml`) |
| Registry | `server.json` at the repo root; also `/.well-known/mcp-server.json` on the store |
| Quick add | `claude mcp add --transport http proagentstore https://mcp.proagentstore.online/mcp` |

## Auth and safety

| Concern | Where | Contract |
|---|---|---|
| OAuth 2.1 + PKCE | `src/oauth-provider.ts`, plus the library | `apiRoute: "/mcp"`. `authorizeEndpoint /authorize`, `tokenEndpoint /token`, DCR at `/register`. `allowPlainPKCE: false` and `/authorize` hard-rejects a missing `code_challenge`. `accessTokenTTL` 86400. |
| Consent → identity | `src/oauth-provider.ts` | `/authorize` renders GitHub/Google buttons, stashes the parsed `AuthRequest` in KV under a nonce, and sets a `pags_authnonce` cookie. `/oauth/callback` requires the cookie to match (browser binding, blocks login-CSRF), exchanges a single-use `?code=` at `POST /v1/auth/mcp/exchange` server-to-server (the raw session never appears in a URL), validates it against `/v1/auth/me`, then `completeAuthorization`. |
| Grant props | `src/oauth-provider.ts` → `src/index.ts` | `props = { authToken, mcpScopes, mcpSubject }`. `PagsMcp.init()` reads them into `userToken` / `scopes` / `subject`. `userId` is colon-stripped for the library; the real uid stays in `mcpSubject`. |
| Session verification | `src/session.ts` | `verifyMcpSession` — HMAC-SHA256 over `data.sig`, `exp` checked. Needs `SESSION_SIGNING_KEY` to match the API worker's. |
| Scopes | `src/safety.ts` | `MCP_SCOPES = read write runtime destructive`. `DEFAULT_SCOPES = read write runtime` — `destructive` is **never** a default. `parseScopes` falls back to the default set when it finds no valid PAGS scope (so `openid email profile` yields the default, not nothing). |
| Read-only mode | `src/safety.ts` | `requirePermission` denies any non-`read` scope when `ctx.readOnly` or `env.MCP_READ_ONLY === "1"`. Set the var in `wrangler.toml` `[vars]` to force it server-wide. |
| Confirmation | `src/safety.ts` | `requireConfirmation(ctx, tool, confirm, expected)` — exact `===`. By convention `expected` is the tool's own name; `remove_repo` is the exception (`remove_all_repos`, and only when removing all). |
| Dry run | `src/safety.ts` | `dryRun(ctx, tool, action, input, wouldDo)` returns `{dryRun:true, tool, action, wouldDo}` and audits `action:"dry_run"`. Always place it **after** the permission check. |
| Audit | `src/safety.ts` | `audit()` writes `audit:{subject}:{iso}:{uuid}` to `OAUTH_KV` with a 90-day TTL. No-ops without both `OAUTH_KV` and `ctx.subject` — so a per-call `token` argument (which sets `subject: undefined`) is intentionally unaudited. `listAuditEvents` reads back, newest first, cap 200. |
| Redaction | `src/safety.ts` | `redact()` runs on every audited event: key-name match (`token|secret|password|credential|authorization|api_key|…`) plus a value-shape regex (`sk-…`, `gh[pousr]_…`, `xox…`, `AIza…`, JWT, `Bearer …`). Strings truncate at 500 chars, recursion at depth 8. |

`src/safety.ts` is the module other OFO stores are being told to vendor. Keep it
dependency-light (it imports only `./http.js`) and keep `safety.test.ts` passing.

## Code layout

```
src/
├── index.ts              PagsMcp (McpAgent DO) + 31 tool registrations + OAuthProvider export
├── oauth-provider.ts     /authorize, /authorize/continue, /oauth/callback, /health, root
├── session.ts            verifyMcpSession (HMAC session → uid)
├── safety.ts             scopes, requirePermission, requireConfirmation, dryRun, audit, redact
├── http.ts               McpEnv, text/jsonText/authRequired, apiCall, authedCall
├── storage-tools.ts      13 tools — collections, records, agent files, KB search, activity
├── repo-tools.ts         GitHub helpers + starter templates (no tool registrations)
└── instance-tools/
    ├── index.ts          builds the ctx, calls the five group registrars
    ├── shared.ts         TokenResolver/SafetyResolver, trigger config, board grouping
    ├── base.ts           67 tools — the bulk of the instance surface
    ├── apply.ts          4 tools, gated to surfaces:["apply"]
    ├── repo.ts           3 tools, gated to surfaces:["repo"]
    ├── coding.ts         system_status (gated to surfaces:["coding"]) + 3 loop tools
    └── connectors.ts     4 tools — connector status and folder grants
```

**126 tool registrations** (`.tool(` in the files above): 31 in `index.ts` — 10 of them
inside a `groups.has("coding")` block — 13 in `storage-tools.ts`, and 82 across
`instance-tools/`. 108 are always registered; 18 are surface-gated.

Tests sit beside their modules: `index.test.ts`, `index-auth.test.ts`,
`instance-tools.test.ts`, `oauth-provider.test.ts`, `repo-tools.test.ts`,
`safety.test.ts`, `storage-tools.test.ts`.

## Adding a tool

1. Pick the file by group. A new instance tool goes in `instance-tools/base.ts` unless it
   belongs to a gated surface.
2. Signature: `server.tool(name, description, zodShape, handler)`. `name` is
   `snake_case`. The description is what a calling model reads — say what it does, what
   it does *not* do, and which tool to call first.
3. Every authenticated tool takes
   `token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.")`
   and starts with `const sessionToken = tokenFor(token); if (!sessionToken) return authRequired();`.
4. Then, in this order: `requirePermission` → `requireConfirmation` (destructive only) →
   `if (dry_run) return dryRun(...)` → `authedCall` → `audit(..., {action:"completed"})` →
   `jsonText`.
5. Choose the scope honestly. `write` widens what exists; `runtime` spends or drives
   something; `destructive` deletes, overwrites, or commits an irreversible external
   action. `call_instance_tool` is `write` even for reads because it is a generic
   invoker.
6. If it is agent-specific, wrap it in `if (groups.has("<surface>"))` — otherwise a user
   who has no such agent sees a tool that can never apply to them.
7. Update the table in `README.md` and, if it changes the contract, `AGENTS.md` and
   `platform-docs/mcp.md`.

## Gotchas

- **Register once.** `McpAgent.onStart()` calls `init()` on every DO start but
  `this.server` outlives it. Registering the same tool twice throws
  `Tool ... is already registered`, which cancels the MCP stream and hangs clients until
  they time out. `this.toolsRegistered` guards it — do not remove it, and do not
  register tools outside `init()`.
- **Never return a bare 200 on a non-`/mcp` path.** MCP's HTTP transport opens a
  long-lived stream with a GET, so a 200 with a short body reads as "stream opened, then
  dropped" and a spec-correct client redials about once a second, forever. Unknown paths
  404; `/` answers a protocol client with a JSON-RPC 405 pointing at `/mcp`. The flood is
  invisible to every guard we have — see the comment in `oauth-provider.ts`.
- **`apiCall` never lets a non-2xx pass as success.** It returns
  `{error: "API <status>", ...}`, so a tool cannot format a failure as a result. Do not
  add a code path that discards that.
- **No `isError`.** Nothing in this worker sets it; failures are text starting `Error: `
  or JSON carrying an `error` key. If you add structured error signalling, update
  `AGENTS.md` rule 3 in the same change.
- **Models send JSON strings for object params.** `create_agent` / `update_agent` accept
  `z.union([z.record(z.unknown()), z.string()])` and parse a string, because rejecting it
  turns a working call into a retry loop. Do the same for any new object-shaped argument.
- **`userGroups()` swallows its error.** An unauthenticated or transient failure yields
  an empty set, i.e. no agent-specific tools this connection. That is intentional, but it
  means "my tool disappeared" is usually an auth problem, not a registration bug.
- **`/health`'s `tools` count comes from `src/tool-count.ts`.** It answered a hardcoded
  `41` for months while 124 were registered — and `oauth-provider.test.ts` asserted the
  41, so the test locked the wrong number in rather than catching it. `index.test.ts` now
  holds `MCP_TOOL_COUNT` / `MCP_TOOL_ALWAYS_ON` to a REAL registration run, and
  `scripts/docs-drift.mjs` holds every prose claim to the constants. Adding a tool fails
  the test until the constant moves. `tools/list` is still the authoritative surface for a
  given connection, because 18 tools are surface-gated.

## Bindings and secrets

`wrangler.toml`:

| Kind | Name | Purpose |
|---|---|---|
| var | `API_BASE` | `https://api.proagentstore.online` |
| var | `AUTH_START` | `…/v1/auth/github/start`; `startEndpointFor` rewrites the provider segment |
| var | `GITHUB_ORG` | `ProAgentStore` |
| var | `MCP_READ_ONLY` | Unset by default. `"1"` forces server-wide read-only. |
| KV | `OAUTH_KV` | OAuth tokens/grants, `authreq:` nonces, `audit:` events |
| DO | `MCP_OBJECT` → `PagsMcp` | SQLite-backed, migration tag `v1` |
| secret | `SESSION_SIGNING_KEY` | Must match the API worker's |
| secret | `GITHUB_TOKEN` | Org PAT for repo scaffold/read/write tools |

Secrets are **not** in Doppler (no such project). Names live in `~/dev/ops/inventory.yaml`; values are SOPS-encrypted in `~/dev/ops/secrets.enc.yaml` once rotated; Worker runtime secrets go in via `wrangler secret put`. Never commit a value.

## Commands

```bash
pnpm --filter proagentstore-mcp dev
pnpm --filter proagentstore-mcp typecheck
npx vitest run workers/mcp      # from the repo root
pnpm --filter proagentstore-mcp deploy
```

Deploys run from CI, not from a laptop. `.github/workflows/deploy-mcp.yml` fires on any
push to `main` touching `workers/mcp/**`: install → `pnpm --filter proagentstore-mcp
typecheck` → `wrangler deploy` → a `/health` smoke test (5 retries).
`.github/workflows/publish-mcp-registry.yml` republishes `server.json` to the MCP
registry when that file changes, via `mcp-publisher` with GitHub OIDC — so bump
`server.json`'s `version` when the published metadata should change.
