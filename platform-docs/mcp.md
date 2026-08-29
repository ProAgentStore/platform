# ProAgentStore MCP

ProAgentStore is MCP-first. Agents should operate account state through the official MCP server instead of scraping the UI or calling private APIs directly.

Remote MCP endpoint:

```text
https://mcp.proagentstore.online/mcp
```

Human and AI docs:

```text
https://proagentstore.online/docs/mcp/
https://proagentstore.online/llms.txt
https://proagentstore.online/.well-known/mcp-server.json
```

In-repo references, kept next to the code they describe:

- [`workers/mcp/README.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/README.md)
  — every tool, by category, with its scope, `dry_run` support, and `confirm` value.
- [`workers/mcp/AGENTS.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/AGENTS.md)
  — the behavioural contract for a calling agent: rules, workflow recipes, and what is
  deliberately not available.
- [`workers/mcp/CLAUDE.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/CLAUDE.md)
  — for work inside the worker itself: bindings, code layout, how to add a tool.

## Use It Now

Codex:

```bash
codex mcp add proagentstore --url https://mcp.proagentstore.online/mcp
codex mcp list
# If the server shows "Not logged in":
codex mcp login proagentstore
```

Claude Code:

```bash
claude mcp add --transport http proagentstore https://mcp.proagentstore.online/mcp
claude mcp list
```

Generic MCP client:

```bash
npx mcp-remote https://mcp.proagentstore.online/mcp
```

First-party local `npx` proxy:

```bash
npx @proagentstore/cli mcp
```

## Project Config

Use `.mcp.json` for MCP clients that support project-local config:

```json
{
  "mcpServers": {
    "proagentstore": {
      "type": "streamable-http",
      "url": "https://mcp.proagentstore.online/mcp"
    }
  }
}
```

Use `.codex/config.toml` for Codex project-local config in trusted repos:

```toml
[mcp_servers.proagentstore]
url = "https://mcp.proagentstore.online/mcp"
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

For stdio-only MCP clients, use the published CLI as the local proxy:

```json
{
  "mcpServers": {
    "proagentstore": {
      "command": "npx",
      "args": ["-y", "@proagentstore/cli", "mcp"]
    }
  }
}
```

## Agent Rules

```md
Use ProAgentStore only through the configured MCP server.

Do not use the web UI.
Do not call REST/GraphQL/private APIs directly.
First inspect available MCP tools/resources.
Prefer read-only tools unless the task explicitly requires changes.
Confirm before destructive actions.
```

## What `initialize` Answers

- `serverInfo.version`: `0.1.15`

That is the same value the published MCP-registry manifest (`server.json`) carries, and both
are read from one constant — `MCP_SERVER_VERSION` in `workers/mcp/src/server-version.ts` —
because two hand-typed literals had never agreed. It moves when the **served surface**
changes: the set of registered tool names, a tool's input schema, its annotations, which
tools declare an `outputSchema`, or the `instructions` below. It deliberately does not move
for a reworded tool description or a change inside a handler. The constant's own comment is
the full rule, and `pnpm docs:drift` fails if these three statements of it disagree.

Alongside `serverInfo`, the server returns an `instructions` string. MCP sends it once, at
`initialize`, and a host presents it to the model beside every tool's own description — so it
is where guidance that applies **across** tools belongs, rather than being repeated into 135
descriptions.

ProAgentStore's says three things, in this order, because the first 512 characters are the
part a host is most likely to keep:

1. **Get an id first.** Almost every tool acts on one agent instance. `my_instances` lists
   the ones you already run; `list_agents` is the public catalogue and `subscribe_agent`
   creates an instance from it.
2. **Debug with `agent_trace` first**, then `instance_messages` or `list_errors` for detail;
   `usage_summary` reports spend.
3. **The annotations are accurate**, a state-changing tool takes `dry_run`, and the
   `confirm` + `destructive`-scope refusals below are real and cannot be argued past.

The string itself is `SERVER_INSTRUCTIONS` in `workers/mcp/src/tool-metadata.ts`. A client
that ignores it loses nothing but the ordering; nothing here is enforcement.

## Auth

Two authentication paths resolve to the same ProAgentStore session:

- **OAuth 2.1 + PKCE** (default). The client discovers `/authorize` and `/token`, and may
  register dynamically at `/register`. PKCE `S256` is mandatory — a request without a
  `code_challenge` is rejected, and plain PKCE is disabled. The consent page delegates to
  ProAgentStore's own GitHub or Google sign-in, and the callback is bound to the browser
  that started the flow. Access tokens live 24 hours.
- **A per-call `token` argument**. Every authenticated tool accepts an optional PAGS
  session token. This bypasses the OAuth grant, so it carries no scope set — the default
  grant applies. It **is** audited: the token is a signed session, and the audit subject is
  the `uid` inside it, so a scripted mutation appears in `mcp_audit_log` exactly as an OAuth
  one does. (Until #702 it did not: supplying `token` erased the subject and the call wrote
  no row at all, mutating or not.) Prefer OAuth unless you are scripting.

## Auth Scopes And Safety

OAuth connections can be scoped to:

- `read`
- `write`
- `runtime`
- `destructive`

If a client does not request a ProAgentStore-specific scope, or only requests standard OAuth/OIDC scopes such as `openid email profile`, ProAgentStore grants the default set `read write runtime`. **`destructive` is never granted by default**, so delete- and overwrite-style tools cannot run on a plain browser sign-in. Use `read` only for inspection agents. Set `MCP_READ_ONLY=1` on the MCP worker to force server-wide read-only mode — every non-`read` scope assertion is then denied regardless of the grant.

Mutating tools support `dry_run: true` where useful. It returns the call that would have been made (`{dryRun, tool, action, wouldDo}`), is audited, and changes nothing. The dry-run branch runs after the permission check, so a dry run of a tool you lack scope for still denies.

Destructive or overwrite-style tools require an exact `confirm` value. By convention the value is the tool's own name; `remove_repo` is the exception:

- `write_agent_file`: `confirm: "write_agent_file"`
- `batch_write_agent_files`: `confirm: "batch_write_agent_files"`
- `unregister_instance_runtime`: `confirm: "unregister_instance_runtime"`
- `cancel_instance_task`: `confirm: "cancel_instance_task"`
- `cancel_instance`: `confirm: "cancel_instance"`
- `delete_instance_knowledge`: `confirm: "delete_instance_knowledge"`
- `delete_instance_memory`: `confirm: "delete_instance_memory"`
- `delete_instance_file`: `confirm: "delete_instance_file"`
- `delete_instance_trigger`: `confirm: "delete_instance_trigger"`
- `clear_instance_messages`: `confirm: "clear_instance_messages"`
- `delete_instance_connector_grant`: `confirm: "delete_instance_connector_grant"`
- `delete_supervision`: `confirm: "delete_supervision"`
- `remove_repo`: `confirm: "remove_all_repos"`, and only when removing **all** indexed repos

### Tool annotations

`tools/list` publishes an `annotations` object on every tool. It is the one safety signal a
host reads **before** it calls anything — scopes, `dry_run` and `confirm` all speak at call
time, and by then the host has already decided whether to ask the user.

| Hint | Published | What it means here |
|---|---|---|
| `readOnlyHint` | declared | `true` on a tool that only reads. `false` on everything else. |
| `destructiveHint` | declared | `true` on a tool that may perform a destructive update — every `runtime` and `destructive` tool. `false` on reads and on additive writes. |
| `idempotentHint` | omitted | ProAgentStore has no notion of idempotency to report, so any value would be a guess. |
| `openWorldHint` | omitted | There is no per-tool record of which tools reach an external system. |

The two published hints are **derived, not hand-maintained per tool**.
`workers/mcp/src/tool-metadata.ts` classifies every tool `read` / `write` / `runtime` /
`destructive` in one table, and `annotationsFor()` maps that classification onto the two
hints. The classification is then derived **back out of the handlers** by `index.test.ts`,
which drives all 145 tools under two different scope sets and reads the required scope out
of each refusal — so a tool announced read-only that enforces a write gate fails the build
rather than reaching a host. `conformance.test.ts` asserts the same thing against a real
`tools/list` response.

Both spec defaults for the omitted pair (`idempotentHint` false, `openWorldHint` true) err
on the cautious side, so leaving them out costs a host nothing. Declaring a guess would cost
it exactly what the annotations are for.

Use `mcp_audit_log` to inspect recent MCP write, runtime, dry-run, denied, and destructive tool events for the authenticated account. Audit events are redacted before storage — both by key name (`token`, `secret`, `password`, `credential`, `api_key`, …) and by value shape (`sk-…`, `ghp_…`, `xox…`, `AIza…`, JWTs, bearer headers) — and expire after 90 days.

**It is a call ledger, not a transcript.** An event records what a call carried — argument key names, byte counts, status — and the id of the record that holds the content (`traceId`, `session_id`, `runId`), never the content itself: no message text, no file contents, no argument values, no response body. Any string longer than an identifier is stored as a byte count under a `…Bytes` key. That applies to refused and dry-run calls exactly as it does to completed ones; until #701 those two paths stored the caller's whole payload verbatim, so the log kept the file it declined to write and four bytes for the one it wrote. To read what was actually sent, follow the id: `traceId` joins an audited `chat_with_instance` to its rows in `GET /v1/instances/:id/messages` and to the `chat.in`/`chat.out` pair in `agent_trace`, which also carry `origin: "mcp"` so an MCP turn is distinguishable from a console one. The rule and its reasoning are ADR 0004.

The same events are readable over HTTP at `GET /v1/mcp-audit` (`?limit=`, max 200; `?tool=`), scoped to the calling account and needing no MCP connection — which matters precisely when the MCP connection is the thing that broke. The console surfaces it under **Profile → MCP activity**.

## Result And Error Shape

Every tool returns a text content block. Two tools **also** return `structuredContent`,
because they declare an `outputSchema` — MCP pairs the two, and the pinned SDK enforces the
pair, so a declared schema is a binding contract rather than a hint:

- `list_agents`: `structuredContent: {"agents": […]}`
- `my_instances`: `structuredContent: {"instances": […]}`

The payload is an **object with a named key, not a bare array** — `my_instances` returned a
bare array before this was declared, and that is a consumer-visible change. The same JSON
stays in the text block, so a client that reads only `content` is unaffected. Every field
inside is optional and the objects passthrough, so a field added or renamed in the platform
API cannot fail a call: the schema says what a caller may rely on finding, not everything it
will receive.

Only these two declare a schema, and the restraint is deliberate. Their whole content is the
identifier the next call needs (`agent_info`, `subscribe_agent`, and every instance tool take
it). A tool that returns a one-line acknowledgement gains nothing from a schema and takes on
the obligation anyway — and the obligation is real: a tool that declares a schema and returns
no structured result has its call **rejected**, so a schema that drifts from what the platform
API returns does not degrade an answer, it removes one.

A refusal on a schema-carrying tool — not signed in, denied scope, a suspended operator —
comes back as `structuredContent: {"error": "…"}`, so it is still an answer rather than a
protocol error.

This server does **not** set `isError`. A failure is one of:

- text beginning `Error: ` — authentication required, a denied scope, a missing
  confirmation, or an upstream error message;
- JSON text carrying an `error` key — any non-2xx from the platform API is converted to
  `{"error": "API <status>", …}` rather than being allowed to pass as a result.

Check for both. A permission denial is a configuration fact, not a transient failure:
retrying returns the identical message and writes another audit row.

## Correct Runtime Flows

Public trial preview:

```text
list_agents -> chat_with_agent
```

Private instance runtime:

```text
list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance -> instance_messages
```

Private instance triggers:

```text
my_instances -> list_instance_triggers -> create_instance_trigger -> run_instance_trigger -> list_instance_trigger_events
```

Use `create_instance_trigger` with action `sync_connector` and config
`provider` plus `grant_id` to schedule Google Drive or Zoho WorkDrive folder
syncs for an already-granted folder.

Browser-capable instance runtime:

```text
subscribe_agent -> register_instance_runtime -> instance_runtime_status -> run_instance_task -> approve_instance_task -> instance_task_events
```

Repo Chat — index a repository, then ask about the code:

```text
subscribe_agent -> ingest_repo -> ingest_repo_status (poll to done) -> chat_with_instance
```

Debug a wrong answer:

```text
agent_trace -> vector_stats -> search_instance_knowledge -> list_errors
```

`agent_trace` first: it interleaves chat turns, tool calls, apply steps, and failures in
time order, which separates "never retrieved the fact" from "retrieved it and reasoned
badly" from "the tool call failed".

Review what another agent did, and question it:

```text
instance_board -> ticket_thread (what was already asked) -> ask_ticket
```

`ask_ticket` is how one agent reviews another's work. The answer is built from THAT
ticket's record alone — its reasoning, its declared action, its logged activity — by a
model call with no tools, so the same question on two tickets gets two answers and an
unrecorded detail comes back as "that isn't recorded" rather than a plausible
reconstruction. Report that verbatim; a confabulated answer here is worse than no thread,
because it is read as the audit trail.

It explains, it never acts. Neither tool can start, change, approve or run anything, so
the approval gate keeps no free-text bypass — running a ticket's declared work is still
`approve_instance_task` / `run_instance_task`.

Safely attempt a destructive operation:

```text
<tool> with dry_run: true -> inspect wouldDo -> <tool> with the exact confirm value -> mcp_audit_log
```

More recipes, with real argument names, are in
[`workers/mcp/AGENTS.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/AGENTS.md).

## Tool Surface

The server registers **145 tools**. 124 are always present. The remaining 21 are gated to
the console surfaces of the connected user's own subscribed agents, so the surface is
per-connection:

| Surface | Gated tools |
|---|---|
| `apply` | `upload_resume`, `apply_to_job`, `get_profile`, `get_apply_tips` |
| `repo` | `ingest_repo`, `ingest_repo_status`, `remove_repo` |
| `coding` | `system_status`, `coding_diagnostics`, `coding_repos_list`, `coding_repo_add`, `coding_sessions_list`, `coding_session_open`, `coding_session_capture`, `coding_session_message`, `coding_session_restart`, `coding_session_end`, `coding_session_fresh`, `coding_overseer`, `coding_timeline`, `coding_terminal` |

A Repo Chat user therefore never sees `apply_to_job`. Call `tools/list` and read what is
actually there rather than assuming a tool exists; the surface is versioned and will
change. The full table — every tool with its scope, `dry_run` support, and `confirm`
value — is in
[`workers/mcp/README.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/README.md).

## Capabilities

Read:

- agents
- private instances
- messages
- knowledge
- deployment status
- analytics
- runtime status
- task events
- MCP audit log

Write:

- create/update agents
- scaffold repositories
- write agent files
- subscribe to agents
- add instance knowledge
- register runtimes
- create, approve, and cancel runtime tasks

## Not Supported

Deliberate exclusions. There is no tool for any of these — an agent that knows this stops
looking and tells the user which console screen to use instead.

<!-- BEGIN generated: mcp-exclusions (scripts/check-mcp-parity.mjs --write) -->

<!-- Generated from EXCLUSIONS in scripts/check-mcp-parity.mjs. Do not edit by hand: the
     check regenerates this block and fails when it drifts. -->

| Not available via MCP | Why | Enforced by |
|---|---|---|
| The credentials vault — site logins, passwords, PINs, recovery codes | Secrets. Console → Knowledge → Credentials. | `check-mcp-parity.mjs` |
| API-key **values** | `keys_status` returns provider names only. There is no reveal tool and no route that returns a stored key, and there is no tool that WRITES one either — a key sent through a tool call is a secret in a transcript. Gmail refresh tokens are never revealable at all. | `check-mcp-parity.mjs` |
| Credentials for an outbound MCP server | Same rule as the vault, on the newer surface: the console stores the bearer or OAuth secret an instance uses to reach someone else's MCP server, and it is never read back or written over MCP. `list_instance_tools` reports whether a connection HAS one. | `check-mcp-parity.mjs` |
| Browser sign-in and account-link redirects | An OAuth start returns a URL for a human to open in a browser with cookies. A headless caller cannot complete one, so returning the URL would be an invitation to a dead end. | `check-mcp-parity.mjs` |
| Web Push subscription plumbing | A push subscription is a browser object (a VAPID key and an endpoint minted by the user's own browser). There is nothing for a server-side caller to subscribe WITH. | `check-mcp-parity.mjs` |
| Permission writes on instance state | `get_instance_state` is read-only for the permission block; toggles stay in the console. The one carve-out is `set_instance_model`, which writes the `model` field and nothing else. | — |
| Stripe checkout and the customer portal | Browser redirects — a redirect URL is useless to a headless caller. `billing_status` reads; nothing writes. | — |
| Binary routes — voice-audio, R2 multipart upload parts, file byte download | MCP results are text. `list_instance_files` and `delete_instance_file` exist; reading the bytes does not. `upload_agent_file` takes text only; `upload_resume` is the single binary path, and is apply-scoped. | — |
| Arbitrary shell execution, or a generic API proxy | No shell tool, no open proxy. `call_instance_tool` reaches only the connector tools an instance declares and its owner has left enabled. | — |
| The MCP audit log over HTTP | MCP already reads these events, through `mcp_audit_log`. `GET /v1/mcp-audit` (#704) is the console's path to the SAME KV, and its whole reason to exist is that it needs no MCP connection — when the MCP connection is what broke, a tool that wraps it answers nothing. A second tool over the same bytes would add a surface, not a capability. | `check-mcp-parity.mjs` |
| User deletion | Not modelled. | — |
| Another user's data | Every instance route is owner-scoped server-side. `list_errors` with `scope: "all"` is the only cross-user read and is admin-only. | — |

A row with no enforcer is a statement about the surface rather than a rule about routes —
there is no console call for the check to compare it against. The rows that name the check
are compared, every run, to what the console actually calls.

<!-- END generated: mcp-exclusions -->

**Not everything missing from MCP is on that list.** The console and this server are two clients
of one API, so a capability the console has is structurally available here; where it is absent it
is either the decision above or an accident. `scripts/check-mcp-parity.mjs` measures both, states
how many console capabilities are reachable, and fails when a new one appears in neither list. The
gaps it records today are exactly that — recorded, not accepted.

## Security

- OAuth/browser sign-in is the default auth path.
- OAuth scopes are enforced server-side for write, runtime, and destructive tools.
- Tools are purpose-specific; there is no generic shell or arbitrary API proxy tool.
- Mutating tools support dry-run previews where useful.
- Destructive and repository overwrite tools require explicit confirmation.
- MCP audit events are stored for every authenticated caller — an OAuth session or a
  per-call `token` argument alike — redacted by key name and by value shape, and expire
  after 90 days. Read tools are not recorded; the log covers write, runtime, dry-run,
  denied and destructive calls.
- Browser actions are task-based and can require explicit approval.
- Private instance runtime uses caller-owned AI credentials.
- Connector tools are gated twice: the instance must declare the tool, and its owner must
  not have switched it off. `list_instance_tools` returns that verdict per tool, so it is
  also how you audit what an agent can reach. It covers the agent's **built-in** tools
  (memory, tasks, board, `fetch_url`, knowledge, files, collections) as well as its
  connector tools, each carrying `tier` and `invocableBy` — a built-in reports
  `["chat"]`, meaning the agent runs it in conversation and `call_instance_tool` cannot
  reach it. To audit what an agent can REACH, read `reach` — `platform` (never leaves
  ProAgentStore), `machine` (the owner's computer) or `internet` (anywhere else). Do
  **not** filter on `connector` for this: it is wrong in both directions and was measured
  so (#584) — `fetch_url` names no connector and reaches the internet, while every
  `supervision` tool names one and never leaves the platform.
- Prefer read-only tools unless the user explicitly requests changes.

The scope, read-only, confirmation, dry-run, audit, and redaction logic all live in one
module — `workers/mcp/src/safety.ts` — which is the reference implementation other OFO
stores vendor.
