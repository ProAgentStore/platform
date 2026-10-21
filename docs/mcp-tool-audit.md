# MCP tool surface audit (#1241)

Audit of the platform-wide MCP surface served at `https://mcp.proagentstore.online/mcp`, as of
server **0.1.158** (build `846b8bad`, deployed 2026-10-19T23:38:47Z). It covers what an agent sees and
calls, how often it fails, what to keep, merge or remove, and the twenty worst offenders for an
agent trying to use the surface. The rules that come out of it are in
[`mcp-conventions.md`](./mcp-conventions.md).

**What is measured and what is not.** Every number below is labelled with where it came from:
code (exact), the audit ledger, or the error log. **Per-tool 90-day call and failure counts are NOT
in this document yet** (see [Gap](#gap-per-tool-90-day-counts)). Nothing here is estimated to fill
that gap. Usage-based removals wait for those numbers.

## 1. Summary

| | Count | Source |
|---|---:|---|
| Tools registered (all surfaces on) | **366** | `MCP_TOOL_COUNT`, held to a real registration run by `index.test.ts` |
| Always on | 339 | `MCP_TOOL_ALWAYS_ON` |
| Surface-gated | 27 (coding 20, apply 4, repo 3) | code: `groups.has(...)` |
| By scope | read 173 · write 114 · runtime 42 · destructive 37 | `tool-metadata.ts` `TOOL_RISK` |
| Descriptions under 20 words | 51 | real `tools/list` |
| Descriptions with no example call or value | 336 | real `tools/list` (`e.g.`, `example`, or an inline `{"…`) |
| Descriptions that name no sibling tool | 177 | real `tools/list` |
| Verified duplicate pairs (same API route) | 4 | code, §4 |

Largest groups by file: `applications.ts` 27, `runtime.ts` 23, `settings.ts` 23, `index.ts` 21,
`composition.ts` 19, `account.ts` 18, `observability.ts` 16, `agent-authoring.ts` 15, `board.ts` 15,
`storage-tools.ts` 15.

## 2. Method

- **Inventory**: every `.tool("<name>"` registration under `workers/mcp/src`, joined with the
  description and input schema from a real `tools/list` (a `PagsMcp` with all three surfaces
  gated on, over an in-memory client) and scope from `TOOL_RISK`. Exact.
- **Usage and failures**: the MCP audit ledger (`OAUTH_KV`, `audit_all:` keys, 90-day TTL). One
  event per tool call (#1089), with `action` = completed | dry_run | denied | failed | error |
  invalid_input | unknown. **Successful read-only calls are not written**, so for read tools the
  ledger counts failures, not use.
- **Recurring failures**: the D1 `error_log` via `error_summary` (30 days, all accounts).
- **Usability**: description length, whether it shows an example, and whether it names the
  sibling to use instead. These are proxies; the agent eval (§7) is the real measure.

## 3. Evidence

### 3.1 Audit ledger: sample, 2026-10-19 (about 30 minutes of traffic)

Read by paging `admin_mcp_audit` newest-first. A sample, not a rate.

- Writes are dominated by `coding_loop_start` (with `queue_if_busy`), `call_instance_tool`
  (→ `github_create_issue`, `github_list_issues`, `github_update_issue`, `github_comment_issue`),
  `answer_instance_input`, `coding_repo_add` / `coding_repo_remove`, `write_instance_memory`,
  `coding_session_message`, `coding_loop_stop`.
- Failures in the sample: two `coding_loop_start` `failed` with reason `api_409` (instance busy),
  one `invalid_input` / `unknown_tool`.
- `coding_repo_remove` events carried **both** `repo_id` and `repoId` keys: a camelCase alias
  that zod used to strip silently.

### 3.2 Audit ledger: `invalid_input`, last 90 days

Walking `admin_mcp_audit action:invalid_input since:2026-07-22` yields about one event per page
(the filter is applied per page of the time-ordered ledger), so a full 90-day walk is impractical
in a session. The newest two events:

| When | Tool | Reason | Note |
|---|---|---|---|
| 2026-10-20 (UTC 2026-10-19T23:41Z) | `admin_mcp_audit` | `invalid_arguments` | `summarize` sent as the string `"true"` by a client whose cached schema predated the parameter. Fixed in this batch (§6). |
| 2026-10-19T21:06Z | `(unregistered)` | `unknown_tool` | the ledger does not record the name that was tried; follow-up (§7). |

### 3.3 Error log (`error_summary`, 30 days, all accounts)

45,980 occurrences; the summary read the newest 5,000 rows (truncated, so shares below are of
that window).

- **About 40k are `commit-close-watch` noise**: no GitHub App installation for vibecodeqa/*,
  freemarketingstore-online, proagentstore-online, carsads and ChessClubs, plus 404s for
  chess-academy and serge-ivo/stores-workspace. Not an MCP usability problem, but it buries
  everything else in `list_errors`. Follow-up (§7).
- Usability signatures that reach MCP callers:
  - `"X" is not one of this agent's tools` (`workers/api/src/lib/tool-refusal.ts:42`), a 403
    reached through `call_instance_tool`: the caller guessed a tool the instance does not declare.
  - Handoff input/frame 409 and 503 behind `answer_instance_input`.
  - `This agent is not part of an application pipeline` (`lib/applications/control.ts:166`), a 409
    from the application decision tools called on a non-pipeline instance.
  - `This agent's machine is not connected` (`lib/actions-runner-provision.ts:137`), a 409.
  - "lead is now unverified" (409): the text is in the log, but it is **not** in `workers/api/src`
    verbatim, so the source is not mapped.

### Gap: per-tool 90-day counts

The instrument for these numbers shipped in this batch and is deployed (846b8bad):
`admin_mcp_audit` with `summarize: true` lists the ledger's KEYS only (`tool` and `action` live in
key metadata), tallies tool × action, and sorts by failures. It could not be read in the session
that wrote this document, because that client's cached tool schema predated the parameter (§3.2
row 1). To fill §5's count columns, from any client that re-reads `tools/list`:

```json
{"name": "admin_mcp_audit", "arguments": {"summarize": true, "since": "<now minus 90 days, ISO>"}}
```

Follow `nextCursor` until `complete: true`. Read tools appear only when they failed (§2).

**Filled 2026-10-20 (#1243).** The walk took 2 pages and ended `complete: true`: 22,752 events. Each one names the tool it
was a call to, and 137 different names appear. The `since` was 2026-07-22, but the ledger's oldest event is 2026-07-31, so the counts cover
about 80 days, every account. The counts are in §5's **Calls 90d** and **Failures 90d** columns. A
dry run counts as a call. A read tool's number is its failures and denials only.

## 4. Keep / merge / remove

**Remove: none yet.** Removing a tool on structural grounds alone would break callers this audit
cannot see. Removal candidates are tools with **zero** write and failure events in the 90-day
summary; decide them in the consolidation follow-up once §3's gap is filled.

**Merge: four verified pairs.** Each pair calls the same API route. Verified in code:

| Retire | Keep | Shared route | Note |
|---|---|---|---|
| `start_instance_loop` | `coding_loop_start` | `POST /v1/instances/:id/loop` | the survivor also queues (`queue_if_busy`) and returns a start receipt |
| `check_instance_loop` | `coding_loop_status` | `GET /v1/instances/:id/loop[/:run]` | |
| `stop_instance_loop` | `coding_loop_stop` | `POST …/loop/:run/cancel` | the survivor also resolves "the most recent run" |
| `system_status` | `coding_diagnostics` | `GET …/coding/diagnostics` | `system_status` adds `providerAccount` prose and still says "tmux sessions" (there is no tmux, #247) |

Note: the `coding_loop_*` names are misleading, because the loop is not coding-only. The survivor
may be better renamed. That is the consolidation ticket's call, since a rename is a breaking
surface change.

**Keep, but disambiguate.** These look duplicate but act on different things. Their descriptions
must say which, and name the sibling:

- template vs instance: `add_knowledge` / `add_instance_knowledge`, `list_knowledge` /
  `list_instance_knowledge`, `query_records` / `query_instance_records`, `insert_record` /
  `insert_instance_record`, `update_record` / `update_instance_record`, `list_collections` /
  `list_instance_collections`;
- three chats: `chat_with_agent` (public trial), `chat_with_my_agent` (your template, as creator),
  `chat_with_instance` (your subscription);
- three activity reads: `agent_activity` (template), `instance_activity` (one instance),
  `account_activity` (every instance, live health);
- errors: `error_summary` (what recurs) before `list_errors` (what happened);
- audit: `mcp_audit_log` (yours) and `admin_mcp_audit` (everyone's, admin).

## 5. Inventory

Every tool at 0.1.158. **Words** is the description length in the published `tools/list`. **Ex** means the
description shows an example. **Sib** means it names another tool.

**Calls 90d** and **Failures 90d** come from the ledger walk in §3 (#1243): every logged event for the
tool, and how many of them failed. A logged event means any outcome for a write tool, but only a failure
or denial for a read tool. So a write tool's 0 means it was not called in the window, while a read
tool's 0 means only that it never failed. The four deprecated aliases are marked; §5.1 lists the write
tools with no calls.

| Tool | File (`workers/mcp/src/`) | Scope | Gated | Words | Ex | Sib | Calls 90d | Failures 90d | Recommendation |
|---|---|---|---|---:|:-:|:-:|---:|---:|---|
| `coding_engine_get` | `coding-engine-tools.ts` | read | coding | 195 | — | y | 0 | 0 | keep |
| `coding_engine_set` | `coding-engine-tools.ts` | write | coding | 206 | y | y | 174 | 0 | keep |
| `coding_engine_reauth` | `coding-reauth-tools.ts` | runtime | coding | 173 | — | y | 31 | 4 | keep |
| `retarget_repository_binding` | `coding-retarget-tools.ts` | write | coding | 189 | — | y | 7 | 0 | keep |
| `coding_diagnostics` | `coding-tools.ts` | read | coding | 240 | — | y | 0 | 0 | keep — survivor of the diagnostics pair |
| `coding_instance_deploy_status` | `coding-tools.ts` | read | coding | 68 | — | y | 0 | 0 | keep |
| `coding_repo_add` | `coding-tools.ts` | write | coding | 373 | y | y | 222 | 30 | keep |
| `coding_repo_remove` | `coding-tools.ts` | destructive | coding | 171 | — | y | 96 | 0 | keep |
| `coding_repos_list` | `coding-tools.ts` | read | coding | 44 | — | y | 0 | 0 | keep |
| `coding_session_capture` | `coding-tools.ts` | read | coding | 315 | — | y | 0 | 0 | keep |
| `coding_session_end` | `coding-tools.ts` | runtime | coding | 22 | — | y | 22 | 0 | keep |
| `coding_session_fresh` | `coding-tools.ts` | runtime | coding | 40 | — | y | 64 | 0 | keep |
| `coding_session_message` | `coding-tools.ts` | runtime | coding | 178 | — | y | 500 | 0 | keep |
| `coding_session_open` | `coding-tools.ts` | runtime | coding | 83 | — | y | 17 | 0 | keep |
| `coding_session_restart` | `coding-tools.ts` | runtime | coding | 18 | — | — | 1 | 1 | keep — description under 20 words |
| `coding_sessions_list` | `coding-tools.ts` | read | coding | 10 | — | — | 0 | 0 | keep — description under 20 words |
| `add_knowledge` | `index.ts` | write | — | 8 | — | — | 1 | 0 | keep — description rewritten (top-20) |
| `agent_analytics` | `index.ts` | read | — | 6 | — | — | 0 | 0 | keep — description under 20 words |
| `agent_deploy_status` | `index.ts` | read | — | 11 | — | — | 0 | 0 | keep — description under 20 words |
| `agent_info` | `index.ts` | read | — | 45 | — | y | 0 | 0 | keep |
| `batch_write_agent_files` | `index.ts` | destructive | — | 11 | — | — | 1 | 0 | keep — description under 20 words |
| `chat_with_agent` | `index.ts` | runtime | — | 9 | — | — | 0 | 0 | keep — description rewritten (top-20) |
| `create_agent` | `index.ts` | write | — | 45 | — | y | 21 | 1 | keep |
| `get_agent_board_config` | `index.ts` | read | — | 10 | — | — | 0 | 0 | keep — description under 20 words |
| `list_agent_repo_files` | `index.ts` | read | — | 16 | — | y | 0 | 0 | keep — description under 20 words |
| `list_agents` | `index.ts` | read | — | 35 | — | y | 0 | 0 | keep |
| `list_knowledge` | `index.ts` | read | — | 7 | — | — | 0 | 0 | keep — description rewritten (top-20) |
| `mcp_audit_log` | `index.ts` | read | — | 156 | — | — | 0 | 0 | keep |
| `my_agents` | `index.ts` | read | — | 100 | — | y | 0 | 0 | keep |
| `platform_guide` | `index.ts` | read | — | 4 | — | — | 0 | 0 | keep — description rewritten (top-20) |
| `read_agent_file` | `index.ts` | read | — | 9 | — | — | 2 | 2 | keep — description under 20 words |
| `scaffold_agent` | `index.ts` | write | — | 23 | — | — | 6 | 1 | keep |
| `sdk_reference` | `index.ts` | read | — | 5 | y | — | 0 | 0 | keep — description rewritten (top-20) |
| `trigger_agent_deploy` | `index.ts` | runtime | — | 11 | — | — | 0 | 0 | keep — description under 20 words |
| `update_agent` | `index.ts` | write | — | 43 | y | — | 31 | 2 | keep |
| `update_agent_board_config` | `index.ts` | write | — | 15 | — | — | 0 | 0 | keep — description under 20 words |
| `write_agent_file` | `index.ts` | destructive | — | 11 | — | — | 1 | 0 | keep — description under 20 words |
| `apply_account_coding_default` | `instance-tools/account.ts` | runtime | — | 132 | — | y | 5 | 0 | keep |
| `billing_status` | `instance-tools/account.ts` | read | — | 24 | — | — | 0 | 0 | keep |
| `email_status` | `instance-tools/account.ts` | read | — | 14 | — | — | 0 | 0 | keep — description under 20 words |
| `get_account_preferences` | `instance-tools/account.ts` | read | — | 110 | — | y | 0 | 0 | keep |
| `get_budget_limits` | `instance-tools/account.ts` | read | — | 43 | — | y | 0 | 0 | keep |
| `get_creator_dashboard` | `instance-tools/account.ts` | read | — | 32 | — | — | 0 | 0 | keep |
| `get_usage_dashboard` | `instance-tools/account.ts` | read | — | 37 | — | y | 0 | 0 | keep |
| `keys_status` | `instance-tools/account.ts` | read | — | 25 | — | — | 0 | 0 | keep |
| `list_notifications` | `instance-tools/account.ts` | read | — | 78 | — | y | 0 | 0 | keep |
| `mark_all_notifications_read` | `instance-tools/account.ts` | write | — | 42 | — | y | 0 | 0 | keep |
| `mark_notification_read` | `instance-tools/account.ts` | write | — | 53 | — | y | 0 | 0 | keep |
| `platform_health` | `instance-tools/account.ts` | read | — | 156 | — | — | 0 | 0 | keep |
| `set_account_preferences` | `instance-tools/account.ts` | write | — | 166 | y | y | 2 | 0 | keep |
| `set_budget_limits` | `instance-tools/account.ts` | write | — | 87 | — | y | 0 | 0 | keep |
| `update_profile` | `instance-tools/account.ts` | write | — | 19 | — | y | 3 | 0 | keep — description under 20 words |
| `usage_drivers` | `instance-tools/account.ts` | read | — | 155 | y | y | 0 | 0 | keep |
| `usage_summary` | `instance-tools/account.ts` | read | — | 214 | — | — | 0 | 0 | keep |
| `whoami` | `instance-tools/account.ts` | read | — | 73 | — | y | 0 | 0 | keep |
| `agent_messages` | `instance-tools/agent-authoring.ts` | read | — | 45 | — | y | 0 | 0 | keep |
| `chat_with_my_agent` | `instance-tools/agent-authoring.ts` | destructive | — | 41 | — | y | 0 | 0 | keep |
| `create_agent_version` | `instance-tools/agent-authoring.ts` | destructive | — | 39 | — | — | 0 | 0 | keep |
| `delete_agent` | `instance-tools/agent-authoring.ts` | destructive | — | 52 | — | y | 0 | 0 | keep |
| `delete_agent_knowledge` | `instance-tools/agent-authoring.ts` | destructive | — | 41 | — | y | 0 | 0 | keep |
| `execute_agent_builder_plan` | `instance-tools/agent-authoring.ts` | destructive | — | 44 | — | — | 0 | 0 | keep |
| `export_agent` | `instance-tools/agent-authoring.ts` | read | — | 89 | — | y | 0 | 0 | keep |
| `get_agent_capabilities` | `instance-tools/agent-authoring.ts` | read | — | 103 | — | y | 0 | 0 | keep |
| `get_agent_memory` | `instance-tools/agent-authoring.ts` | read | — | 52 | — | y | 0 | 0 | keep |
| `get_agent_state` | `instance-tools/agent-authoring.ts` | read | — | 48 | — | y | 1 | 1 | keep |
| `my_agent` | `instance-tools/agent-authoring.ts` | read | — | 102 | — | y | 0 | 0 | keep |
| `plan_agent_builder` | `instance-tools/agent-authoring.ts` | read | — | 33 | — | y | 0 | 0 | keep |
| `rollback_agent_version` | `instance-tools/agent-authoring.ts` | destructive | — | 37 | — | y | 0 | 0 | keep |
| `set_agent_capabilities` | `instance-tools/agent-authoring.ts` | destructive | — | 49 | — | y | 6 | 0 | keep |
| `set_agent_state` | `instance-tools/agent-authoring.ts` | destructive | — | 39 | — | y | 0 | 0 | keep |
| `create_agent_task` | `instance-tools/agent-tasks.ts` | write | — | 97 | — | y | 8 | 0 | keep |
| `delete_agent_task` | `instance-tools/agent-tasks.ts` | destructive | — | 86 | — | y | 0 | 0 | keep |
| `list_agent_tasks` | `instance-tools/agent-tasks.ts` | read | — | 97 | — | y | 0 | 0 | keep |
| `update_agent_task` | `instance-tools/agent-tasks.ts` | write | — | 78 | — | — | 2 | 0 | keep |
| `application_handoff` | `instance-tools/applications.ts` | read | — | 49 | — | — | 0 | 0 | keep |
| `application_reconciliation` | `instance-tools/applications.ts` | read | — | 54 | — | — | 0 | 0 | keep |
| `application_run` | `instance-tools/applications.ts` | read | — | 165 | — | y | 2 | 2 | keep |
| `application_run_supervision` | `instance-tools/applications.ts` | read | — | 91 | — | — | 0 | 0 | keep |
| `application_runs` | `instance-tools/applications.ts` | read | — | 79 | — | y | 0 | 0 | keep |
| `application_trace` | `instance-tools/applications.ts` | read | — | 84 | — | — | 0 | 0 | keep |
| `approve_application` | `instance-tools/applications.ts` | destructive | — | 317 | — | y | 16 | 0 | keep |
| `assert_application_not_submitted` | `instance-tools/applications.ts` | write | — | 146 | y | y | 0 | 0 | keep |
| `cancel_application` | `instance-tools/applications.ts` | write | — | 24 | — | — | 3 | 0 | keep |
| `clear_application_tailor_uploaded_source` | `instance-tools/applications.ts` | write | — | 44 | — | — | 0 | 0 | keep |
| `create_application_handoff` | `instance-tools/applications.ts` | runtime | — | 60 | — | — | 2 | 1 | keep |
| `generate_application_materials` | `instance-tools/applications.ts` | runtime | — | 31 | — | — | 0 | 0 | keep |
| `get_application` | `instance-tools/applications.ts` | read | — | 56 | — | — | 0 | 0 | keep |
| `get_application_runner_settings` | `instance-tools/applications.ts` | read | — | 40 | — | — | 0 | 0 | keep |
| `get_application_tailor_uploaded_source_readiness` | `instance-tools/applications.ts` | read | — | 58 | — | — | 0 | 0 | keep |
| `get_application_tailor_uploaded_sources` | `instance-tools/applications.ts` | read | — | 45 | — | — | 0 | 0 | keep |
| `list_applications` | `instance-tools/applications.ts` | read | — | 152 | — | — | 3 | 3 | keep |
| `request_application_reconciliation` | `instance-tools/applications.ts` | runtime | — | 60 | — | — | 1 | 0 | keep |
| `request_application_review` | `instance-tools/applications.ts` | runtime | — | 24 | — | — | 5 | 0 | keep |
| `resume_application` | `instance-tools/applications.ts` | runtime | — | 59 | — | — | 1 | 0 | keep |
| `retry_application` | `instance-tools/applications.ts` | runtime | — | 104 | — | y | 47 | 0 | keep |
| `set_application_runner_settings` | `instance-tools/applications.ts` | write | — | 112 | — | — | 8 | 0 | keep |
| `set_application_tailor_uploaded_source` | `instance-tools/applications.ts` | write | — | 59 | — | y | 3 | 0 | keep |
| `start_application_fill` | `instance-tools/applications.ts` | runtime | — | 38 | — | y | 0 | 0 | keep |
| `tailoring_run` | `instance-tools/applications.ts` | read | — | 107 | — | — | 0 | 0 | keep |
| `transfer_prepared_application` | `instance-tools/applications.ts` | runtime | — | 61 | — | — | 2 | 0 | keep |
| `triage_application` | `instance-tools/applications.ts` | write | — | 89 | — | — | 24 | 0 | keep |
| `apply_to_job` | `instance-tools/apply.ts` | destructive | apply | 116 | y | — | 6 | 0 | keep |
| `get_apply_tips` | `instance-tools/apply.ts` | read | apply | 21 | — | — | 0 | 0 | keep |
| `get_profile` | `instance-tools/apply.ts` | read | apply | 39 | — | — | 0 | 0 | keep |
| `upload_resume` | `instance-tools/apply.ts` | write | apply | 57 | — | — | 0 | 0 | keep |
| `call_instance_tool` | `instance-tools/base.ts` | runtime | — | 104 | y | y | 14229 | 89 | keep — description rewritten (top-20) |
| `cancel_instance` | `instance-tools/base.ts` | destructive | — | 9 | — | — | 19 | 0 | keep — description under 20 words |
| `chat_with_instance` | `instance-tools/base.ts` | runtime | — | 20 | — | — | 357 | 0 | keep |
| `describe_instance` | `instance-tools/base.ts` | read | — | 75 | — | — | 0 | 0 | keep |
| `list_instance_tools` | `instance-tools/base.ts` | read | — | 476 | — | y | 0 | 0 | keep |
| `my_instances` | `instance-tools/base.ts` | read | — | 70 | — | y | 0 | 0 | keep |
| `pause_instance` | `instance-tools/base.ts` | write | — | 129 | — | y | 49 | 0 | keep |
| `resume_instance` | `instance-tools/base.ts` | write | — | 86 | — | y | 13 | 0 | keep |
| `set_instance_tool` | `instance-tools/base.ts` | write | — | 60 | — | y | 12 | 0 | keep |
| `subscribe_agent` | `instance-tools/base.ts` | write | — | 51 | — | y | 90 | 0 | keep |
| `ask_ticket` | `instance-tools/board.ts` | write | — | 103 | — | y | 2 | 0 | keep |
| `clear_finished_tasks` | `instance-tools/board.ts` | write | — | 55 | — | — | 0 | 0 | keep |
| `get_instance_board_config` | `instance-tools/board.ts` | read | — | 37 | — | y | 0 | 0 | keep |
| `hint_instance_task` | `instance-tools/board.ts` | write | — | 21 | y | — | 0 | 0 | keep |
| `instance_board` | `instance-tools/board.ts` | read | — | 197 | y | — | 0 | 0 | keep |
| `link_board_item_issue` | `instance-tools/board.ts` | write | — | 72 | — | y | 1 | 0 | keep |
| `promote_board_item` | `instance-tools/board.ts` | write | — | 79 | — | y | 1 | 0 | keep |
| `reorder_board_item` | `instance-tools/board.ts` | write | — | 122 | — | y | 0 | 0 | keep |
| `set_board_item_status` | `instance-tools/board.ts` | write | — | 23 | — | y | 17 | 0 | keep |
| `set_instance_board_config` | `instance-tools/board.ts` | write | — | 72 | — | — | 0 | 0 | keep |
| `sync_board_issues` | `instance-tools/board.ts` | write | — | 86 | — | — | 4 | 0 | keep |
| `task_action_log` | `instance-tools/board.ts` | read | — | 122 | — | y | 1 | 1 | keep |
| `ticket_thread` | `instance-tools/board.ts` | read | — | 51 | — | y | 0 | 0 | keep |
| `unlink_board_item_issue` | `instance-tools/board.ts` | write | — | 28 | — | y | 0 | 0 | keep |
| `update_board_ticket` | `instance-tools/board.ts` | write | — | 94 | — | y | 1 | 0 | keep |
| `browser_takeover_get` | `instance-tools/browser-verification.ts` | read | — | 24 | — | — | 0 | 0 | keep |
| `browser_takeover_list` | `instance-tools/browser-verification.ts` | read | — | 80 | — | — | 0 | 0 | keep |
| `browser_takeover_request` | `instance-tools/browser-verification.ts` | write | — | 75 | — | — | 7 | 0 | keep |
| `browser_takeover_transition` | `instance-tools/browser-verification.ts` | runtime | — | 86 | — | — | 4 | 0 | keep |
| `get_browser_screenshots` | `instance-tools/browser-verification.ts` | read | — | 74 | — | — | 0 | 0 | keep |
| `get_instance_browser_verification` | `instance-tools/browser-verification.ts` | read | — | 99 | — | y | 0 | 0 | keep |
| `job_lead_browser_verifications` | `instance-tools/browser-verification.ts` | read | — | 144 | — | y | 0 | 0 | keep |
| `job_lead_intake_url` | `instance-tools/browser-verification.ts` | write | — | 187 | — | — | 9 | 0 | keep |
| `list_eligible_browser_runtimes` | `instance-tools/browser-verification.ts` | read | — | 80 | — | — | 0 | 0 | keep |
| `set_browser_screenshots` | `instance-tools/browser-verification.ts` | write | — | 73 | — | — | 0 | 0 | keep |
| `set_instance_browser_verification` | `instance-tools/browser-verification.ts` | write | — | 70 | — | y | 3 | 0 | keep |
| `verify_job_lead_now` | `instance-tools/browser-verification.ts` | runtime | — | 71 | — | — | 7 | 1 | keep |
| `coder_questions` | `instance-tools/coder-brain.ts` | read | — | 52 | — | y | 0 | 0 | keep |
| `get_auto_pickup` | `instance-tools/coder-brain.ts` | read | — | 66 | — | y | 0 | 0 | keep |
| `po_triage_reports` | `instance-tools/coder-brain.ts` | read | — | 102 | — | — | 0 | 0 | keep |
| `set_auto_pickup` | `instance-tools/coder-brain.ts` | write | — | 166 | — | y | 0 | 0 | keep |
| `set_coder_brain` | `instance-tools/coder-brain.ts` | write | — | 230 | — | y | 3 | 0 | keep |
| `coding_loop_lifecycle` | `instance-tools/coding.ts` | read | — | 181 | — | y | 0 | 0 | keep |
| `coding_loop_queue` | `instance-tools/coding.ts` | read | — | 267 | — | y | 1 | 1 | keep |
| `coding_loop_queue_cancel` | `instance-tools/coding.ts` | write | — | 65 | — | y | 191 | 1 | keep |
| `coding_loop_queue_reorder` | `instance-tools/coding.ts` | write | — | 93 | — | y | 7 | 0 | keep |
| `coding_loop_start` | `instance-tools/coding.ts` | runtime | — | 700 | y | y | 4853 | 74 | keep — survivor of the loop-start pair |
| `coding_loop_status` | `instance-tools/coding.ts` | read | — | 385 | — | y | 2 | 2 | keep — survivor of the loop-status pair |
| `coding_loop_stop` | `instance-tools/coding.ts` | write | — | 41 | — | y | 74 | 1 | keep — survivor of the loop-stop pair |
| `coding_loop_trace` | `instance-tools/coding.ts` | read | coding | 136 | — | y | 0 | 0 | keep |
| `coding_terminal` | `instance-tools/coding.ts` | read | coding | 190 | — | y | 0 | 0 | keep |
| `coding_timeline` | `instance-tools/coding.ts` | read | coding | 340 | — | y | 0 | 0 | keep |
| `system_status` | `coding-tools.ts` | read | coding | 102 | — | — | 0 | 0 | **deprecated alias** of `coding_diagnostics` (#1243) — remove after 2027-01-18 if the ledger shows no calls |
| `check_instance_loop` | `instance-tools/coding.ts` | read | — | 307 | — | y | 0 | 0 | **deprecated alias** of `coding_loop_status` (#1243) — remove after 2027-01-18 if the ledger shows no calls |
| `continue_instance_run` | `instance-tools/composition.ts` | runtime | — | 226 | y | y | 4 | 0 | keep |
| `create_connection` | `instance-tools/composition.ts` | write | — | 40 | — | — | 6 | 0 | keep |
| `create_supervision` | `instance-tools/composition.ts` | write | — | 79 | — | y | 3 | 0 | keep |
| `delete_connection` | `instance-tools/composition.ts` | destructive | — | 59 | — | y | 0 | 0 | keep |
| `delete_supervision` | `instance-tools/composition.ts` | destructive | — | 41 | — | — | 0 | 0 | keep |
| `get_instance_loop_limits` | `instance-tools/composition.ts` | read | — | 130 | — | — | 0 | 0 | keep |
| `get_instance_loop_presets` | `instance-tools/composition.ts` | read | — | 59 | — | y | 0 | 0 | keep |
| `list_connection_deliveries` | `instance-tools/composition.ts` | read | — | 118 | — | — | 0 | 0 | keep |
| `list_connections` | `instance-tools/composition.ts` | read | — | 21 | y | — | 0 | 0 | keep |
| `list_supervision` | `instance-tools/composition.ts` | read | — | 19 | — | — | 0 | 0 | keep — description under 20 words |
| `preview_instance_run_continue` | `instance-tools/composition.ts` | read | — | 183 | — | y | 0 | 0 | keep |
| `replay_connection_delivery` | `instance-tools/composition.ts` | runtime | — | 99 | — | — | 0 | 0 | keep |
| `set_connection_enabled` | `instance-tools/composition.ts` | write | — | 69 | — | y | 4 | 0 | keep |
| `set_instance_loop_limits` | `instance-tools/composition.ts` | write | — | 135 | — | — | 17 | 0 | keep |
| `set_instance_loop_presets` | `instance-tools/composition.ts` | write | — | 104 | — | y | 0 | 0 | keep |
| `set_supervision_enabled` | `instance-tools/composition.ts` | write | — | 61 | — | y | 0 | 0 | keep |
| `start_instance_loop` | `instance-tools/coding.ts` | runtime | — | 37 | — | y | 12 | 0 | **deprecated alias** of `coding_loop_start` (#1243) — remove after 2027-01-18 if the ledger shows no calls |
| `stop_instance_loop` | `instance-tools/coding.ts` | write | — | 37 | — | y | 0 | 0 | **deprecated alias** of `coding_loop_stop` (#1243) — remove after 2027-01-18 if the ledger shows no calls |
| `connector_status` | `instance-tools/connectors.ts` | read | — | 62 | — | — | 0 | 0 | keep |
| `delete_instance_connector_grant` | `instance-tools/connectors.ts` | destructive | — | 34 | — | y | 0 | 0 | keep |
| `get_instance_connector_account` | `instance-tools/connectors.ts` | read | — | 150 | y | y | 0 | 0 | keep |
| `grant_instance_connector_folder` | `instance-tools/connectors.ts` | write | — | 83 | — | y | 0 | 0 | keep |
| `import_instance_drive_file` | `instance-tools/connectors.ts` | write | — | 101 | — | y | 0 | 0 | keep |
| `import_instance_workdrive_file` | `instance-tools/connectors.ts` | write | — | 92 | — | y | 0 | 0 | keep |
| `list_connectors` | `instance-tools/connectors.ts` | read | — | 113 | — | y | 0 | 0 | keep |
| `list_instance_connector_consents` | `instance-tools/connectors.ts` | read | — | 84 | — | y | 0 | 0 | keep |
| `list_instance_connector_grants` | `instance-tools/connectors.ts` | read | — | 60 | — | — | 0 | 0 | keep |
| `list_instance_connectors` | `instance-tools/connectors.ts` | read | — | 86 | — | y | 0 | 0 | keep |
| `list_instance_drive_files` | `instance-tools/connectors.ts` | read | — | 95 | — | y | 0 | 0 | keep |
| `set_instance_connector_account` | `instance-tools/connectors.ts` | write | — | 127 | — | y | 2 | 0 | keep |
| `set_instance_connector_consent` | `instance-tools/connectors.ts` | write | — | 88 | — | y | 11 | 0 | keep |
| `sync_github_installations` | `instance-tools/connectors.ts` | write | — | 159 | y | — | 2 | 0 | keep |
| `get_console_link` | `instance-tools/console-link.ts` | read | — | 202 | y | — | 0 | 0 | keep |
| `list_instance_permission_requests` | `instance-tools/console-link.ts` | read | — | 117 | — | — | 0 | 0 | keep |
| `connect_discord_bot` | `instance-tools/discord.ts` | write | — | 89 | — | y | 2 | 0 | keep |
| `disconnect_discord_bot` | `instance-tools/discord.ts` | destructive | — | 37 | — | — | 0 | 0 | keep |
| `discord_bot_status` | `instance-tools/discord.ts` | read | — | 38 | — | — | 0 | 0 | keep |
| `grant_instance_discord_channel` | `instance-tools/discord.ts` | write | — | 77 | — | y | 421 | 143 | keep |
| `list_discord_channels` | `instance-tools/discord.ts` | read | — | 33 | — | y | 0 | 0 | keep |
| `list_discord_guilds` | `instance-tools/discord.ts` | read | — | 21 | — | — | 2 | 2 | keep |
| `list_instance_discord_grants` | `instance-tools/discord.ts` | read | — | 39 | — | y | 0 | 0 | keep |
| `revoke_instance_discord_grant` | `instance-tools/discord.ts` | destructive | — | 35 | — | y | 0 | 0 | keep |
| `gmail_scout_config_get` | `instance-tools/gmail-scout.ts` | read | — | 14 | — | — | 0 | 0 | keep — description under 20 words |
| `gmail_scout_config_set` | `instance-tools/gmail-scout.ts` | write | — | 23 | — | — | 4 | 0 | keep |
| `gmail_scout_reprocess` | `instance-tools/gmail-scout.ts` | write | — | 141 | — | y | 10 | 0 | keep |
| `gmail_scout_scan` | `instance-tools/gmail-scout.ts` | write | — | 113 | — | — | 20 | 0 | keep |
| `gmail_scout_status` | `instance-tools/gmail-scout.ts` | read | — | 39 | — | — | 0 | 0 | keep |
| `get_instance_connection_guide` | `instance-tools/guide.ts` | read | — | 88 | y | y | 0 | 0 | keep |
| `bind_http_profile` | `instance-tools/http-profiles.ts` | write | — | 39 | — | — | 0 | 0 | keep |
| `create_http_profile` | `instance-tools/http-profiles.ts` | write | — | 84 | — | y | 0 | 0 | keep |
| `delete_http_profile` | `instance-tools/http-profiles.ts` | destructive | — | 26 | — | y | 0 | 0 | keep |
| `get_http_profile` | `instance-tools/http-profiles.ts` | read | — | 12 | — | — | 0 | 0 | keep — description under 20 words |
| `list_http_profiles` | `instance-tools/http-profiles.ts` | read | — | 41 | — | — | 0 | 0 | keep |
| `list_instance_http_bindings` | `instance-tools/http-profiles.ts` | read | — | 38 | — | — | 0 | 0 | keep |
| `rotate_http_profile_secret` | `instance-tools/http-profiles.ts` | write | — | 29 | — | — | 0 | 0 | keep |
| `test_http_profile` | `instance-tools/http-profiles.ts` | read | — | 44 | — | — | 0 | 0 | keep |
| `unbind_http_profile` | `instance-tools/http-profiles.ts` | write | — | 22 | — | — | 0 | 0 | keep |
| `update_http_profile` | `instance-tools/http-profiles.ts` | write | — | 40 | — | y | 0 | 0 | keep |
| `add_instance_knowledge` | `instance-tools/knowledge.ts` | write | — | 16 | — | — | 64 | 0 | keep — description under 20 words |
| `delete_instance_file` | `instance-tools/knowledge.ts` | destructive | — | 20 | — | — | 0 | 0 | keep |
| `delete_instance_knowledge` | `instance-tools/knowledge.ts` | destructive | — | 9 | — | — | 2 | 0 | keep — description under 20 words |
| `delete_instance_memory` | `instance-tools/knowledge.ts` | destructive | — | 10 | — | — | 3 | 0 | keep — description under 20 words |
| `get_instance_memory` | `instance-tools/knowledge.ts` | read | — | 18 | — | — | 0 | 0 | keep — description under 20 words |
| `ingest_instance_knowledge_url` | `instance-tools/knowledge.ts` | write | — | 79 | — | — | 0 | 0 | keep |
| `list_instance_files` | `instance-tools/knowledge.ts` | read | — | 33 | — | y | 0 | 0 | keep |
| `list_instance_knowledge` | `instance-tools/knowledge.ts` | read | — | 9 | — | — | 0 | 0 | keep — description under 20 words |
| `search_instance_knowledge` | `instance-tools/knowledge.ts` | read | — | 35 | — | — | 0 | 0 | keep |
| `update_instance_knowledge` | `instance-tools/knowledge.ts` | write | — | 72 | — | y | 1 | 0 | keep |
| `upload_instance_file` | `instance-tools/knowledge.ts` | write | — | 42 | — | — | 2 | 0 | keep |
| `vector_stats` | `instance-tools/knowledge.ts` | read | — | 110 | — | y | 0 | 0 | keep |
| `write_instance_memory` | `instance-tools/knowledge.ts` | write | — | 23 | — | y | 18 | 0 | keep |
| `cancel_local_browser_run` | `instance-tools/local-browser.ts` | write | — | 36 | — | — | 0 | 0 | keep |
| `get_instance_local_browser_settings` | `instance-tools/local-browser.ts` | read | — | 198 | — | y | 0 | 0 | keep |
| `get_local_browser_consent` | `instance-tools/local-browser.ts` | read | — | 46 | — | — | 0 | 0 | keep |
| `list_local_browser_runs` | `instance-tools/local-browser.ts` | read | — | 180 | — | y | 0 | 0 | keep |
| `local_browser_preflight` | `instance-tools/local-browser.ts` | read | — | 74 | — | — | 0 | 0 | keep |
| `resume_local_browser_run` | `instance-tools/local-browser.ts` | runtime | — | 61 | — | y | 0 | 0 | keep |
| `review_local_browser_finding` | `instance-tools/local-browser.ts` | write | — | 78 | — | — | 9 | 0 | keep |
| `set_instance_local_browser_settings` | `instance-tools/local-browser.ts` | write | — | 82 | — | y | 8 | 0 | keep |
| `set_local_browser_consent` | `instance-tools/local-browser.ts` | write | — | 66 | — | y | 6 | 0 | keep |
| `start_local_browser_run` | `instance-tools/local-browser.ts` | runtime | — | 91 | — | y | 13 | 0 | keep |
| `actions_runner_setup` | `instance-tools/machine-control.ts` | runtime | — | 152 | — | y | 34 | 16 | keep |
| `actions_runner_status` | `instance-tools/machine-control.ts` | read | — | 40 | — | y | 4 | 4 | keep |
| `force_runner_attach` | `instance-tools/machine-control.ts` | runtime | — | 427 | y | y | 57 | 2 | keep |
| `get_machine_policy` | `instance-tools/machine-control.ts` | read | — | 123 | — | y | 0 | 0 | keep |
| `native_preflight` | `instance-tools/machine-control.ts` | read | — | 72 | — | — | 1 | 1 | keep |
| `runner_restart` | `instance-tools/machine-control.ts` | runtime | — | 213 | — | y | 7 | 0 | keep |
| `runner_update` | `instance-tools/machine-control.ts` | runtime | — | 303 | y | y | 58 | 0 | keep |
| `runner_update_status` | `instance-tools/machine-control.ts` | read | — | 136 | — | y | 0 | 0 | keep |
| `set_machine_policy` | `instance-tools/machine-control.ts` | write | — | 89 | — | y | 18 | 0 | keep |
| `answer_instance_mcp_input_request` | `instance-tools/mcp-connections.ts` | runtime | — | 112 | — | — | 0 | 0 | keep |
| `list_instance_mcp_grants` | `instance-tools/mcp-connections.ts` | read | — | 81 | — | y | 0 | 0 | keep |
| `list_instance_mcp_input_requests` | `instance-tools/mcp-connections.ts` | read | — | 75 | — | — | 0 | 0 | keep |
| `list_mcp_presets` | `instance-tools/mcp-connections.ts` | read | — | 62 | — | — | 0 | 0 | keep |
| `set_instance_mcp_grant` | `instance-tools/mcp-connections.ts` | write | — | 110 | — | — | 0 | 0 | keep |
| `test_instance_mcp_server` | `instance-tools/mcp-connections.ts` | runtime | — | 124 | — | — | 0 | 0 | keep |
| `admin_action_audit` | `instance-tools/observability.ts` | read | — | 105 | — | — | 0 | 0 | keep |
| `admin_mcp_audit` | `instance-tools/observability.ts` | read | — | 197 | — | y | 1 | 1 | keep |
| `agent_trace` | `instance-tools/observability.ts` | read | — | 263 | — | — | 11 | 11 | keep |
| `clear_instance_messages` | `instance-tools/observability.ts` | destructive | — | 17 | — | — | 0 | 0 | keep — description under 20 words |
| `delete_feedback` | `instance-tools/observability.ts` | destructive | — | 46 | — | y | 1 | 0 | keep |
| `delete_instance_message` | `instance-tools/observability.ts` | destructive | — | 49 | — | y | 0 | 0 | keep |
| `error_summary` | `instance-tools/observability.ts` | read | — | 209 | — | y | 0 | 0 | keep |
| `get_instance_pipeline` | `instance-tools/observability.ts` | read | — | 68 | — | — | 0 | 0 | keep |
| `instance_activity` | `instance-tools/observability.ts` | read | — | 31 | — | — | 0 | 0 | keep |
| `instance_messages` | `instance-tools/observability.ts` | read | — | 62 | — | — | 0 | 0 | keep |
| `list_errors` | `instance-tools/observability.ts` | read | — | 140 | — | — | 0 | 0 | keep |
| `list_feedback` | `instance-tools/observability.ts` | read | — | 80 | — | y | 0 | 0 | keep |
| `list_pipeline_runs` | `instance-tools/observability.ts` | read | — | 63 | — | — | 0 | 0 | keep |
| `record_instance_feedback` | `instance-tools/observability.ts` | write | — | 116 | — | y | 5 | 0 | keep |
| `resolve_feedback` | `instance-tools/observability.ts` | write | — | 75 | — | — | 6 | 0 | keep |
| `telemetry_health` | `instance-tools/observability.ts` | read | — | 111 | — | y | 0 | 0 | keep |
| `account_activity` | `instance-tools/recent.ts` | read | — | 186 | — | y | 0 | 0 | keep |
| `fleet_snapshot` | `instance-tools/recent.ts` | read | — | 222 | — | y | 0 | 0 | keep |
| `recent_instances` | `instance-tools/recent.ts` | read | — | 408 | — | y | 0 | 0 | keep |
| `set_instance_tags` | `instance-tools/recent.ts` | write | — | 53 | y | y | 6 | 0 | keep |
| `connect_slack_bot` | `instance-tools/release-notes.ts` | write | — | 86 | — | y | 0 | 0 | keep |
| `disconnect_slack_bot` | `instance-tools/release-notes.ts` | destructive | — | 32 | — | — | 0 | 0 | keep |
| `get_instance_release_notes` | `instance-tools/release-notes.ts` | read | — | 66 | — | y | 0 | 0 | keep |
| `grant_instance_slack_channel` | `instance-tools/release-notes.ts` | write | — | 79 | — | y | 0 | 0 | keep |
| `list_instance_slack_grants` | `instance-tools/release-notes.ts` | read | — | 22 | — | y | 0 | 0 | keep |
| `list_slack_channels` | `instance-tools/release-notes.ts` | read | — | 55 | — | y | 0 | 0 | keep |
| `revoke_instance_slack_grant` | `instance-tools/release-notes.ts` | destructive | — | 29 | — | y | 0 | 0 | keep |
| `send_test_release_note` | `instance-tools/release-notes.ts` | write | — | 77 | y | y | 0 | 0 | keep |
| `set_instance_release_notes` | `instance-tools/release-notes.ts` | write | — | 78 | — | y | 0 | 0 | keep |
| `slack_bot_status` | `instance-tools/release-notes.ts` | read | — | 49 | — | — | 0 | 0 | keep |
| `ingest_repo` | `instance-tools/repo.ts` | write | repo | 76 | — | — | 2 | 0 | keep |
| `ingest_repo_status` | `instance-tools/repo.ts` | read | repo | 25 | — | — | 0 | 0 | keep |
| `remove_repo` | `instance-tools/repo.ts` | destructive | repo | 25 | — | — | 4 | 0 | keep |
| `answer_instance_input` | `instance-tools/runtime.ts` | runtime | — | 267 | — | y | 86 | 0 | keep |
| `approve_instance_task` | `instance-tools/runtime.ts` | runtime | — | 39 | — | — | 0 | 0 | keep |
| `cancel_instance_task` | `instance-tools/runtime.ts` | destructive | — | 15 | — | — | 2 | 0 | keep — description under 20 words |
| `delete_instance_task` | `instance-tools/runtime.ts` | destructive | — | 71 | — | y | 0 | 0 | keep |
| `end_instance_takeover` | `instance-tools/runtime.ts` | runtime | — | 53 | — | y | 1 | 0 | keep |
| `forget_runner_node` | `instance-tools/runtime.ts` | destructive | — | 55 | — | y | 0 | 0 | keep |
| `get_instance_task` | `instance-tools/runtime.ts` | read | — | 72 | — | y | 0 | 0 | keep |
| `get_instance_terminal_session` | `instance-tools/runtime.ts` | read | — | 67 | — | — | 0 | 0 | keep |
| `instance_runner_node` | `instance-tools/runtime.ts` | read | — | 136 | — | — | 0 | 0 | keep |
| `instance_runtime_status` | `instance-tools/runtime.ts` | read | — | 75 | — | y | 0 | 0 | keep |
| `instance_task_events` | `instance-tools/runtime.ts` | read | — | 10 | — | — | 0 | 0 | keep — description under 20 words |
| `list_runner_nodes` | `instance-tools/runtime.ts` | read | — | 355 | — | y | 0 | 0 | keep |
| `register_instance_runtime` | `instance-tools/runtime.ts` | runtime | — | 21 | — | y | 0 | 0 | keep |
| `resume_instance_takeover` | `instance-tools/runtime.ts` | runtime | — | 49 | — | y | 0 | 0 | keep |
| `run_instance_task` | `instance-tools/runtime.ts` | runtime | — | 31 | — | — | 3 | 0 | keep |
| `runner_node_forget_preflight` | `instance-tools/runtime.ts` | read | — | 45 | — | y | 0 | 0 | keep |
| `runner_resource_history` | `instance-tools/runtime.ts` | read | — | 150 | y | y | 0 | 0 | keep |
| `runner_setup` | `instance-tools/runtime.ts` | read | — | 143 | y | y | 0 | 0 | keep |
| `send_instance_takeover_input` | `instance-tools/runtime.ts` | runtime | — | 83 | — | y | 0 | 0 | keep |
| `set_instance_runner_node` | `instance-tools/runtime.ts` | write | — | 361 | — | y | 140 | 0 | keep |
| `set_instance_terminal_session` | `instance-tools/runtime.ts` | write | — | 38 | — | — | 0 | 0 | keep |
| `start_instance_browser_task` | `instance-tools/runtime.ts` | destructive | — | 83 | — | y | 2 | 0 | keep |
| `unregister_instance_runtime` | `instance-tools/runtime.ts` | destructive | — | 11 | — | — | 1 | 0 | keep — description under 20 words |
| `secure_input_inject` | `instance-tools/secure-input.ts` | runtime | — | 203 | — | — | 7 | 4 | keep |
| `secure_input_request` | `instance-tools/secure-input.ts` | write | — | 101 | y | y | 10 | 0 | keep |
| `secure_input_status` | `instance-tools/secure-input.ts` | read | — | 80 | — | y | 0 | 0 | keep |
| `clear_instance_voice_settings` | `instance-tools/settings.ts` | write | — | 43 | — | y | 0 | 0 | keep |
| `get_agent_operator_manual` | `instance-tools/settings.ts` | read | — | 58 | — | y | 0 | 0 | keep |
| `get_agent_settings_schema` | `instance-tools/settings.ts` | read | — | 19 | — | — | 0 | 0 | keep — description under 20 words |
| `get_instance_behaviour_schema` | `instance-tools/settings.ts` | read | — | 40 | — | — | 0 | 0 | keep |
| `get_instance_instructions` | `instance-tools/settings.ts` | read | — | 25 | — | — | 0 | 0 | keep |
| `get_instance_notification_policy` | `instance-tools/settings.ts` | read | — | 132 | — | y | 0 | 0 | keep |
| `get_instance_operator_manual` | `instance-tools/settings.ts` | read | — | 212 | — | y | 0 | 0 | keep |
| `get_instance_settings` | `instance-tools/settings.ts` | read | — | 19 | y | — | 0 | 0 | keep — description under 20 words |
| `get_instance_state` | `instance-tools/settings.ts` | read | — | 154 | — | y | 0 | 0 | keep |
| `get_instance_voice_settings` | `instance-tools/settings.ts` | read | — | 84 | y | — | 0 | 0 | keep |
| `get_notification_vocabulary` | `instance-tools/settings.ts` | read | — | 73 | — | y | 0 | 0 | keep |
| `get_translation_config` | `instance-tools/settings.ts` | read | — | 15 | — | — | 0 | 0 | keep — description under 20 words |
| `rename_instance` | `instance-tools/settings.ts` | write | — | 24 | — | — | 68 | 1 | keep |
| `resync_instance_personality` | `instance-tools/settings.ts` | destructive | — | 78 | y | y | 0 | 0 | keep |
| `set_agent_operator_manual` | `instance-tools/settings.ts` | write | — | 68 | — | y | 0 | 0 | keep |
| `set_agent_settings_schema` | `instance-tools/settings.ts` | write | — | 21 | — | — | 3 | 0 | keep |
| `set_instance_instructions` | `instance-tools/settings.ts` | write | — | 14 | — | — | 90 | 0 | keep — description under 20 words |
| `set_instance_model` | `instance-tools/settings.ts` | write | — | 119 | — | — | 4 | 0 | keep |
| `set_instance_notification_policy` | `instance-tools/settings.ts` | write | — | 168 | y | — | 0 | 0 | keep |
| `set_instance_operator_manual` | `instance-tools/settings.ts` | write | — | 56 | — | y | 4 | 0 | keep |
| `set_instance_settings` | `instance-tools/settings.ts` | write | — | 22 | — | — | 10 | 0 | keep |
| `set_instance_voice_settings` | `instance-tools/settings.ts` | write | — | 80 | — | y | 0 | 0 | keep |
| `set_translation_config` | `instance-tools/settings.ts` | write | — | 11 | — | — | 0 | 0 | keep — description under 20 words |
| `get_agent_stats_schema` | `instance-tools/stats.ts` | read | — | 20 | — | — | 0 | 0 | keep |
| `get_instance_stats` | `instance-tools/stats.ts` | read | — | 68 | — | — | 0 | 0 | keep |
| `list_stats_sources` | `instance-tools/stats.ts` | read | — | 39 | — | y | 0 | 0 | keep |
| `set_agent_stats_schema` | `instance-tools/stats.ts` | write | — | 61 | — | — | 2 | 0 | keep |
| `set_instance_stats` | `instance-tools/stats.ts` | write | — | 69 | — | — | 0 | 0 | keep |
| `create_instance_trigger` | `instance-tools/triggers.ts` | write | — | 58 | y | — | 2 | 0 | keep |
| `delete_instance_trigger` | `instance-tools/triggers.ts` | destructive | — | 14 | — | — | 0 | 0 | keep — description under 20 words |
| `list_instance_trigger_events` | `instance-tools/triggers.ts` | read | — | 12 | — | — | 0 | 0 | keep — description under 20 words |
| `list_instance_triggers` | `instance-tools/triggers.ts` | read | — | 12 | — | — | 0 | 0 | keep — description under 20 words |
| `list_trigger_actions` | `instance-tools/triggers.ts` | read | — | 65 | — | y | 0 | 0 | keep |
| `preview_instance_trigger` | `instance-tools/triggers.ts` | read | — | 98 | — | — | 0 | 0 | keep |
| `run_instance_trigger` | `instance-tools/triggers.ts` | runtime | — | 19 | — | — | 1 | 0 | keep — description under 20 words |
| `set_instance_trigger` | `instance-tools/triggers.ts` | write | — | 103 | — | y | 1 | 0 | keep |
| `agent_activity` | `storage-tools.ts` | read | — | 13 | — | — | 1 | 1 | keep — description rewritten (top-20) |
| `create_collection` | `storage-tools.ts` | write | — | 14 | — | — | 4 | 0 | keep — description rewritten (top-20) |
| `create_instance_ticket` | `storage-tools.ts` | write | — | 54 | — | — | 8 | 0 | keep |
| `insert_instance_record` | `storage-tools.ts` | write | — | 18 | — | — | 7 | 0 | keep — description under 20 words |
| `insert_record` | `storage-tools.ts` | write | — | 7 | — | — | 8 | 0 | keep — description rewritten (top-20) |
| `list_agent_files` | `storage-tools.ts` | read | — | 9 | — | — | 0 | 0 | keep — description under 20 words |
| `list_collections` | `storage-tools.ts` | read | — | 13 | — | — | 0 | 0 | keep — description rewritten (top-20) |
| `list_instance_collections` | `storage-tools.ts` | read | — | 16 | — | — | 0 | 0 | keep — description under 20 words |
| `query_instance_records` | `storage-tools.ts` | read | — | 17 | — | — | 0 | 0 | keep — description under 20 words |
| `query_records` | `storage-tools.ts` | read | — | 11 | — | — | 0 | 0 | keep — description rewritten (top-20) |
| `search_agent_knowledge` | `storage-tools.ts` | read | — | 11 | — | — | 0 | 0 | keep — description under 20 words |
| `triage_job_lead` | `storage-tools.ts` | write | — | 76 | — | — | 43 | 0 | keep |
| `update_instance_record` | `storage-tools.ts` | write | — | 82 | — | y | 1 | 0 | keep |
| `update_record` | `storage-tools.ts` | write | — | 6 | — | — | 0 | 0 | keep — description rewritten (top-20) |
| `upload_agent_file` | `storage-tools.ts` | write | — | 25 | — | — | 0 | 0 | keep |
| `mcp_server_info` | `tools/server-info.ts` | read | — | 38 | — | — | 0 | 0 | keep |

### 5.1 No logged call in the window: the write, runtime and destructive ones (#1243)

The **75 write, runtime or destructive tools** with zero events in the ~80-day ledger
(the four deprecated aliases are excluded):

- `index.ts`: `chat_with_agent`, `trigger_agent_deploy`, `update_agent_board_config`
- `instance-tools/account.ts`: `mark_all_notifications_read`, `mark_notification_read`, `set_budget_limits`
- `instance-tools/agent-authoring.ts`: `chat_with_my_agent`, `create_agent_version`, `delete_agent`, `delete_agent_knowledge`, `execute_agent_builder_plan`, `rollback_agent_version`, `set_agent_state`
- `instance-tools/agent-tasks.ts`: `delete_agent_task`
- `instance-tools/applications.ts`: `assert_application_not_submitted`, `clear_application_tailor_uploaded_source`, `generate_application_materials`, `start_application_fill`
- `instance-tools/apply.ts`: `upload_resume`
- `instance-tools/board.ts`: `clear_finished_tasks`, `hint_instance_task`, `reorder_board_item`, `set_instance_board_config`, `unlink_board_item_issue`
- `instance-tools/browser-verification.ts`: `set_browser_screenshots`
- `instance-tools/coder-brain.ts`: `set_auto_pickup`
- `instance-tools/composition.ts`: `delete_connection`, `delete_supervision`, `replay_connection_delivery`, `set_instance_loop_presets`, `set_supervision_enabled`
- `instance-tools/connectors.ts`: `delete_instance_connector_grant`, `grant_instance_connector_folder`, `import_instance_drive_file`, `import_instance_workdrive_file`
- `instance-tools/discord.ts`: `disconnect_discord_bot`, `revoke_instance_discord_grant`
- `instance-tools/http-profiles.ts`: `bind_http_profile`, `create_http_profile`, `delete_http_profile`, `rotate_http_profile_secret`, `unbind_http_profile`, `update_http_profile`
- `instance-tools/knowledge.ts`: `delete_instance_file`, `ingest_instance_knowledge_url`
- `instance-tools/local-browser.ts`: `cancel_local_browser_run`, `resume_local_browser_run`
- `instance-tools/mcp-connections.ts`: `answer_instance_mcp_input_request`, `set_instance_mcp_grant`, `test_instance_mcp_server`
- `instance-tools/observability.ts`: `clear_instance_messages`, `delete_instance_message`
- `instance-tools/release-notes.ts`: `connect_slack_bot`, `disconnect_slack_bot`, `grant_instance_slack_channel`, `revoke_instance_slack_grant`, `send_test_release_note`, `set_instance_release_notes`
- `instance-tools/runtime.ts`: `approve_instance_task`, `delete_instance_task`, `forget_runner_node`, `register_instance_runtime`, `resume_instance_takeover`, `send_instance_takeover_input`, `set_instance_terminal_session`
- `instance-tools/settings.ts`: `clear_instance_voice_settings`, `resync_instance_personality`, `set_agent_operator_manual`, `set_instance_notification_policy`, `set_instance_voice_settings`, `set_translation_config`
- `instance-tools/stats.ts`: `set_instance_stats`
- `instance-tools/triggers.ts`: `delete_instance_trigger`
- `storage-tools.ts`: `update_record`, `upload_agent_file`

**Decision: none is removed in #1243.** Zero calls here is weak evidence:
- **Traffic:** the ledger covers about 80 days of a pre-launch platform whose traffic is mostly one
  operator's agents.
- **Recency:** many of these tools shipped inside that window, e.g. the release-notes and Slack tools
  (#1217), the HTTP profiles (#1123), `set_auto_pickup` (#1233) and the operator manual (#1237).
- **Only path:** several are the only way to undo something: `revoke_*`, `delete_*`, `unbind_*`,
  `disconnect_*`, `cancel_local_browser_run`.

The list is re-run with the same call when the aliases come up for removal (2027-01-18). A tool still at
zero then, which is not the only way to reverse a write, is the removal candidate.

## 6. Top 20 agent-usability offenders

Ranked by evidence: observed failures first (§3), then verified duplicates, then the structural
proxies on the most-used groups. "Batch 1" means fixed by #1241's commits.

| # | Tool | Evidence | Fix | Status |
|---:|---|---|---|---|
| 1 | `call_instance_tool` | recurring 403 `"X" is not one of this agent's tools` (§3.3) | description leads with the precondition: names come from `list_instance_tools allowed_only:true schemas:true`, never memory; example call | batch 1 (description) |
| 2 | `coding_loop_start` | `api_409` busy in the ledger sample (§3.1) | the refusal should name `queue_if_busy:true` as the retry; consider defaulting it on | follow-up |
| 3 | `coding_repo_remove` (and every tool) | `repoId` sent beside `repo_id` (§3.1); zod stripped it silently | camelCase keys are renamed to the schema's snake_case, with a note in the reply; unknown keys are named, not dropped unseen | batch 1 (eb57ef71) |
| 4 | every tool | bare zod message on `invalid_input` | the error names each bad argument, lists the tool's arguments with type and required/optional, and gives a corrected example | batch 1 (eb57ef71), seen working live 2026-10-20 |
| 5 | `admin_mcp_audit` (and every tool) | `"true"` for a boolean (§3.2) | `"true"`/`"false"` and numeric strings are read as the declared type, with a note | batch 1 |
| 6 | unknown tool names | `unknown_tool` (§3.2) | the reply suggests the nearest real names; the ledger should record the tried name | batch 1 (suggestions); follow-up (ledger) |
| 7 | `start_instance_loop` | duplicate of `coding_loop_start` (§4) | description points at the survivor; merge | batch 1 (description); follow-up (merge) |
| 8 | `check_instance_loop` | duplicate of `coding_loop_status` | as above | batch 1 / follow-up |
| 9 | `stop_instance_loop` | duplicate of `coding_loop_stop` | as above | batch 1 / follow-up |
| 10 | `system_status` | duplicate of `coding_diagnostics`; says "tmux sessions" | description corrected and points at the survivor; merge | batch 1 / follow-up |
| 11 | `platform_guide` | 5-word description ("Get ProAgentStore platform guide") | say what is in it and when to read it | batch 1 |
| 12 | `sdk_reference` | 5 words | say it is for writing agent code, not driving instances | batch 1 |
| 13 | `chat_with_agent` | 8 words; one of three chat tools | name the trial mode and the two siblings | batch 1 |
| 14 | `add_knowledge` | 7 words; template vs instance | say it changes the TEMPLATE for every future subscriber; point to `add_instance_knowledge` | batch 1 |
| 15 | `list_knowledge` | short; template vs instance | as above | batch 1 |
| 16 | `query_records` | 10 words; template vs instance; no filter example | template vs instance plus an example | batch 1 |
| 17 | `insert_record` | 7 words; template vs instance | as above | batch 1 |
| 18 | `agent_activity` | 12 words; three activity tools | name the siblings | batch 1 |
| 19 | `answer_instance_input` | handoff 409/503 in the error log (§3.3) | refusals should say whether to retry or re-read the handoff | follow-up |
| 20 | application decision tools (`triage_application`, `approve_application`, …) | 409 "not part of an application pipeline" (`control.ts:166`) | descriptions should say they need a Scout/Tailor/Runner instance; `describe_instance` first | follow-up |

The other short-description tools (§5, "description under 20 words") get the same template in the
consolidation follow-up.

## 7. Follow-ups

Filed against #1241:

- **Consolidation (#1243), done 2026-10-20.** Each part, in order:
  - **Pairs:** the four §4 pairs are deprecated aliases of their survivors, removed after
    2027-01-18 if the ledger shows no calls (`643fc5f0`, `9db62581`).
  - **Unknown tools:** `unknown_tool` events record the name tried, when it is name-shaped
    (`d7930ec4`).
  - **Refusals:** the busy start and the answer handoff say what to do next (`a2fe9a8b`).
  - **Usage data:** §5 carries the 90-day ledger counts, and §5.1 records the removal decision —
    none now, re-run with the aliases (`f4b2dac5`).
  - **Application tools:** they name the instance type they need (`365eefbb`).
  - **Quick start:** `platform_guide` opens with a task-to-tool map (`5784f10c`).
  - **Descriptions:** the 40 remaining short ones follow the conventions template (`e6f39ced`).
  - **Found on the way:** `coding_session_restart` reports success with no runner connected
    (#1262).
- **Agent eval (#1244), harness and server-side baseline done; the live model score is open.** The
  harness, the 19 tasks covering every §6 row, the scorer and the before/after run of the server's
  handling of each offender shape are in §9. What is not yet measured is how often a MODEL makes
  those mistakes (the live run needs a model API key; §9.5).
- **Label guidance (#1245)**: surface the label vocabulary in the tools that set labels.
- **commit-close-watch noise (#1246)**: about 40k of 46k error-log rows in 30 days (§3.3).

## 8. Guards added by this audit

- **Tool-count ceiling** (`TOOL_COUNT_CEILINGS` in `workers/mcp/src/tool-count.ts`, tested in
  `tool-count.test.ts`): the surface may not grow past the latest ceiling, and each raise is an
  appended entry with a reason and an issue. Appending is the only way to grow, so a new tool is a
  recorded decision.
- The actionable-error, alias and coercion behaviour is pinned by `argument-normalize.test.ts`,
  through a real server and client.

## 9. Agent eval (#1244)

### 9.1 What it is

`workers/mcp/src/eval/` holds a harness that runs owner-shaped tasks against a real `PagsMcp` over a real
MCP client (the same construction as `argument-normalize.test.ts`), with the platform API stubbed per task and
every API request recorded.

- **Tasks** (`tasks.ts`): 19, covering every row of §6. Each is what an owner would say (never naming the
  tool), the one tool that does it, the API request that proves it was done, the careful call, and the
  recorded mistakes — each taken from the ledger or error log (§3) or the direct shape of an offender row.
  Instance ids are exact in the prompts, so a miss is the tool's or its description's.
- **Scorer** (`scorer.ts`): per call, **first-call success** = the right tool, valid as sent, no #1241
  alias/coercion note, no deprecated-alias reply, and the API request made. Also counted: calls answered with a
  note, `invalid_input`, unknown-tool, deprecated-alias and wrong-tool replies. `effective` is the lenient
  companion — the task got done, notes or not. The gap between the two is what the server's tolerance hides.
- **Drivers** (`driver.ts`): `ScriptedDriver` replays fixed calls; `anthropicDriver` asks a real model (Messages
  API, one forced tool call, temperature 0) from the owner's words and the server's real `tools/list`.

### 9.2 Running it

```
node scripts/mcp-agent-eval.mjs                    # scripted corpus, this checkout (deterministic, no network)
node scripts/mcp-agent-eval.mjs --ref bc9541f6     # the same corpus against an older revision (temporary worktree)
ANTHROPIC_API_KEY=… node scripts/mcp-agent-eval.mjs --driver live [--model <id>]
```

Each run prints a per-call table and stores `docs/mcp-eval/results-<driver>-<ref>-<sha>-<time>.json`
(`baseline-pre-eb57ef71.json` and `baseline-current.json` are the two stored below).

### 9.3 Execution model

- **CI: the scripted corpus.** It is deterministic and free, so `workers/mcp/src/eval/eval.test.ts` runs in the
  unit suite: the scorer, the drivers, task integrity (every §6 row covered, no prompt names its tool, every
  expected tool registered), every careful call a first-call success, every recorded mistake classified as
  expected, and the corpus totals pinned. A surface change that moves a total is a decision, not drift.
- **On demand, with stored results: the live model run.** A model call per task (each carrying all 380+ tool
  definitions) costs money, and a model answers differently on a different day, so it is never a CI gate. Run it
  when the tool surface or descriptions change and commit the result file beside the date and model.

### 9.4 Baseline: the server's handling of the offender shapes

The revision before `eb57ef71` is `bc9541f6`. The same 19 tasks (19 careful calls, 24 recorded mistakes) were
replayed against it and against current `main` with the scripted driver, by the commands above.

| | before (`bc9541f6`) | now (`main`) |
|---|---:|---:|
| careful calls that are a first-call success | 19 / 19 | 19 / 19 |
| mistakes that still got the task done (`effective`) | 7 / 24 | 11 / 24 |
| mistakes answered with a #1241 note (the schema misled the caller) | 0 | 5 |
| deprecated-alias replies (#1243) | 0 | 4 |
| `invalid_input` replies | 5 | 2 |
| unknown-tool replies | 2 | 2 |
| mistakes that chose a different tool than the right one | 16 | 16 |

What moved: four mistakes that **failed** before now succeed with a note naming the fix — `queue_if_busy: "true"`
(`boolean-as-string`), `instanceId` + `queueIfBusy` on `coding_loop_start`, `repoId` on `coding_repo_remove` (§6 #3,
the ledger's own case) and `taskId` on `answer_instance_input`. The two that remain `invalid_input` are the
ones nothing can guess (`instance_id: 1`, an object for a JSON-string `data`), and now carry the corrected example
(§6 #4). Unknown tools now suggest the nearest real names (§6 #6); the four duplicate pairs say they are deprecated.

What did not move, and cannot from the server side: **choosing the wrong tool** (16 of 24 mistakes — the template
tools instead of the instance ones, an alias, `agent_activity` for an instance). Those either still reach the API
or fail with no hint, because the call is valid for the tool it names. Only the descriptions and the quick start
(§6 #11–#18, #1243) can help, and only a model run measures whether they do.

**Reading the numbers.** The corpus replays chosen mistakes; it is not a sample of what models do, so
the rows above say what the server does with a mistake, not how often one is made. The strict first-call figure
for the mistakes is 1 / 24 before and 0 / 24 now, and that is an artefact, not a regression: before, the one
success was `limit: "5"` coerced silently (the old server gave no note, so it scored as clean); now the same call
is correctly counted as the caller being misled. Compare `effective`, `invalidInput` and the note counts across
revisions, not strict first-call success of the mistake rows.

### 9.5 Not yet measured

The live score — how often a model chooses the right tool with valid arguments on the first call — has not been
run: this environment has no model API key, and the harness refuses to start a live run without one rather than
guess. To close #1244: run `ANTHROPIC_API_KEY=… node scripts/mcp-agent-eval.mjs --driver live` on the current
revision and on `--ref bc9541f6 --driver live` with the same `--model`, commit both result files, and add the two
first-call rates here beside the table above.
