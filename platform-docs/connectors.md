# Connectors

ProAgentStore has two connector layers, for two different jobs.

1. **Ingest connectors** (this page's original subject): account-level OAuth providers —
   **Google Drive / Google Docs** and **Zoho WorkDrive** — whose files are imported into an
   agent instance's knowledge, narrowed by per-folder grants.
2. **Registry connectors** (the tool framework, issues #84–#90): a declared registry of
   integrations an agent drives as **tools** — GitHub, HTTP/REST, Web Search, Meta, Terminal,
   legacy tmux, local repo inspection, supervision, outbound MCP, Google Sheets, **Gmail**, and
   the experimental browser. See [Registry connectors](#registry-connectors) below.

## Registry connectors

A registry connector is declared ONCE in `workers/api/src/lib/connectors/registry.ts` as
`{ id, label, auth, scopes: {read, write}, grantModel, tools }`; the tool catalog, the
`connectorClient` auth dispatch, and capability-based gating all derive from that single entry.
An agent gets a connector's tools only when it declares them in `capabilities.tools`. That holds on
**every** surface, pipeline steps included: a stored pipeline definition is data the agent runs, not
a second declaration, so a step naming a connector tool the agent does not declare is refused — at
attach time if the pipeline is attached through the API, and at dispatch either way. The pipeline
*step library* (`map`, `filter`, `slice`, `dedupe_upsert`, …) is not connector-provided and is
therefore not declarable, so it is exempt by construction.

Three of those exempt steps still reach a connector tool from inside themselves, and the check sees
it: `geocode` and `fan_out` need `http_request`, and `enrich` runs the tool named in its own
`tool` input. So a pipeline whose only step is `geocode` is refused up front on an agent that
declares nothing, with a message naming the STEP (`step 0 ("geocode") needs "http_request"`) rather
than a tool the definition never mentions. An `enrich` whose tool comes from a `$param` cannot be
resolved before the run and is refused at dispatch instead.

| Connector | Auth | Scopes | Tools (examples) |
|---|---|---|---|
| `github` | GitHub-App installation token | read + write | `github_list_issues`, `github_read_issue`, `github_list_pulls`, `github_read_pull`, `github_workflow_runs`, `github_create_issue` (write), `github_comment_issue` (write), `github_update_issue` (write — close/reopen, relabel, assign) |
| `http` | vault API key | read + write | `http_request` (call any REST API as configuration) |
| `web-search` | vault API key | read | `web_search` (Google Custom Search) |
| `meta` | platform token (`META_ACCESS_TOKEN`) | write | `whatsapp_send_message`, `instagram_send_dm` |
| `terminal` | none (runner relay) | read + write | `terminal_list_targets`, `terminal_capture`, `terminal_run_command` (write), `terminal_send_keys` (write), `terminal_send_message` (write — type text + Enter + settle + confirm) |
| `tmux` | none (runner relay) | read + write | Legacy compatibility: `tmux_list_sessions`, `tmux_capture_pane`, `tmux_run_command` (write), `tmux_send_message` (write — type text + Enter + settle + confirm) |
| `browser` | none (runner relay) | read + write | `browser_snapshot`, `browser_navigate` (write), `browser_act` (write) — experimental |
| `repo-local` | none (runner relay) | read | `repo_tree`, `repo_read_file`, `repo_git`, `repo_remote` |
| `supervision` | none (internal) | read + write | `list_subordinates`, `subordinate_status`, `delegate_goal` (write), `check_delegation`, `set_direction` (write), `transfer_conversation` (write) |
| `mcp` | bearer token **per endpoint** | read + write | `mcp_list_tools`, `mcp_call_tool`, `mcp_list_resources`, `mcp_read_resource`, `mcp_list_prompts`, `mcp_get_prompt` against user-configured MCP servers |
| `google_sheets` | OAuth2 | read + write | `sheets_read`, `sheets_append` |

**Auth** is minted through one path — `connectorClient(env, provider, {userId, instanceId})`:
a GitHub-App installation token, an OAuth refresh→access exchange, a key from the user's BYOK
vault (`user_api_keys`), or none for local relay connectors (terminal/tmux/browser/repo-local reach the
user's machine over the WebSocket relay — machine ownership is already enforced by the relay-token
handshake). The generic Terminal connector targets `tmux:<session>`, `kitty:<window-id>`, or
`iterm2:<window>:<tab>:<session>`.

**A `terminal`/`tmux` drive is unmetered, by construction.** A pane carries rendered text, not the
structured `result` event a Coder engine reports its own tokens and cost from, so a coding CLI
driven through a pane produces no cost row and no `$` figure on the Usage page — it is recorded as
*unmetered*, which is a name and never a number. A `$0` next to a terminal-operator agent means
*not measured*, not *free*. This is the deliberate trade for a real attachable terminal; see
[ADR 0003](https://github.com/ProAgentStore/platform/blob/main/docs/adr/0003-a-coder-engine-reports-its-own-turns.md)
and [Browser Runtime](browser-runtime.md#coder-agents).

**Write-consent gating (#90).** Every `scope:"write"` connector tool is refused unless the
instance has explicit write-consent for that connector (`instance_connector_consent`, migration
0051). `runRegistryTool` checks consent *before* dispatch, fail-closed; read-only connectors
reject write-scoped calls outright. So `github_create_issue`, Meta messaging, and `browser_*`
can only write where the instance owner has granted that connector's write scope. Reads
(`github_list_issues`, `browser_snapshot`, …) need only the connector granted / the runner online.

**Pull requests are READ-ONLY here, deliberately (#401).** `github_list_pulls` and
`github_read_pull` answer "is my PR green, did anyone review it, does it conflict" without a
browser. There is no `github_merge_pull` and there will not be one at this layer: merging is what
the per-repo **merge policy** (#314) governs, and a tool that bypassed it would hand the agent
exactly the authority that setting exists to withhold. Both reads — and the issue reads beside them
— go through `lib/github-cache.ts`, which stores GitHub's `ETag` and re-sends it as
`If-None-Match`, keyed by **(user, repo, resource)** with the auth context (`anon` /
`installation:<id>`) recorded in the entry and re-checked on every read. A mismatch is a miss, so a
cache can never become the way one tenant reads another's private repo. A 304 is exempt from
GitHub's *primary* rate limit only, so the panels' poll intervals are unchanged.

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

**The default is "send this endpoint's credential", and it stays that way (#552).** Every MCP tool
takes an `auth` input; omitting it means *send the credential stored for this endpoint*, and only
`auth:"none"` sends nothing (`readEndpoint` in `connectors/mcp.ts`). An agent built around one MCP
server usually mirrors that as a creator-declared `auth_mode` setting defaulting to `bearer`. The
consequence is real: the first call from a fresh subscription to a server that needs **no** auth
refuses for a missing credential. Flipping the default to "send nothing" was considered and
rejected — it fails **open** on a server that does want a credential, and #258/#286 were careful in
the other direction, where a decision that errs toward not sending is the one that cannot leak. The
cost of the fail-closed default is one confusing refusal, so the refusal is where the work went.

**A missing credential says how to get one for *that* server.** The refusal used to be a constant
naming two remedies — paste a token, or `auth:"none"` — written before browser sign-in existed, and
it went on saying that for a week after #258 shipped the Connect button. An agent relaying it told
its owner, correctly quoting the platform, that PAGS could not sign in through a browser. So the
missing-credential path now runs the same RFC 9728/8414 discovery `authFailureGuidance` already runs
on a 401, and names only the remedy the answer supports:

| What the server publishes | What the refusal says |
|---|---|
| OAuth metadata with dynamic client registration **and** PKCE S256 | browser sign-in is available — test the address under Settings → Permissions & Connections → MCP connections and click **Connect** (exactly the condition `canAuthorize` gates that button on) |
| OAuth metadata without both of those | no Connect button is offered for it; paste an access token |
| no OAuth metadata, and it answered | there is nothing to sign in to and it may be open — retry with `auth:"none"` |
| nothing — it never answered, or discovery ran out of time | all three remedies, in the order worth trying |

The last row is the point of the design: a probe that fails looks identical to a server that
publishes nothing, so an unanswered discovery is reported as *unknown* rather than as "open". Saying
"try `auth:"none"`" about an OAuth-protected server we simply could not reach would be the same
confidently-wrong message one step along. Discovery is capped at 2.5s for the whole walk (a race,
not only an abort — an abort makes every probe fail, which is indistinguishable from a 404) and the
verdict is cached per endpoint for 10 minutes, one minute when unknown, so a retrying agent pays the
probe once. What did **not** change: the connector still refuses to retry unauthenticated when a
credential is missing. That is the fail-closed decision from #286, and turning "your token is gone"
into an opaque 401 from the server teaches users to blame the server.

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

**A supervisor can hand you over, when you ask** (#279). `transfer_conversation` moves the *person*
to another agent in the same graph — "put me through to the FWS coder" — and is the only tool on the
platform that acts on the browser rather than on the world. It is write-scoped, so the per-instance
write-consent gate covers it like any other write, and the destination is resolved server-side
through the same `resolveSubordinate` the tools above use: a name that is not in the graph is
refused, and an ambiguous one is refused rather than guessed, so untrusted text an agent has read
cannot become a navigation.

What makes it safe is the CHANNEL, not a rule the model is asked to follow. The destination travels
on the response to the chat turn the browser is already awaiting — so it is consumed once (no
replay on reload), it costs no extra round trip, and it **cannot carry a spontaneous transfer**,
because there is no response to put one on unless the user just spoke. An agent that decides
mid-loop you should be elsewhere has `notifyUser` plus the spoken "next" command, which is an offer
you accept with a word. Nothing is written into the destination instance: the handing agent's note
is read *aloud to you* on arrival and never into the other agent's transcript, so the marketplace's
storage isolation is untouched and the claim one agent makes about what you want stays correctable
by the only party who can correct it. Arrival is always announced by name, and the spoken **"go
back"** command returns you — it moves you back, and does not undo anything you said while you were
there.

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

Gmail used to be reported that way too, and no longer is: it now declares tools of its own, so it
is judged on them like any other tool-bearing connector. That is a tightening, not a loosening —
see [Gmail](#gmail) below.

This is a **visibility** answer, not a second permission gate: a folder grant's reach is still
checked on every Drive route, and an agent that declares no tool allowlist at all stays permissive.

## Gmail

Gmail reads the owner's mailbox, replies from it, and can tidy it — archive a message or mark it
read. Three OAuth scopes are requested, and they are deliberately separate powers:

| Scope | What it allows |
|---|---|
| `gmail.readonly` | Search, read a message, download its attachments. |
| `gmail.send` | Send a message. **Send only** — it cannot read, delete or modify. |
| `gmail.modify` | Archive, mark read, relabel. There is no narrower scope for these. |

`https://mail.google.com/` is **never** requested. That is the scope permanent deletion needs, so
nothing an agent does to a message is unrecoverable: `gmail.modify` can move mail to Trash, where
the owner has 30 days to retrieve it, and no tool exposes even that.

**What the consent screen shows.** All three appear as separate checkboxes, so you can tick reading
and sending and leave manage-mail unticked. Only what was actually **granted** is recorded, so an
account that declines it keeps reading and sending — `gmail_archive` and `gmail_mark_read` are the
only two tools that then refuse, and Preferences → Connections says so on the row: *"cannot archive
or mark read — reconnect to allow managing mail"*.

Reconnecting genuinely re-asks. The flow sends `prompt=consent`, so an account connected before
manage-mail existed is shown the new checkbox rather than being handed its old grant back.

### Tools

| Tool | Scope | What it does |
|---|---|---|
| `gmail_search` | read | Gmail search syntax; returns ids, senders, subjects, snippets, attachment names. |
| `gmail_read_message` | read | Full body, recipients, threading headers, and the attachment manifest. |
| `gmail_download_attachment` | read | Saves one attachment into the agent's **file store** and returns its `file_id`. It never returns the bytes — they would be useless in the model's context and large enough to evict everything else. |
| `gmail_reply` | **write** | Replies in-thread, optionally attaching files by id. |
| `gmail_send` | **write** | Sends a new message to an address you name. |
| `gmail_archive` | **write** | Removes the `INBOX` label. Reversible — the message stays in All Mail. Needs `gmail.modify`. |
| `gmail_mark_read` | **write** | Removes the `UNREAD` label. Needs `gmail.modify`. |

There is deliberately **no delete tool**. `gmail.modify` would allow moving mail to Trash;
archiving is reversible and deleting is a different promise, and an agent acting on mail it has
just read should not be one prompt injection away from emptying an inbox.

`find_confirmation_link` is separate and stays a built-in: it is granted only by the per-agent
email permission and is never creator-selectable, so a creator cannot grant a read of the owner's
mailbox by declaration.

Every direct invocation of a Gmail tool through `POST /v1/instances/:id/tools/:name` (including via
MCP `call_instance_tool`) writes one `agent_events` row visible in `GET /v1/instances/:id/trace`
and the MCP `agent_trace` tool — carrying the tool name, success/failure, argument key names and a
byte count, but never argument values or result content (#726).

### Three gates on a send

Sending mail is the most irreversible thing an agent here can do — it leaves under the owner's own
name, to a real person, and cannot be recalled. So it passes three independent gates:

1. **The owner's email permission** on that agent (Settings → Permissions & Connections). Checked
   by *every* Gmail tool at call time, reads included.
2. **The agent's `capabilities.tools`** allowlist, like any connector tool.
3. **Per-instance write consent** (#90), which applies because the connector declares
   `scopes.write` — derived from its tools, not hand-written.

### A reply's recipient is not the agent's choice

`gmail_reply` addresses the reply to the parent message's sender and **cannot be overridden**. An
agent that has just read untrusted mail is exactly the one whose "who should this go to" answer
cannot be trusted; a prompt-injected reply-to would be a silent exfiltration channel out of the
owner's own mailbox. Use `gmail_send` when a different recipient is genuinely wanted — there the
address is explicit and auditable.

### Connections made before sending existed

A Gmail connection made before #713 holds `gmail.readonly` alone. Its refresh token keeps working
and keeps minting access tokens, so **nothing looks broken** until a send is refused by Google
with "insufficient authentication scopes".

The platform records what each grant was actually authorised for, so it can say this in advance
rather than discovering it mid-task:

- `GET /v1/email/status` reports `canSend`.
- `GET /v1/connectors` reports `grantedScopes` and `missingScopes` for every OAuth connector.
  `missingScopes: null` means the grant predates recording — which is *not* the same as nothing
  being missing, and is rendered as a shortfall rather than as completeness.
- The console shows such a row as **"connected — read-only, reconnect to allow sending"**.
- `gmail_reply` / `gmail_send` refuse before the API call, naming the reconnect.

Reconnecting re-prompts Google for consent, so the new scope is actually granted rather than the
old grant being silently returned.

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
