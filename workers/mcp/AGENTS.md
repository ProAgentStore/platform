# AGENTS.md — ProAgentStore MCP

The behavioural contract for an AI agent calling the ProAgentStore MCP server.

Endpoint: `https://mcp.proagentstore.online/mcp`.
Connection methods and the full tool table: [`README.md`](./README.md).

## Rules

1. **Use MCP, not the UI or the REST API.** Every account action has a tool. Do not
   scrape `proagentstore.online`, and do not call `api.proagentstore.online` directly
   unless the user explicitly overrides this.

2. **Discover the surface before using it.** The tool list is versioned and
   *per-connection*: of the 146 tool registrations, 22 are gated to the console surfaces
   of the agents the connected user actually subscribes to (`apply`, `repo`, `coding`). A
   tool you used last week may be absent today, and a tool present for one user is absent
   for another. Call `tools/list` first; never assume a name exists.

   Both numbers above are phrased to be machine-checked — `docs-drift` reads "N tool
   registrations" and "N are gated" against `src/tool-count.ts`. This sentence said "18 of
   the 124" for months *while the gate swept this file*, because the old wording put words
   between the number and "are gated" and matched nothing (#602, #603). Keep the shape.

3. **Detect failure structurally, not by reading prose — but know the shape.** This
   server does **not** set `isError` on results. Every tool returns a single text content
   block. A failure looks like one of two things:
   - text beginning `Error: ` — auth required, denied scope, missing confirmation, or an
     upstream error message;
   - JSON text with an `error` key — the HTTP layer converts any non-2xx into
     `{"error": "API <status>", ...}` and most tools pass that straight through.

   Check for both. Treat anything else as success.

   Two tools are the exception to "a single text block", and their shape is a contract a
   client may build against: `list_agents` returns `{"agents": [...]}` and `my_instances`
   returns `{"instances": [...]}` — **objects, not bare arrays**. Both declare an
   `outputSchema` and answer with `structuredContent` on every path, including refusals
   (where the payload is `{"error": …}`). Every field is optional, so a field added
   server-side cannot break your call.

   Results are serialised **compactly**. Do not parse by eye or by line offset.

4. **A permission denial is a stop, not a retry.** `requirePermission` returns
   `Error: <tool> requires <scope> permission, but MCP is in read-only mode.` or
   `Error: <tool> requires MCP scope "<scope>". …`. Both are configuration facts —
   `MCP_READ_ONLY=1` on the server, or a grant without that scope. Retrying produces the
   identical denial and another audit row. Report it to the user and stop.

5. **Prefer `dry_run: true` before an uncertain mutation.** It returns
   `{"dryRun": true, "tool", "action", "wouldDo"}` describing the call it would make —
   endpoint, method, body, byte counts. It is audited but changes nothing. `dry_run` is
   checked *after* the scope check, so a dry run of a tool you lack scope for still
   denies.

6. **`destructive` is not in the default grant.** A plain browser sign-in gets
   `read write runtime`. Delete- and overwrite-style tools will deny until the client
   requests `destructive` explicitly at authorization time. Do not attempt to work
   around this by finding another tool.

7. **Confirmation strings are exact and are the tool's own name** (with one exception).
   `confirm` is compared with `===`; there is no fuzzy match, and the string is never
   the user's words. The full list is below.

8. **Never put secrets in tool arguments.** The audit log redacts keys matching
   `token|secret|password|credential|authorization|api_key|…` and values shaped like
   `sk-…`, `ghp_…`, `xox…`, `AIza…`, JWTs and bearer headers — but redaction is a
   backstop, not a channel. There is no tool that needs a third-party secret; keys live
   in the account vault and are injected server-side.

9. **Connector writes are gated per instance.** `call_instance_tool` is a generic
   invoker, so it is scope-checked as `write` even when the underlying connector tool
   reads. The instance's own write-consent gate applies on top. Call
   `list_instance_tools` first: it returns every tool the instance could run — built-in
   facilities as well as connector tools — with this instance's verdict (`allowed`,
   `scope`, `mutates`, `reach`, `disabled`, `reason`, `tier`, `invocableBy`).

   Read `mutates`, not `scope`, to answer "does this change anything": `scope` is what
   triggers the write-consent gate, and the two are different questions. Read `reach`
   (`platform` / `machine` / `internet`) to answer "does this touch anything outside the
   platform" — do NOT infer it from whether a tool names a connector, which is wrong in
   both directions (`fetch_url` reaches the internet with no connector; every `supervision`
   tool names one and never leaves the platform). `tier` has four values — `base`,
   `standard`, `runtime`, `connector`. A tool absent from the allowed
   set cannot be invoked — by chat or by MCP. `invocableBy` says which of the two: a
   built-in tool reports `["chat"]` and is not reachable through `call_instance_tool` at
   all. Before #525 the listing covered only the registry while claiming to answer for
   the agent, so eleven universal tools — six of them writes — were invisible to an
   audit that was told it could establish an agent is read-only.

10. **Instance state is the user's, not the template's.** Writing to an instance never
    touches the creator's agent, and reading a creator's agent tells you nothing about a
    subscriber's data. Pick the agent-scoped or instance-scoped tool deliberately.

11. **`chat_with_agent` is a preview, not the runtime.** It hits the public trial
    endpoint and is capped. Real work goes through `subscribe_agent` →
    `chat_with_instance`.

12. **Everything you do is audited.** Writes, runtime calls, dry runs, and denials are
    written to KV under the OAuth subject for 90 days. `mcp_audit_log` reads them back.
    Note that audit only records when connected via OAuth — a per-call `token` argument
    carries no subject, so it writes no audit rows and no scope set.

13. **Read the annotations and the server `instructions` before reading descriptions.**
    Every tool publishes `readOnlyHint` / `destructiveHint`, and they are accurate:
    `readOnlyHint: true` means it only reads. `destructiveHint: true` reads "MAY perform
    destructive updates", and every such tool additionally demands an exact `confirm`
    string and a connection holding `destructive`. The server sends an `instructions`
    block on `initialize`; it is maintained alongside the tool surface, so prefer it to
    assumptions carried in from another MCP server.

14. **Report a run's state in the platform's words, not your own.** `health` has four
    values — `working`, `waiting`, `stalled`, `ended` — and `ended` is returned for any run
    that is not `running`, so it is the usual answer from `check_instance_loop`. `ended`
    makes no claim that anything is running. Do not derive a verdict from `status` or from
    timestamps: `lastAliveAt` is a heartbeat and `lastProgressAt` is the last instruction
    advance, and a healthy long step looks stale on the second while fresh on the first —
    inferring "stuck" from that has told an owner their work was dead mid-edit. A parked
    run carries `waitingReason`; it carries `waitingUntil` only when a resume time is
    knowable, and a run waiting on a *person* has none.

## Scopes

| Scope | Covers |
|---|---|
| `read` | Explicit read assertions (`mcp_audit_log`, the instance collection reads, trigger reads, `check_instance_loop`, supervision/connection lists). Most other reads are gated only by having a valid session. |
| `write` | Creating and updating agents, knowledge, memory, settings, board config, grants, repos, connections, supervision. |
| `runtime` | Spending or driving something: instance chat, runtime task create/approve, running a trigger, deploy dispatch, coding session drive, `apply_to_job` without submit. |
| `destructive` | Deleting, cancelling, overwriting, or committing an irreversible external action. **Not granted by default.** |

Default grant when no (valid) ProAgentStore scope is requested, including for standard
OIDC scopes like `openid email profile`: `read write runtime`.

`MCP_READ_ONLY=1` on the Worker denies every non-`read` assertion regardless of grant.

## Tools requiring `confirm`

| Tool | `confirm` value | When |
|---|---|---|
| `write_agent_file` | `write_agent_file` | always |
| `batch_write_agent_files` | `batch_write_agent_files` | always |
| `unregister_instance_runtime` | `unregister_instance_runtime` | always |
| `cancel_instance_task` | `cancel_instance_task` | always |
| `cancel_instance` | `cancel_instance` | always |
| `delete_instance_knowledge` | `delete_instance_knowledge` | always |
| `delete_instance_memory` | `delete_instance_memory` | always |
| `delete_instance_file` | `delete_instance_file` | always |
| `delete_instance_trigger` | `delete_instance_trigger` | always |
| `clear_instance_messages` | `clear_instance_messages` | always |
| `delete_instance_connector_grant` | `delete_instance_connector_grant` | always |
| `delete_supervision` | `delete_supervision` | always |
| `remove_repo` | `remove_all_repos` | only when removing **all** repos (omit `repo_url`) |

A `dry_run` never needs `confirm` — `remove_repo` checks confirmation only on a real run.

## Workflow recipes

Argument names below are the real ones. Omit `token` when connected over OAuth.

### 1. Subscribe and hold a grounded conversation about your own documents

```text
list_agents
subscribe_agent            { agent_id: "<slug or id>" }        → instance_id
add_instance_knowledge     { instance_id, title, content }
vector_stats               { instance_id }                     # confirm chunks landed
search_instance_knowledge  { instance_id, query, top_k: 5 }    # confirm retrievability
chat_with_instance         { instance_id, message }
instance_messages          { instance_id }
```

Verify with `vector_stats` before chatting. Embedding is asynchronous; a document that
is listed by `list_instance_knowledge` is not necessarily searchable yet, and an empty
vector store is the usual cause of "the agent ignored my file".

### 2. Debug a wrong answer

```text
agent_trace               { instance_id, limit: 200 }          # what actually happened, in order
agent_trace               { instance_id, trace_id: "<turn>" }  # narrow to one turn
vector_stats              { instance_id }                      # is the source indexed at all?
search_instance_knowledge { instance_id, query: "<the fact it got wrong>" }
list_errors               { source: "<subsystem>", limit: 50 } # persisted failures
```

`agent_trace` first, always: it interleaves `chat.in` / `tool.call` / `chat.out` with
apply steps and errors, so it distinguishes "never retrieved the fact" from "retrieved
it and reasoned badly" from "the tool call failed". `vector_stats` +
`search_instance_knowledge` diagnose the first; `list_errors` the third.

### 3. Point Repo Chat at a repo and ask about the code

```text
subscribe_agent    { agent_id: "repo-chat" }                   → instance_id
ingest_repo        { instance_id, repo_url: "owner/repo" }
ingest_repo_status { instance_id }                             # poll: fetching → indexing → summarizing → done
chat_with_instance { instance_id, message: "How does X work?" }
```

Poll `ingest_repo_status` until every repo reports `done` — ingestion advances one repo
per alarm tick, so a large repo takes several. Call `ingest_repo` again with a different
`repo_url` to add another repo (max 20), or the same URL to re-index it.

Note the surface gate: `ingest_repo` only appears once you have a `surfaces: ["repo"]`
instance. If it is missing from `tools/list`, subscribe first and reconnect.

### 4. Drive a coding session

```text
my_instances                                                   → the coding instance_id
system_status          { instance_id }                         # is a runner connected?
coding_repo_add        { instance_id, path: "~/dev/my-repo" }
coding_sessions_list   { instance_id }                         → session_id
coding_session_message { instance_id, session_id, message: "run the tests" }
coding_session_capture { instance_id, session_id }             # poll the terminal
coding_session_restart { instance_id, session_id }             # if wedged
coding_session_end     { instance_id, session_id }
```

`system_status` first. Everything else needs a machine running `pags up`; with no runner
connected the drive tools fail rather than queue. If the CLI is stuck, prefer
`coding_session_restart` (same session id) over `coding_session_fresh` (clean state, no
`--resume`), which loses the engine's context.

### 5. Try a destructive operation safely

```text
list_instance_knowledge { instance_id }                        # find the document_id
delete_instance_knowledge { instance_id, document_id, dry_run: true }
# read the returned wouldDo, confirm it is the right target with the user, then:
delete_instance_knowledge { instance_id, document_id, confirm: "delete_instance_knowledge" }
mcp_audit_log { limit: 10 }                                    # verify what ran
```

Three independent gates, in this order: the `destructive` scope (absent from the default
grant), the exact `confirm` string, and the audit row. `dry_run` short-circuits before
the confirmation check, so the preview costs nothing.

### 6. Schedule recurring work on an instance

```text
list_instance_connector_grants { instance_id, provider: "google_drive" }   → grant id
create_instance_trigger { instance_id, name: "Nightly sync", type: "cron",
                          action: "sync_connector", schedule: "@daily",
                          config: { provider: "google_drive", grant_id: "<id>" },
                          dry_run: true }
create_instance_trigger { ...same, without dry_run }
run_instance_trigger    { instance_id, trigger_id }            # fire once to prove it
list_instance_trigger_events { instance_id, trigger_id }
```

The grant *is* the permission — an agent can only ever read a folder that appears in
`list_instance_connector_grants`. Create the grant before the trigger, or the trigger
fires and fails. `run_instance_trigger` is `runtime`-scoped because it really does the
work.

## Capabilities

| Capability | Tools |
|---|---|
| Discover the catalog | `list_agents`, `agent_info`, `platform_guide`, `sdk_reference` |
| Preview an agent | `chat_with_agent` (trial, capped) |
| Author an agent | `create_agent`, `update_agent`, `scaffold_agent`, `set_agent_settings_schema` |
| Manage an agent's repo | `list_agent_repo_files`, `read_agent_file`, `write_agent_file`, `batch_write_agent_files`, `agent_deploy_status`, `trigger_agent_deploy` |
| Run an agent for real | `subscribe_agent`, `chat_with_instance`, `start_instance_loop` |
| Feed it knowledge | `add_instance_knowledge`, `upload_agent_file`, `ingest_repo`, connector grants + `sync_connector` triggers |
| Verify retrieval | `vector_stats`, `search_instance_knowledge`, `list_instance_files` |
| Shape its behaviour | `set_instance_instructions`, `set_instance_settings`, `write_instance_memory`, `set_instance_model`, `set_instance_tool` |
| Structured data | `list_instance_collections`, `query_instance_records`, `insert_instance_record` |
| Work board | `instance_board`, `set_board_item_status`, `update_board_ticket`, `create_instance_ticket`, `run_instance_task`, `approve_instance_task` |
| Local runtime | `register_instance_runtime`, `instance_runtime_status`, coding session tools |
| Automate | `create_instance_trigger`, `run_instance_trigger`, `create_connection`, `create_supervision` |
| Observe | `agent_trace`, `list_errors`, `instance_activity`, `list_pipeline_runs`, `usage_summary`, `mcp_audit_log` |
| Account reads | `billing_status`, `keys_status`, `email_status`, `connector_status`, `get_profile` |

## Not supported via MCP

Deliberate exclusions. Verified against the code — there is no tool for any of these, so
stop looking and tell the user which console screen to use.

| Not available | Why | Do instead |
|---|---|---|
| **Credentials vault** (`/v1/instances/:id/credentials`, `/reveal`) — site logins, passwords, PINs, recovery codes | Secrets. No MCP tool references the route at all. | Console → Knowledge → Credentials |
| **API-key values** | `keys_status` returns provider *names* only; there is no `keys_reveal`, no proxy tool, and no route that returns a stored key | Console → Profile → API keys |
| **Gmail refresh token** | Never revealable to anything, including the console | — |
| **Permission writes** on instance state | `get_instance_state` is read-only and no tool writes `permissions`. Note the one carve-out: `set_instance_model` does `PUT /state`, but with `{model}` only | Console → Settings → Permissions & Connections |
| **Stripe checkout and customer portal** | Browser redirects — a redirect URL is useless to a headless caller. `billing_status` reads, nothing writes | Console → Profile → Billing |
| **Binary routes** — voice-audio get/put, R2 multipart upload parts, file byte download (`/files/:fileId`) | MCP results are text; streaming bytes through a text channel is not useful. `list_instance_files` and `delete_instance_file` exist; reading the bytes does not | Console, or the REST API directly |
| **Uploading a non-text file to an agent** | `upload_agent_file` takes text content only. `upload_resume` is the one binary path, and takes a public URL or base64, scoped to apply agents | — |
| **Arbitrary shell or a generic API proxy** | There is no shell tool and no open proxy. `call_instance_tool` reaches only the connector tools an instance declares and its owner has left enabled | Coding session tools, on a runner the user started |
| **User deletion** | Not modelled | Console |
| **Reading another user's data** | Every instance route is `user_id`/`owner_id`-scoped server-side. `list_errors` with `scope: "all"` is the only cross-user read, and is admin-only | — |

## Reference

- Safety module: `src/safety.ts` — `parseScopes`, `hasScope`, `requirePermission`,
  `requireConfirmation`, `dryRun`, `audit`, `listAuditEvents`, `redact`.
- Published doc: [`platform-docs/mcp.md`](../../platform-docs/mcp.md).
- Registry entry: [`server.json`](../../server.json).
