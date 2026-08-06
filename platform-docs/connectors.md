# Connectors

ProAgentStore has two connector layers, for two different jobs.

1. **Ingest connectors** (this page's original subject): account-level OAuth providers —
   **Google Drive / Google Docs** and **Zoho WorkDrive** — whose files are imported into an
   agent instance's knowledge, narrowed by per-folder grants. (Gmail is a related OAuth
   integration used by the apply flow to read verification emails; it is not a knowledge-ingest
   connector.)
2. **Registry connectors** (the tool framework, issues #84–#90): a declared registry of
   integrations an agent drives as **tools** — GitHub, HTTP/REST, Web Search, Meta, Terminal,
   legacy tmux, local repo inspection, supervision, outbound MCP, Google Sheets, and the
   experimental browser. See [Registry connectors](#registry-connectors)
   below.

## Registry connectors

A registry connector is declared ONCE in `workers/api/src/lib/connectors/registry.ts` as
`{ id, label, auth, scopes: {read, write}, grantModel, tools }`; the tool catalog, the
`connectorClient` auth dispatch, and capability-based gating all derive from that single entry.
An agent gets a connector's tools only when it declares them in `capabilities.tools`.

| Connector | Auth | Scopes | Tools (examples) |
|---|---|---|---|
| `github` | GitHub-App installation token | read + write | `github_list_issues`, `github_read_issue`, `github_create_issue` (write), `github_workflow_runs` |
| `http` | vault API key | read + write | `http_request` (call any REST API as configuration) |
| `web-search` | vault API key | read | `web_search` (Google Custom Search) |
| `meta` | platform token (`META_ACCESS_TOKEN`) | write | `whatsapp_send_message`, `instagram_send_dm` |
| `terminal` | none (runner relay) | read + write | `terminal_list_targets`, `terminal_capture`, `terminal_run_command` (write), `terminal_send_keys` (write) |
| `tmux` | none (runner relay) | read + write | Legacy compatibility: `tmux_list_sessions`, `tmux_capture_pane`, `tmux_run_command` (write) |
| `browser` | none (runner relay) | read + write | `browser_snapshot`, `browser_navigate` (write), `browser_act` (write) — experimental |
| `repo-local` | none (runner relay) | read | `repo_tree`, `repo_read_file`, `repo_git`, `repo_remote` |
| `supervision` | none (internal) | read + write | `list_subordinates`, `subordinate_status`, `delegate_goal` (write), `check_delegation` |
| `mcp` | bearer token **per endpoint** | read + write | `mcp_list_tools`, `mcp_call_tool`, `mcp_list_resources`, `mcp_read_resource`, `mcp_list_prompts`, `mcp_get_prompt` against user-configured MCP servers |
| `google_sheets` | OAuth2 | read + write | `sheets_read`, `sheets_append` |

**Auth** is minted through one path — `connectorClient(env, provider, {userId, instanceId})`:
a GitHub-App installation token, an OAuth refresh→access exchange, a key from the user's BYOK
vault (`user_api_keys`), or none for local relay connectors (terminal/tmux/browser/repo-local reach the
user's machine over the WebSocket relay — machine ownership is already enforced by the relay-token
handshake). The generic Terminal connector targets `tmux:<session>`, `kitty:<window-id>`, or
`iterm2:<window>:<tab>:<session>`.

**Write-consent gating (#90).** Every `scope:"write"` connector tool is refused unless the
instance has explicit write-consent for that connector (`instance_connector_consent`, migration
0051). `runRegistryTool` checks consent *before* dispatch, fail-closed; read-only connectors
reject write-scoped calls outright. So `github_create_issue`, Meta messaging, and `browser_*`
can only write where the instance owner has granted that connector's write scope. Reads
(`github_list_issues`, `browser_snapshot`, …) need only the connector granted / the runner online.

**Outbound MCP is the exception to connector-level consent (#262).** Every other connector IS the
remote system, so granting `github` write names GitHub. An MCP endpoint is *configuration supplied
at call time*, so one `mcp`/write row used to authorise every server the instance could name.
Reach is therefore also named per **(instance, endpoint, remote tool)** in `instance_mcp_consent`
(migration 0079), checked before anything touches the network or the vault. A `*` grant covers a
server's ordinary tools but **not** ones whose names read as destructive — and that test runs on
the name *we* put on the wire, deliberately not on the server's own `destructiveHint`, because the
annotation is authored by the party being defended against.

**And to connector-level credentials (#286).** For the same reason, the *credential* is scoped to
the endpoint too. `connectorClient` resolves a `token` connector from `user_api_keys` at
`(user_id, provider)` — one bearer slot for the whole connector — which for outbound MCP meant one
token shared by every authenticated server a user could name, and therefore a token issued by
server A being sent verbatim to server B as soon as anything pointed at B. MCP credentials live in
`mcp_credentials` (migration 0083) keyed on `(user_id, normalized endpoint)` — the *same* key
consent uses — under the same envelope encryption as every other stored secret (per-row AES-256-GCM
DEK wrapped with AES-KW under `KEY_ENCRYPTION_KEY`). There is deliberately **no fallback** to the
provider-wide slot: an unbound token is one whose server we do not know, and sending it anyway is
the disclosure. Manage them at `GET/PUT/DELETE /v1/instances/:id/mcp/credentials`; a stored token is
never readable back, an expired one fails closed with a reconnect prompt rather than being sent, and
the pre-#286 account-wide token is reported so it can be bound to one server or discarded.

**Connecting a server** (`POST /v1/instances/:id/mcp/test`, console → Settings → MCP connections):
enter a URL → it is validated and normalized → the protocol era is negotiated → the server's own
`tools/list` is read (read-scoped, no consent needed — you cannot approve tools you cannot
enumerate) → tick the ones this agent may call. The report says which of the discovered tools are
*actually* callable and which of the three gates (declared tool · connector write consent ·
per-tool grant) blocks each one: a test that reported "connected" while consent still refused every
call would be worse than no test. The request goes out through the same SSRF-guarded, https-only
path as any other outbound MCP call — there is no test-only fast path, because a "test this URL"
button on user-supplied config is exactly the shape of an SSRF primitive.

**Granted remote tools become first-class tools** (#261). A connected server's tools used to reach
the model only through `mcp_call_tool` — a stringly-typed passthrough the model had to aim by
remembering a tool name and hand-building an `args` blob, discarding at the boundary the published
schemas that are the whole reason to speak MCP. Now every tool that a server publishes **and** the
owner has granted is projected into an ordinary function tool carrying the server's own name,
description and input schema. `mcp_call_tool` remains, as the escape hatch for anything outside the
projected set.

The catalog is cached in `mcp_tool_catalog` (migration 0086, keyed `(user_id, normalized endpoint,
remote tool)`) and **refreshed by the connection test** — the one path that already asks a server
what it publishes. A refresh *replaces* that endpoint's rows, so a tool the server has removed stops
being offered instead of lingering as a callable ghost. A grant made before the catalog was ever
fetched imports nothing until the server is tested once.

The synthetic name an agent sees (`mcp_<endpoint-slug>_<tool>`) is a **label, not an identity**: it
is derived at projection time, never stored, and never consulted by a gate. Dispatch resolves it
back to `(endpoint, remote tool)` and runs the ordinary `mcp_call_tool` path — same #262 consent on
the remote name, same destructive-name test on the name we put on the wire, same per-endpoint
credential, same trace row. Getting that backwards is the quiet failure this design exists to avoid:
an invented alias never matches a grant row, and a mangled one stops looking destructive to a test
that only sees the mangled form. Two servers publishing `create_site` are already distinct, because
the endpoint is part of both the grant and the label. The server's own description is quoted to the
model as a *claim about itself*, not restated as an instruction — a tool description is untrusted
text placed in front of the model every turn, and unlike a resource body there is nowhere in a tool
definition to put a fence.

**Resources and prompts, not only tools** (#263). An MCP server also publishes *resources* (files,
records, design metadata) and *prompts* (reusable interaction templates), and an agent that can see
only the tools has to guess at everything else — which is the failure this connector exists to
remove. `mcp_list_resources` / `mcp_read_resource` / `mcp_list_prompts` / `mcp_get_prompt` ride the
same endpoint, credential, era-negotiation and tracing path as the tool calls. Three properties are
deliberate rather than incidental:

- **Read-scoped, so no write consent and no per-tool grant.** They match `tools/list`, which is what
  makes per-tool consent approachable at all — you cannot approve tools you cannot enumerate. What
  bounds them is the endpoint's own credential, the agent's declared `capabilities.tools`, and the
  owner's per-tool off-switch. #262's key names a *tool*, and a resource is a URI; if read consent
  is wanted later the honest shape is a `kind` column, not a URI stuffed into the tool column.
- **Fenced as data, not instructions.** `resources/read` and `prompts/get` put remote text straight
  onto the model's instruction path — the same hazard RAG has — so both wrap their payload in the
  shared `<untrusted_reference_material>` fence (`lib/untrusted-fence.ts`), *in the connector*, so
  it holds identically in chat, in a pipeline step, over `POST /v1/instances/:id/tools/:name`, and
  over MCP. A fence applied at one surface leaves three unfenced.
- **Capped and truncated visibly.** A resource can be a whole file; a silent cut produces a model
  reasoning confidently about the half it received, so a truncated read says which half it got.

A server that implements none of this answers `-32601`, which reads as *"this server publishes no
resources"* rather than as a connection failure — a model told the connection failed retries and
then blames the server.

**A server cannot ask this client a question** (#264). Across every protocol revision this client
speaks, the mechanism for a server needing more input mid-call is **elicitation** — a server→client
request. It is impossible here by construction, three times over: we advertise
`clientCapabilities: {}`, a modern-era call is one stateless POST with no server→client channel at
all, and answering on the legacy transport would mean POSTing a response while the server holds the
original stream open — which the client cannot do, since it reads that stream to completion before
returning. So elicitation is **not implemented**, and is not faked. What the client does instead is
*recognise* the ask and fail with a sentence that says the call did not complete and nothing was
submitted, instead of reporting an unanswerable question as an unparseable response and sending the
user to debug a transport that worked. Supporting it for real means declaring the capability and
adding a resumable channel — a transport change, tracked on #264.

**Every outbound MCP call is traced** (#265) as one redacted `agent_events` row (`source: "mcp"`):
endpoint, method, remote tool, era + negotiated version, HTTP status, duration and a failure class,
plus an `mcp.denied` row written *before* dispatch when consent refuses. Argument and result
**values are never recorded** — only argument key names and byte counts. A log that keeps the
arguments of an arbitrary remote tool is a second copy of the user's data with the audit trail's
retention; key names answer "did it send the field?" without becoming that. Owners read their own
via `GET /v1/instances/:id/trace?source=mcp`; operators get cross-tenant filtering by user,
instance, endpoint and remote tool on `/v1/admin/trace`, with `/v1/admin/trace-endpoints` listing
which endpoints and tools exist at all.

**A delegated run records what it DID, not only how it ended** (#294). A run used to write down
its objective and its terminal outcome and nothing in between — so a run that merged its own pull
requests to `main` unattended reported "done", and the supervisor reviewing it had trust rather
than review. Consequential acts (a pull request opened or **merged**, a push, a push to the trunk,
a force-push, a branch or file delete, a `reset --hard`, a publish, a deploy) are now recorded as
`agent_events` rows on the generic `act.consequential` event, `level: "warn"` when irreversible, and
surfaced on `subordinate_status`, `check_delegation`, the run's own `detail` and its board card.

The signal is the coding Engine's own **stream-json `tool_use` protocol events** — the literal
command it invoked, plus whether the matching `tool_result` came back an error — not its prose, and
not a repo-state diff (a pull request is not a git object: `gh pr create` changes nothing locally
and `gh pr merge` changes only a remote ref nobody has fetched). The record is secret-redacted at
capture and deduplicated on a deterministic row id, so a console poll and a Pilot capture racing
each other cannot write the same merge twice. **Only a stream-json engine reports acts**, so an
absent `acts` field means *not observed* and never "it changed nothing"; the tool legends say so, so
a supervisor cannot read silence as an all-clear. Read a run's acts with
`GET /v1/instances/:id/trace?trace_id=<runId>` or MCP `agent_trace`. Requires CLI ≥ **0.4.36**.
Whether an agent should be *allowed* to merge unattended is a separate, open policy question — this
only makes it visible.

**The browser connector is experimental** and additionally gated behind the API worker's
`BROWSER_TOOLS_ENABLED` env flag (fail-closed when unset) — first-party / self-use only until the
browser trust model lands. It bridges the runner's real-Chrome hands (`/browser/snapshot` +
`/browser/act`) into the registry so a config/data agent can drive a browser without bespoke code.

### Declarative connector manifests

A connector no longer needs bespoke code. Most are now defined as a **manifest** —
`{ id, label, auth, baseUrl, tools[] }` — compiled by `compileConnector` into the same
`Connector`/`ToolDef` shape above (github, meta, web-search, and google_sheets are all manifests today). A tool
is either **request-as-data** (`method`/`path`/`query`/`body` with `{{param}}` interpolation +
`responseMap` extraction, run through the shared SSRF-guarded executor) or a named **handler**
for the rare custom case. Manifest `auth` is one of `none` · `api-key` (vault key) · `platform-token`
(a Worker env token) · `app` (GitHub-App) · `oauth2`.

**Generic OAuth2** (`oauth2` connectors) uses one flow for every provider, driven by the manifest's
`authUrl`/`tokenUrl`/`scopes` + the env-var names for the client credentials:

```text
GET    /v1/connectors/:id/oauth/start     → returns the provider authorize URL (signed state)
GET    /v1/connectors/:id/oauth/callback  → exchanges the code, stores the refresh token (encrypted)
GET    /v1/connectors/:id/oauth/status    → connected? configured?
DELETE /v1/connectors/:id/oauth           → disconnect
```

So adding an OAuth SaaS (Slack, Sheets, Notion) is a manifest + an OAuth app whose redirect points
at `/v1/connectors/<id>/oauth/callback` — no new route code. Client credentials live in Worker
secrets (named by the manifest, resolved server-side); refresh tokens are envelope-encrypted under
`KEY_ENCRYPTION_KEY`, exactly like the ingest connectors.

## Recommended Permission Model (ingest connectors)

Connect providers to the account, not to individual agents.

```text
User account
  -> provider connection
  -> folder/shared-drive grants
  -> agent access
```

This avoids repeated OAuth flows, keeps revocation simple, and lets the user reuse one provider connection across many agents without giving every agent blanket access.

## Google Docs Through Google Drive

Google Docs files are Drive files with Google Docs MIME types. To let an agent work with Google Docs, connect Google Drive and grant the agent access to the relevant folders or shared drives.

Production OAuth callback:

```text
https://api.proagentstore.online/v1/drive/google/callback
```

Worker configuration:

```text
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<worker secret>
```

Cloudflare secret:

```bash
wrangler secret put GOOGLE_CLIENT_SECRET
```

## Client Flow

1. The user opens the ProAgentStore console.
2. The user chooses **Connect Google Drive**.
3. Google asks the user to approve the OAuth consent screen.
4. ProAgentStore stores the encrypted account-level connection.
5. The user grants one or more folders or shared drives to an agent.
6. The agent imports, searches, reads, or writes only within those grants.

## Folder Grants

Folder grants are the boundary agents should use by default.

- Grant the smallest folder that contains the documents the agent needs.
- Prefer a shared drive or dedicated project folder for team workflows.
- Avoid whole-drive access unless the agent is explicitly an account-wide document manager.
- Revoke a folder grant when an agent no longer needs it.

## Zoho WorkDrive

Zoho WorkDrive follows the same model:

1. Connect the Zoho account to the user account.
2. Store the encrypted connection and refresh metadata.
3. Let the user grant selected WorkDrive folders or team folders to agents.
4. Enforce grants server-side before import, read, write, or search actions.

Nested WorkDrive folders must preserve the provider folder identity chain so grants on a parent folder can authorize descendants without confusing sibling folders.

## Agent Access Rules

Agents should never receive raw provider credentials.

Agents receive scoped platform capabilities:

- list granted folders
- search granted files
- import files into instance knowledge
- read allowed files
- write only when the grant and tool scope allow it

All access should be checked against the authenticated ProAgentStore user, the private agent instance, and the provider grant.

## Troubleshooting

If Google Drive or Google Docs connection fails:

- Confirm the OAuth app callback exactly matches `https://api.proagentstore.online/v1/drive/google/callback`.
- Confirm `GOOGLE_CLIENT_ID` is configured in the API worker environment.
- Confirm `GOOGLE_CLIENT_SECRET` is set as a Worker secret.
- Confirm the user approved the requested scopes.
- Confirm the agent has a folder or shared-drive grant after the account connection succeeds.

If an agent cannot see a document:

- Confirm the document is in a granted folder or shared drive.
- Confirm the provider account itself can access the document.
- Confirm the grant belongs to the same ProAgentStore account and private instance.
- Disconnect and reconnect only when OAuth refresh fails; missing grants should be fixed through folder access.
