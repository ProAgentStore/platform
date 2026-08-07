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
| `supervision` | none (internal) | read + write | `list_subordinates`, `subordinate_status`, `delegate_goal` (write), `check_delegation`, `set_direction` (write) |
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

**A server that needs something from you pauses the call** (#264). Across every protocol revision
this client speaks, the mechanism for a server needing more input mid-call is **elicitation** — a
server→client request (`elicitation/create`). Answering one *in band* is impossible here by
construction, three times over: we advertise `clientCapabilities: {}`, a modern-era call is one
stateless POST with no server→client channel at all, and answering on the legacy transport would
mean POSTing a response while the server holds the original stream open — which the client cannot
do, since it reads that stream to completion before returning. And a human takes minutes, which no
request may wait for.

So the call **pauses** instead. The ask is parsed into a form (message plus the flat primitive
fields MCP's elicitation schema allows), one pending row is written with the call's **arguments
envelope-encrypted at rest**, and the agent is told the call did **not** complete and that a person
is now in the loop — the sentence ends *"do not report this as done"*, because the failure mode this
exists to stop is a model narrating a submission that never happened. The owner answers it in the
chat surface (`GET`/`POST /v1/instances/:id/mcp/input-requests`), and the answer **retries the
original call** with the values merged into the remote tool's arguments.

Four properties are load-bearing:

- **The resume is an ordinary `mcp_call_tool`.** It re-checks the per-(endpoint, tool) grant and
  re-resolves that endpoint's credential rather than being waved through as *already authorized* —
  a grant revoked while the ask sat unanswered stops it. `traceId` carries across, so the paused
  call and the call that completes it sit under one run.
- **The answer is never stored.** There is no column for it: the values arrive on the resume
  request, are validated, merged and dispatched in the same handler, which is also where the held
  ciphertext is dropped. The trace records the answered field **names and a byte count**, never a
  value — an elicited value is more likely to be a password than an ordinary argument is.
- **Timeout and cancel are explicit.** An ask expires 30 minutes after it is raised, derived from
  the clock rather than from a sweeper having run, so the console badge and the answer gate cannot
  disagree. Cancelling sends nothing. Either way the ask is claimed exactly once, so a double click
  cannot make the remote call twice.
- **A malformed ask degrades to the old honest refusal.** An `elicitation/create` with no message,
  no `requestedSchema`, or a required field of a kind this client cannot collect is refused rather
  than half-understood: a form built from a guess collects the wrong values and sends them.

It is a **retry**, not an in-band answer, and that is stated in the console before you press the
button: a remote tool that half-completed before it elicited will run its first half again. Rounds
are bounded (3), because a server that never accepts the elicited values as arguments would
otherwise keep a person answering forever.

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

**A supervisor can read back the work it delegated** (#318). `check_work` answers "did I really do
that?" from the run record, scoped to the calling instance — deliberately, so an agent cannot
describe a sibling agent's run as its own. But a supervisor's runs are never on its own instance:
`delegate_goal` starts them on the subordinate. So a Lead that had delegated 90 seconds earlier, and
said so truthfully, read back *"you have not started any work on this instance — there are no runs.
If you told the user you did something, that was wrong; say so"* and retracted a true statement:
the anti-hallucination guard producing the exact failure it exists to prevent. Runs now record the
supervisor that asked for them (`agent_loop_runs.delegated_by`, migration 0090, audit-only and never
an authority), `check_work` reports own **and** delegated runs, and the correction sentence is
withheld from a delegator — for whom an empty own-instance record is the normal state and says
nothing about what happened. For an agent that delegates to nobody it is unchanged. A delegator's
delegations are also injected into its prompt directly, because the Lead in #318 *did* call
`check_work` and still recanted.

**Name a subordinate however you have it** (#320). `subordinate_status`, `check_delegation` and
`delegate_goal` accept a subordinate's **name** ("FAS platform") or a unique fragment of it, not
only its instance id — resolved against the supervision graph, so a looser spelling never widens
*who* is reachable, and refused rather than guessed when it is ambiguous. The answer echoes back
which agent it resolved to. Previously every turn cost a round trip (`subordinate_status(name)` →
refused → `list_subordinates` → `subordinate_status(uuid)`), and that refusal reported
`success: true`, so a tool log showed twice as many successful status calls as there had been. A
refusal is now `success: false`. Each subordinate's `repo` block also carries `githubRepo` — the
repository's `owner/name` on GitHub, the only value a GitHub tool accepts; `repo.name` is a display
label that may look like a path and not be one.

**The Lead owns direction, each subordinate owns tasks** (#330). A supervisor could say what its
agents had *done* — `subordinate_status` reports every subordinate's board cards, runs, repo state
and consequential acts — but not what any of them was *for*. Asked "what should FWS be working on?"
it answered from recent runs, which is history rather than intent, and direction that lived only in
the conversation died with the thread. A **direction** (an epic) is now a field on the supervision
edge, `agent_supervision.config.direction`: no new table, and `idx_supervision_subordinate` being
UNIQUE makes "one direction per agent" the primary key rather than application logic. It reaches
the model three ways — on `list_subordinates`, on `subordinate_status`, and as a derived
`## Your Agents` prompt block read fresh from the record every turn.

Attribution needs no column either: the epic is keyed `(supervisor, subordinate)`, and
`agent_loop_runs` already carries `delegated_by` + `instance_id` on one index, so "runs against the
FWS direction" is a query over what is already written.

**The agent proposes; the owner sets.** A direction is durable and lands on every later prompt, so
an agent able to write its own would convert one prompt injection — in a repo file, an issue body,
a remote MCP resource — into a *standing* instruction. `PUT /v1/instances/:id/supervision/:sid/direction`
is the only path that writes `setBy: "user"`, and that value is immutable to the agent; the
`set_direction` tool records `setBy: "agent"`, which comes back under a **different key**
(`proposedDirection`) whose legend says it carries no authority. The console shows a proposal as one
and turns its Save button into *Confirm* — confirming is the owner re-sending the text through the
owner's route. Same mechanism as memory's `(user-set)` marker. Clearing the field is how an epic
closes: nothing auto-closes it, because a subordinate that finished a task cannot attest to an epic.

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

### Which connectors an agent is offered

Because the provider connection is an **account** act, "is Google Drive connected" is the same
answer for every one of your agents — so the folder-grant control appeared on all of them, including
agents that only drive a terminal. `GET /v1/instances/:id/connectors` is the per-agent answer:

```text
{ id, label, grantModel, tools[], allowed, reason }
```

A connector that provides tools is judged on them — it belongs to an agent exactly when one of its
tools does, which is the verdict `GET /v1/instances/:id/tools` already reaches. The ingest
connectors (Google Drive, Zoho WorkDrive) provide **no** agent-callable tools on purpose, so they
are judged on where their content lands: an import becomes a document in that instance's knowledge
base and nowhere else, so an agent that cannot read a knowledge base gains nothing from a folder
grant (`reason: "no_knowledge"`). Gmail is always reported reachable (`reason: "permission"`) —
its inbox tool is granted by the per-agent inbox permission on the agent's Settings tab, not by the
tool allowlist.

This is a **visibility** answer, not a second permission gate: a folder grant's reach is still
checked on every Drive route, and an agent that declares no tool allowlist at all stays permissive.

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
