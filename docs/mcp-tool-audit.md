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

All 366 tools. **Words** is the description length in the published `tools/list`. **Ex** means the
description shows an example. **Sib** means it names another tool. The 90-day call/failure columns
are deliberately absent (§3 gap); add them from the `summarize` output.

| Tool | File (`workers/mcp/src/`) | Scope | Gated | Words | Ex | Sib | Recommendation |
|---|---|---|---|---:|:-:|:-:|---|
| `coding_engine_get` | `coding-engine-tools.ts` | read | coding | 195 | — | y | keep |
| `coding_engine_set` | `coding-engine-tools.ts` | write | coding | 206 | y | y | keep |
| `coding_engine_reauth` | `coding-reauth-tools.ts` | runtime | coding | 173 | — | y | keep |
| `retarget_repository_binding` | `coding-retarget-tools.ts` | write | coding | 189 | — | y | keep |
| `coding_diagnostics` | `coding-tools.ts` | read | coding | 240 | — | y | keep — survivor of the diagnostics pair |
| `coding_instance_deploy_status` | `coding-tools.ts` | read | coding | 68 | — | y | keep |
| `coding_repo_add` | `coding-tools.ts` | write | coding | 373 | y | y | keep |
| `coding_repo_remove` | `coding-tools.ts` | destructive | coding | 171 | — | y | keep |
| `coding_repos_list` | `coding-tools.ts` | read | coding | 44 | — | y | keep |
| `coding_session_capture` | `coding-tools.ts` | read | coding | 315 | — | y | keep |
| `coding_session_end` | `coding-tools.ts` | runtime | coding | 22 | — | y | keep |
| `coding_session_fresh` | `coding-tools.ts` | runtime | coding | 40 | — | y | keep |
| `coding_session_message` | `coding-tools.ts` | runtime | coding | 178 | — | y | keep |
| `coding_session_open` | `coding-tools.ts` | runtime | coding | 83 | — | y | keep |
| `coding_session_restart` | `coding-tools.ts` | runtime | coding | 18 | — | — | keep — description under 20 words |
| `coding_sessions_list` | `coding-tools.ts` | read | coding | 10 | — | — | keep — description under 20 words |
| `add_knowledge` | `index.ts` | write | — | 8 | — | — | keep — description rewritten (top-20) |
| `agent_analytics` | `index.ts` | read | — | 6 | — | — | keep — description under 20 words |
| `agent_deploy_status` | `index.ts` | read | — | 11 | — | — | keep — description under 20 words |
| `agent_info` | `index.ts` | read | — | 45 | — | y | keep |
| `batch_write_agent_files` | `index.ts` | destructive | — | 11 | — | — | keep — description under 20 words |
| `chat_with_agent` | `index.ts` | runtime | — | 9 | — | — | keep — description rewritten (top-20) |
| `create_agent` | `index.ts` | write | — | 45 | — | y | keep |
| `get_agent_board_config` | `index.ts` | read | — | 10 | — | — | keep — description under 20 words |
| `list_agent_repo_files` | `index.ts` | read | — | 16 | — | y | keep — description under 20 words |
| `list_agents` | `index.ts` | read | — | 35 | — | y | keep |
| `list_knowledge` | `index.ts` | read | — | 7 | — | — | keep — description rewritten (top-20) |
| `mcp_audit_log` | `index.ts` | read | — | 156 | — | — | keep |
| `my_agents` | `index.ts` | read | — | 100 | — | y | keep |
| `platform_guide` | `index.ts` | read | — | 4 | — | — | keep — description rewritten (top-20) |
| `read_agent_file` | `index.ts` | read | — | 9 | — | — | keep — description under 20 words |
| `scaffold_agent` | `index.ts` | write | — | 23 | — | — | keep |
| `sdk_reference` | `index.ts` | read | — | 5 | y | — | keep — description rewritten (top-20) |
| `trigger_agent_deploy` | `index.ts` | runtime | — | 11 | — | — | keep — description under 20 words |
| `update_agent` | `index.ts` | write | — | 43 | y | — | keep |
| `update_agent_board_config` | `index.ts` | write | — | 15 | — | — | keep — description under 20 words |
| `write_agent_file` | `index.ts` | destructive | — | 11 | — | — | keep — description under 20 words |
| `apply_account_coding_default` | `instance-tools/account.ts` | runtime | — | 132 | — | y | keep |
| `billing_status` | `instance-tools/account.ts` | read | — | 24 | — | — | keep |
| `email_status` | `instance-tools/account.ts` | read | — | 14 | — | — | keep — description under 20 words |
| `get_account_preferences` | `instance-tools/account.ts` | read | — | 110 | — | y | keep |
| `get_budget_limits` | `instance-tools/account.ts` | read | — | 43 | — | y | keep |
| `get_creator_dashboard` | `instance-tools/account.ts` | read | — | 32 | — | — | keep |
| `get_usage_dashboard` | `instance-tools/account.ts` | read | — | 37 | — | y | keep |
| `keys_status` | `instance-tools/account.ts` | read | — | 25 | — | — | keep |
| `list_notifications` | `instance-tools/account.ts` | read | — | 78 | — | y | keep |
| `mark_all_notifications_read` | `instance-tools/account.ts` | write | — | 42 | — | y | keep |
| `mark_notification_read` | `instance-tools/account.ts` | write | — | 53 | — | y | keep |
| `platform_health` | `instance-tools/account.ts` | read | — | 156 | — | — | keep |
| `set_account_preferences` | `instance-tools/account.ts` | write | — | 166 | y | y | keep |
| `set_budget_limits` | `instance-tools/account.ts` | write | — | 87 | — | y | keep |
| `update_profile` | `instance-tools/account.ts` | write | — | 19 | — | y | keep — description under 20 words |
| `usage_drivers` | `instance-tools/account.ts` | read | — | 155 | y | y | keep |
| `usage_summary` | `instance-tools/account.ts` | read | — | 214 | — | — | keep |
| `whoami` | `instance-tools/account.ts` | read | — | 73 | — | y | keep |
| `agent_messages` | `instance-tools/agent-authoring.ts` | read | — | 45 | — | y | keep |
| `chat_with_my_agent` | `instance-tools/agent-authoring.ts` | destructive | — | 41 | — | y | keep |
| `create_agent_version` | `instance-tools/agent-authoring.ts` | destructive | — | 39 | — | — | keep |
| `delete_agent` | `instance-tools/agent-authoring.ts` | destructive | — | 52 | — | y | keep |
| `delete_agent_knowledge` | `instance-tools/agent-authoring.ts` | destructive | — | 41 | — | y | keep |
| `execute_agent_builder_plan` | `instance-tools/agent-authoring.ts` | destructive | — | 44 | — | — | keep |
| `export_agent` | `instance-tools/agent-authoring.ts` | read | — | 89 | — | y | keep |
| `get_agent_capabilities` | `instance-tools/agent-authoring.ts` | read | — | 103 | — | y | keep |
| `get_agent_memory` | `instance-tools/agent-authoring.ts` | read | — | 52 | — | y | keep |
| `get_agent_state` | `instance-tools/agent-authoring.ts` | read | — | 48 | — | y | keep |
| `my_agent` | `instance-tools/agent-authoring.ts` | read | — | 102 | — | y | keep |
| `plan_agent_builder` | `instance-tools/agent-authoring.ts` | read | — | 33 | — | y | keep |
| `rollback_agent_version` | `instance-tools/agent-authoring.ts` | destructive | — | 37 | — | y | keep |
| `set_agent_capabilities` | `instance-tools/agent-authoring.ts` | destructive | — | 49 | — | y | keep |
| `set_agent_state` | `instance-tools/agent-authoring.ts` | destructive | — | 39 | — | y | keep |
| `create_agent_task` | `instance-tools/agent-tasks.ts` | write | — | 97 | — | y | keep |
| `delete_agent_task` | `instance-tools/agent-tasks.ts` | destructive | — | 86 | — | y | keep |
| `list_agent_tasks` | `instance-tools/agent-tasks.ts` | read | — | 97 | — | y | keep |
| `update_agent_task` | `instance-tools/agent-tasks.ts` | write | — | 78 | — | — | keep |
| `application_handoff` | `instance-tools/applications.ts` | read | — | 49 | — | — | keep |
| `application_reconciliation` | `instance-tools/applications.ts` | read | — | 54 | — | — | keep |
| `application_run` | `instance-tools/applications.ts` | read | — | 165 | — | y | keep |
| `application_run_supervision` | `instance-tools/applications.ts` | read | — | 91 | — | — | keep |
| `application_runs` | `instance-tools/applications.ts` | read | — | 79 | — | y | keep |
| `application_trace` | `instance-tools/applications.ts` | read | — | 84 | — | — | keep |
| `approve_application` | `instance-tools/applications.ts` | destructive | — | 317 | — | y | keep |
| `assert_application_not_submitted` | `instance-tools/applications.ts` | write | — | 146 | y | y | keep |
| `cancel_application` | `instance-tools/applications.ts` | write | — | 24 | — | — | keep |
| `clear_application_tailor_uploaded_source` | `instance-tools/applications.ts` | write | — | 44 | — | — | keep |
| `create_application_handoff` | `instance-tools/applications.ts` | runtime | — | 60 | — | — | keep |
| `generate_application_materials` | `instance-tools/applications.ts` | runtime | — | 31 | — | — | keep |
| `get_application` | `instance-tools/applications.ts` | read | — | 56 | — | — | keep |
| `get_application_runner_settings` | `instance-tools/applications.ts` | read | — | 40 | — | — | keep |
| `get_application_tailor_uploaded_source_readiness` | `instance-tools/applications.ts` | read | — | 58 | — | — | keep |
| `get_application_tailor_uploaded_sources` | `instance-tools/applications.ts` | read | — | 45 | — | — | keep |
| `list_applications` | `instance-tools/applications.ts` | read | — | 152 | — | — | keep |
| `request_application_reconciliation` | `instance-tools/applications.ts` | runtime | — | 60 | — | — | keep |
| `request_application_review` | `instance-tools/applications.ts` | runtime | — | 24 | — | — | keep |
| `resume_application` | `instance-tools/applications.ts` | runtime | — | 59 | — | — | keep |
| `retry_application` | `instance-tools/applications.ts` | runtime | — | 104 | — | y | keep |
| `set_application_runner_settings` | `instance-tools/applications.ts` | write | — | 112 | — | — | keep |
| `set_application_tailor_uploaded_source` | `instance-tools/applications.ts` | write | — | 59 | — | y | keep |
| `start_application_fill` | `instance-tools/applications.ts` | runtime | — | 38 | — | y | keep |
| `tailoring_run` | `instance-tools/applications.ts` | read | — | 107 | — | — | keep |
| `transfer_prepared_application` | `instance-tools/applications.ts` | runtime | — | 61 | — | — | keep |
| `triage_application` | `instance-tools/applications.ts` | write | — | 89 | — | — | keep |
| `apply_to_job` | `instance-tools/apply.ts` | destructive | apply | 116 | y | — | keep |
| `get_apply_tips` | `instance-tools/apply.ts` | read | apply | 21 | — | — | keep |
| `get_profile` | `instance-tools/apply.ts` | read | apply | 39 | — | — | keep |
| `upload_resume` | `instance-tools/apply.ts` | write | apply | 57 | — | — | keep |
| `call_instance_tool` | `instance-tools/base.ts` | runtime | — | 104 | y | y | keep — description rewritten (top-20) |
| `cancel_instance` | `instance-tools/base.ts` | destructive | — | 9 | — | — | keep — description under 20 words |
| `chat_with_instance` | `instance-tools/base.ts` | runtime | — | 20 | — | — | keep |
| `describe_instance` | `instance-tools/base.ts` | read | — | 75 | — | — | keep |
| `list_instance_tools` | `instance-tools/base.ts` | read | — | 476 | — | y | keep |
| `my_instances` | `instance-tools/base.ts` | read | — | 70 | — | y | keep |
| `pause_instance` | `instance-tools/base.ts` | write | — | 129 | — | y | keep |
| `resume_instance` | `instance-tools/base.ts` | write | — | 86 | — | y | keep |
| `set_instance_tool` | `instance-tools/base.ts` | write | — | 60 | — | y | keep |
| `subscribe_agent` | `instance-tools/base.ts` | write | — | 51 | — | y | keep |
| `ask_ticket` | `instance-tools/board.ts` | write | — | 103 | — | y | keep |
| `clear_finished_tasks` | `instance-tools/board.ts` | write | — | 55 | — | — | keep |
| `get_instance_board_config` | `instance-tools/board.ts` | read | — | 37 | — | y | keep |
| `hint_instance_task` | `instance-tools/board.ts` | write | — | 21 | y | — | keep |
| `instance_board` | `instance-tools/board.ts` | read | — | 197 | y | — | keep |
| `link_board_item_issue` | `instance-tools/board.ts` | write | — | 72 | — | y | keep |
| `promote_board_item` | `instance-tools/board.ts` | write | — | 79 | — | y | keep |
| `reorder_board_item` | `instance-tools/board.ts` | write | — | 122 | — | y | keep |
| `set_board_item_status` | `instance-tools/board.ts` | write | — | 23 | — | y | keep |
| `set_instance_board_config` | `instance-tools/board.ts` | write | — | 72 | — | — | keep |
| `sync_board_issues` | `instance-tools/board.ts` | write | — | 86 | — | — | keep |
| `task_action_log` | `instance-tools/board.ts` | read | — | 122 | — | y | keep |
| `ticket_thread` | `instance-tools/board.ts` | read | — | 51 | — | y | keep |
| `unlink_board_item_issue` | `instance-tools/board.ts` | write | — | 28 | — | y | keep |
| `update_board_ticket` | `instance-tools/board.ts` | write | — | 94 | — | y | keep |
| `browser_takeover_get` | `instance-tools/browser-verification.ts` | read | — | 24 | — | — | keep |
| `browser_takeover_list` | `instance-tools/browser-verification.ts` | read | — | 80 | — | — | keep |
| `browser_takeover_request` | `instance-tools/browser-verification.ts` | write | — | 75 | — | — | keep |
| `browser_takeover_transition` | `instance-tools/browser-verification.ts` | runtime | — | 86 | — | — | keep |
| `get_browser_screenshots` | `instance-tools/browser-verification.ts` | read | — | 74 | — | — | keep |
| `get_instance_browser_verification` | `instance-tools/browser-verification.ts` | read | — | 99 | — | y | keep |
| `job_lead_browser_verifications` | `instance-tools/browser-verification.ts` | read | — | 144 | — | y | keep |
| `job_lead_intake_url` | `instance-tools/browser-verification.ts` | write | — | 187 | — | — | keep |
| `list_eligible_browser_runtimes` | `instance-tools/browser-verification.ts` | read | — | 80 | — | — | keep |
| `set_browser_screenshots` | `instance-tools/browser-verification.ts` | write | — | 73 | — | — | keep |
| `set_instance_browser_verification` | `instance-tools/browser-verification.ts` | write | — | 70 | — | y | keep |
| `verify_job_lead_now` | `instance-tools/browser-verification.ts` | runtime | — | 71 | — | — | keep |
| `coder_questions` | `instance-tools/coder-brain.ts` | read | — | 52 | — | y | keep |
| `get_auto_pickup` | `instance-tools/coder-brain.ts` | read | — | 66 | — | y | keep |
| `po_triage_reports` | `instance-tools/coder-brain.ts` | read | — | 102 | — | — | keep |
| `set_auto_pickup` | `instance-tools/coder-brain.ts` | write | — | 166 | — | y | keep |
| `set_coder_brain` | `instance-tools/coder-brain.ts` | write | — | 230 | — | y | keep |
| `coding_loop_lifecycle` | `instance-tools/coding.ts` | read | — | 181 | — | y | keep |
| `coding_loop_queue` | `instance-tools/coding.ts` | read | — | 267 | — | y | keep |
| `coding_loop_queue_cancel` | `instance-tools/coding.ts` | write | — | 65 | — | y | keep |
| `coding_loop_queue_reorder` | `instance-tools/coding.ts` | write | — | 93 | — | y | keep |
| `coding_loop_start` | `instance-tools/coding.ts` | runtime | — | 700 | y | y | keep — survivor of the loop-start pair |
| `coding_loop_status` | `instance-tools/coding.ts` | read | — | 385 | — | y | keep — survivor of the loop-status pair |
| `coding_loop_stop` | `instance-tools/coding.ts` | write | — | 41 | — | y | keep — survivor of the loop-stop pair |
| `coding_loop_trace` | `instance-tools/coding.ts` | read | coding | 136 | — | y | keep |
| `coding_terminal` | `instance-tools/coding.ts` | read | coding | 190 | — | y | keep |
| `coding_timeline` | `instance-tools/coding.ts` | read | coding | 340 | — | y | keep |
| `system_status` | `instance-tools/coding.ts` | read | coding | 102 | — | — | merge → `coding_diagnostics` (same `/coding/diagnostics`) |
| `check_instance_loop` | `instance-tools/composition.ts` | read | — | 307 | — | y | merge → `coding_loop_status` (same `GET /loop`) |
| `continue_instance_run` | `instance-tools/composition.ts` | runtime | — | 226 | y | y | keep |
| `create_connection` | `instance-tools/composition.ts` | write | — | 40 | — | — | keep |
| `create_supervision` | `instance-tools/composition.ts` | write | — | 79 | — | y | keep |
| `delete_connection` | `instance-tools/composition.ts` | destructive | — | 59 | — | y | keep |
| `delete_supervision` | `instance-tools/composition.ts` | destructive | — | 41 | — | — | keep |
| `get_instance_loop_limits` | `instance-tools/composition.ts` | read | — | 130 | — | — | keep |
| `get_instance_loop_presets` | `instance-tools/composition.ts` | read | — | 59 | — | y | keep |
| `list_connection_deliveries` | `instance-tools/composition.ts` | read | — | 118 | — | — | keep |
| `list_connections` | `instance-tools/composition.ts` | read | — | 21 | y | — | keep |
| `list_supervision` | `instance-tools/composition.ts` | read | — | 19 | — | — | keep — description under 20 words |
| `preview_instance_run_continue` | `instance-tools/composition.ts` | read | — | 183 | — | y | keep |
| `replay_connection_delivery` | `instance-tools/composition.ts` | runtime | — | 99 | — | — | keep |
| `set_connection_enabled` | `instance-tools/composition.ts` | write | — | 69 | — | y | keep |
| `set_instance_loop_limits` | `instance-tools/composition.ts` | write | — | 135 | — | — | keep |
| `set_instance_loop_presets` | `instance-tools/composition.ts` | write | — | 104 | — | y | keep |
| `set_supervision_enabled` | `instance-tools/composition.ts` | write | — | 61 | — | y | keep |
| `start_instance_loop` | `instance-tools/composition.ts` | runtime | — | 37 | — | y | merge → `coding_loop_start` (same `POST /loop`) |
| `stop_instance_loop` | `instance-tools/composition.ts` | write | — | 37 | — | y | merge → `coding_loop_stop` (same `/loop/:run/cancel`) |
| `connector_status` | `instance-tools/connectors.ts` | read | — | 62 | — | — | keep |
| `delete_instance_connector_grant` | `instance-tools/connectors.ts` | destructive | — | 34 | — | y | keep |
| `get_instance_connector_account` | `instance-tools/connectors.ts` | read | — | 150 | y | y | keep |
| `grant_instance_connector_folder` | `instance-tools/connectors.ts` | write | — | 83 | — | y | keep |
| `import_instance_drive_file` | `instance-tools/connectors.ts` | write | — | 101 | — | y | keep |
| `import_instance_workdrive_file` | `instance-tools/connectors.ts` | write | — | 92 | — | y | keep |
| `list_connectors` | `instance-tools/connectors.ts` | read | — | 113 | — | y | keep |
| `list_instance_connector_consents` | `instance-tools/connectors.ts` | read | — | 84 | — | y | keep |
| `list_instance_connector_grants` | `instance-tools/connectors.ts` | read | — | 60 | — | — | keep |
| `list_instance_connectors` | `instance-tools/connectors.ts` | read | — | 86 | — | y | keep |
| `list_instance_drive_files` | `instance-tools/connectors.ts` | read | — | 95 | — | y | keep |
| `set_instance_connector_account` | `instance-tools/connectors.ts` | write | — | 127 | — | y | keep |
| `set_instance_connector_consent` | `instance-tools/connectors.ts` | write | — | 88 | — | y | keep |
| `sync_github_installations` | `instance-tools/connectors.ts` | write | — | 159 | y | — | keep |
| `get_console_link` | `instance-tools/console-link.ts` | read | — | 202 | y | — | keep |
| `list_instance_permission_requests` | `instance-tools/console-link.ts` | read | — | 117 | — | — | keep |
| `connect_discord_bot` | `instance-tools/discord.ts` | write | — | 89 | — | y | keep |
| `disconnect_discord_bot` | `instance-tools/discord.ts` | destructive | — | 37 | — | — | keep |
| `discord_bot_status` | `instance-tools/discord.ts` | read | — | 38 | — | — | keep |
| `grant_instance_discord_channel` | `instance-tools/discord.ts` | write | — | 77 | — | y | keep |
| `list_discord_channels` | `instance-tools/discord.ts` | read | — | 33 | — | y | keep |
| `list_discord_guilds` | `instance-tools/discord.ts` | read | — | 21 | — | — | keep |
| `list_instance_discord_grants` | `instance-tools/discord.ts` | read | — | 39 | — | y | keep |
| `revoke_instance_discord_grant` | `instance-tools/discord.ts` | destructive | — | 35 | — | y | keep |
| `gmail_scout_config_get` | `instance-tools/gmail-scout.ts` | read | — | 14 | — | — | keep — description under 20 words |
| `gmail_scout_config_set` | `instance-tools/gmail-scout.ts` | write | — | 23 | — | — | keep |
| `gmail_scout_reprocess` | `instance-tools/gmail-scout.ts` | write | — | 141 | — | y | keep |
| `gmail_scout_scan` | `instance-tools/gmail-scout.ts` | write | — | 113 | — | — | keep |
| `gmail_scout_status` | `instance-tools/gmail-scout.ts` | read | — | 39 | — | — | keep |
| `get_instance_connection_guide` | `instance-tools/guide.ts` | read | — | 88 | y | y | keep |
| `bind_http_profile` | `instance-tools/http-profiles.ts` | write | — | 39 | — | — | keep |
| `create_http_profile` | `instance-tools/http-profiles.ts` | write | — | 84 | — | y | keep |
| `delete_http_profile` | `instance-tools/http-profiles.ts` | destructive | — | 26 | — | y | keep |
| `get_http_profile` | `instance-tools/http-profiles.ts` | read | — | 12 | — | — | keep — description under 20 words |
| `list_http_profiles` | `instance-tools/http-profiles.ts` | read | — | 41 | — | — | keep |
| `list_instance_http_bindings` | `instance-tools/http-profiles.ts` | read | — | 38 | — | — | keep |
| `rotate_http_profile_secret` | `instance-tools/http-profiles.ts` | write | — | 29 | — | — | keep |
| `test_http_profile` | `instance-tools/http-profiles.ts` | read | — | 44 | — | — | keep |
| `unbind_http_profile` | `instance-tools/http-profiles.ts` | write | — | 22 | — | — | keep |
| `update_http_profile` | `instance-tools/http-profiles.ts` | write | — | 40 | — | y | keep |
| `add_instance_knowledge` | `instance-tools/knowledge.ts` | write | — | 16 | — | — | keep — description under 20 words |
| `delete_instance_file` | `instance-tools/knowledge.ts` | destructive | — | 20 | — | — | keep |
| `delete_instance_knowledge` | `instance-tools/knowledge.ts` | destructive | — | 9 | — | — | keep — description under 20 words |
| `delete_instance_memory` | `instance-tools/knowledge.ts` | destructive | — | 10 | — | — | keep — description under 20 words |
| `get_instance_memory` | `instance-tools/knowledge.ts` | read | — | 18 | — | — | keep — description under 20 words |
| `ingest_instance_knowledge_url` | `instance-tools/knowledge.ts` | write | — | 79 | — | — | keep |
| `list_instance_files` | `instance-tools/knowledge.ts` | read | — | 33 | — | y | keep |
| `list_instance_knowledge` | `instance-tools/knowledge.ts` | read | — | 9 | — | — | keep — description under 20 words |
| `search_instance_knowledge` | `instance-tools/knowledge.ts` | read | — | 35 | — | — | keep |
| `update_instance_knowledge` | `instance-tools/knowledge.ts` | write | — | 72 | — | y | keep |
| `upload_instance_file` | `instance-tools/knowledge.ts` | write | — | 42 | — | — | keep |
| `vector_stats` | `instance-tools/knowledge.ts` | read | — | 110 | — | y | keep |
| `write_instance_memory` | `instance-tools/knowledge.ts` | write | — | 23 | — | y | keep |
| `cancel_local_browser_run` | `instance-tools/local-browser.ts` | write | — | 36 | — | — | keep |
| `get_instance_local_browser_settings` | `instance-tools/local-browser.ts` | read | — | 198 | — | y | keep |
| `get_local_browser_consent` | `instance-tools/local-browser.ts` | read | — | 46 | — | — | keep |
| `list_local_browser_runs` | `instance-tools/local-browser.ts` | read | — | 180 | — | y | keep |
| `local_browser_preflight` | `instance-tools/local-browser.ts` | read | — | 74 | — | — | keep |
| `resume_local_browser_run` | `instance-tools/local-browser.ts` | runtime | — | 61 | — | y | keep |
| `review_local_browser_finding` | `instance-tools/local-browser.ts` | write | — | 78 | — | — | keep |
| `set_instance_local_browser_settings` | `instance-tools/local-browser.ts` | write | — | 82 | — | y | keep |
| `set_local_browser_consent` | `instance-tools/local-browser.ts` | write | — | 66 | — | y | keep |
| `start_local_browser_run` | `instance-tools/local-browser.ts` | runtime | — | 91 | — | y | keep |
| `actions_runner_setup` | `instance-tools/machine-control.ts` | runtime | — | 152 | — | y | keep |
| `actions_runner_status` | `instance-tools/machine-control.ts` | read | — | 40 | — | y | keep |
| `force_runner_attach` | `instance-tools/machine-control.ts` | runtime | — | 427 | y | y | keep |
| `get_machine_policy` | `instance-tools/machine-control.ts` | read | — | 123 | — | y | keep |
| `native_preflight` | `instance-tools/machine-control.ts` | read | — | 72 | — | — | keep |
| `runner_restart` | `instance-tools/machine-control.ts` | runtime | — | 213 | — | y | keep |
| `runner_update` | `instance-tools/machine-control.ts` | runtime | — | 303 | y | y | keep |
| `runner_update_status` | `instance-tools/machine-control.ts` | read | — | 136 | — | y | keep |
| `set_machine_policy` | `instance-tools/machine-control.ts` | write | — | 89 | — | y | keep |
| `answer_instance_mcp_input_request` | `instance-tools/mcp-connections.ts` | runtime | — | 112 | — | — | keep |
| `list_instance_mcp_grants` | `instance-tools/mcp-connections.ts` | read | — | 81 | — | y | keep |
| `list_instance_mcp_input_requests` | `instance-tools/mcp-connections.ts` | read | — | 75 | — | — | keep |
| `list_mcp_presets` | `instance-tools/mcp-connections.ts` | read | — | 62 | — | — | keep |
| `set_instance_mcp_grant` | `instance-tools/mcp-connections.ts` | write | — | 110 | — | — | keep |
| `test_instance_mcp_server` | `instance-tools/mcp-connections.ts` | runtime | — | 124 | — | — | keep |
| `admin_action_audit` | `instance-tools/observability.ts` | read | — | 105 | — | — | keep |
| `admin_mcp_audit` | `instance-tools/observability.ts` | read | — | 197 | — | y | keep |
| `agent_trace` | `instance-tools/observability.ts` | read | — | 263 | — | — | keep |
| `clear_instance_messages` | `instance-tools/observability.ts` | destructive | — | 17 | — | — | keep — description under 20 words |
| `delete_feedback` | `instance-tools/observability.ts` | destructive | — | 46 | — | y | keep |
| `delete_instance_message` | `instance-tools/observability.ts` | destructive | — | 49 | — | y | keep |
| `error_summary` | `instance-tools/observability.ts` | read | — | 209 | — | y | keep |
| `get_instance_pipeline` | `instance-tools/observability.ts` | read | — | 68 | — | — | keep |
| `instance_activity` | `instance-tools/observability.ts` | read | — | 31 | — | — | keep |
| `instance_messages` | `instance-tools/observability.ts` | read | — | 62 | — | — | keep |
| `list_errors` | `instance-tools/observability.ts` | read | — | 140 | — | — | keep |
| `list_feedback` | `instance-tools/observability.ts` | read | — | 80 | — | y | keep |
| `list_pipeline_runs` | `instance-tools/observability.ts` | read | — | 63 | — | — | keep |
| `record_instance_feedback` | `instance-tools/observability.ts` | write | — | 116 | — | y | keep |
| `resolve_feedback` | `instance-tools/observability.ts` | write | — | 75 | — | — | keep |
| `telemetry_health` | `instance-tools/observability.ts` | read | — | 111 | — | y | keep |
| `account_activity` | `instance-tools/recent.ts` | read | — | 186 | — | y | keep |
| `fleet_snapshot` | `instance-tools/recent.ts` | read | — | 222 | — | y | keep |
| `recent_instances` | `instance-tools/recent.ts` | read | — | 408 | — | y | keep |
| `set_instance_tags` | `instance-tools/recent.ts` | write | — | 53 | y | y | keep |
| `connect_slack_bot` | `instance-tools/release-notes.ts` | write | — | 86 | — | y | keep |
| `disconnect_slack_bot` | `instance-tools/release-notes.ts` | destructive | — | 32 | — | — | keep |
| `get_instance_release_notes` | `instance-tools/release-notes.ts` | read | — | 66 | — | y | keep |
| `grant_instance_slack_channel` | `instance-tools/release-notes.ts` | write | — | 79 | — | y | keep |
| `list_instance_slack_grants` | `instance-tools/release-notes.ts` | read | — | 22 | — | y | keep |
| `list_slack_channels` | `instance-tools/release-notes.ts` | read | — | 55 | — | y | keep |
| `revoke_instance_slack_grant` | `instance-tools/release-notes.ts` | destructive | — | 29 | — | y | keep |
| `send_test_release_note` | `instance-tools/release-notes.ts` | write | — | 77 | y | y | keep |
| `set_instance_release_notes` | `instance-tools/release-notes.ts` | write | — | 78 | — | y | keep |
| `slack_bot_status` | `instance-tools/release-notes.ts` | read | — | 49 | — | — | keep |
| `ingest_repo` | `instance-tools/repo.ts` | write | repo | 76 | — | — | keep |
| `ingest_repo_status` | `instance-tools/repo.ts` | read | repo | 25 | — | — | keep |
| `remove_repo` | `instance-tools/repo.ts` | destructive | repo | 25 | — | — | keep |
| `answer_instance_input` | `instance-tools/runtime.ts` | runtime | — | 267 | — | y | keep |
| `approve_instance_task` | `instance-tools/runtime.ts` | runtime | — | 39 | — | — | keep |
| `cancel_instance_task` | `instance-tools/runtime.ts` | destructive | — | 15 | — | — | keep — description under 20 words |
| `delete_instance_task` | `instance-tools/runtime.ts` | destructive | — | 71 | — | y | keep |
| `end_instance_takeover` | `instance-tools/runtime.ts` | runtime | — | 53 | — | y | keep |
| `forget_runner_node` | `instance-tools/runtime.ts` | destructive | — | 55 | — | y | keep |
| `get_instance_task` | `instance-tools/runtime.ts` | read | — | 72 | — | y | keep |
| `get_instance_terminal_session` | `instance-tools/runtime.ts` | read | — | 67 | — | — | keep |
| `instance_runner_node` | `instance-tools/runtime.ts` | read | — | 136 | — | — | keep |
| `instance_runtime_status` | `instance-tools/runtime.ts` | read | — | 75 | — | y | keep |
| `instance_task_events` | `instance-tools/runtime.ts` | read | — | 10 | — | — | keep — description under 20 words |
| `list_runner_nodes` | `instance-tools/runtime.ts` | read | — | 355 | — | y | keep |
| `register_instance_runtime` | `instance-tools/runtime.ts` | runtime | — | 21 | — | y | keep |
| `resume_instance_takeover` | `instance-tools/runtime.ts` | runtime | — | 49 | — | y | keep |
| `run_instance_task` | `instance-tools/runtime.ts` | runtime | — | 31 | — | — | keep |
| `runner_node_forget_preflight` | `instance-tools/runtime.ts` | read | — | 45 | — | y | keep |
| `runner_resource_history` | `instance-tools/runtime.ts` | read | — | 150 | y | y | keep |
| `runner_setup` | `instance-tools/runtime.ts` | read | — | 143 | y | y | keep |
| `send_instance_takeover_input` | `instance-tools/runtime.ts` | runtime | — | 83 | — | y | keep |
| `set_instance_runner_node` | `instance-tools/runtime.ts` | write | — | 361 | — | y | keep |
| `set_instance_terminal_session` | `instance-tools/runtime.ts` | write | — | 38 | — | — | keep |
| `start_instance_browser_task` | `instance-tools/runtime.ts` | destructive | — | 83 | — | y | keep |
| `unregister_instance_runtime` | `instance-tools/runtime.ts` | destructive | — | 11 | — | — | keep — description under 20 words |
| `secure_input_inject` | `instance-tools/secure-input.ts` | runtime | — | 203 | — | — | keep |
| `secure_input_request` | `instance-tools/secure-input.ts` | write | — | 101 | y | y | keep |
| `secure_input_status` | `instance-tools/secure-input.ts` | read | — | 80 | — | y | keep |
| `clear_instance_voice_settings` | `instance-tools/settings.ts` | write | — | 43 | — | y | keep |
| `get_agent_operator_manual` | `instance-tools/settings.ts` | read | — | 58 | — | y | keep |
| `get_agent_settings_schema` | `instance-tools/settings.ts` | read | — | 19 | — | — | keep — description under 20 words |
| `get_instance_behaviour_schema` | `instance-tools/settings.ts` | read | — | 40 | — | — | keep |
| `get_instance_instructions` | `instance-tools/settings.ts` | read | — | 25 | — | — | keep |
| `get_instance_notification_policy` | `instance-tools/settings.ts` | read | — | 132 | — | y | keep |
| `get_instance_operator_manual` | `instance-tools/settings.ts` | read | — | 212 | — | y | keep |
| `get_instance_settings` | `instance-tools/settings.ts` | read | — | 19 | y | — | keep — description under 20 words |
| `get_instance_state` | `instance-tools/settings.ts` | read | — | 154 | — | y | keep |
| `get_instance_voice_settings` | `instance-tools/settings.ts` | read | — | 84 | y | — | keep |
| `get_notification_vocabulary` | `instance-tools/settings.ts` | read | — | 73 | — | y | keep |
| `get_translation_config` | `instance-tools/settings.ts` | read | — | 15 | — | — | keep — description under 20 words |
| `rename_instance` | `instance-tools/settings.ts` | write | — | 24 | — | — | keep |
| `resync_instance_personality` | `instance-tools/settings.ts` | destructive | — | 78 | y | y | keep |
| `set_agent_operator_manual` | `instance-tools/settings.ts` | write | — | 68 | — | y | keep |
| `set_agent_settings_schema` | `instance-tools/settings.ts` | write | — | 21 | — | — | keep |
| `set_instance_instructions` | `instance-tools/settings.ts` | write | — | 14 | — | — | keep — description under 20 words |
| `set_instance_model` | `instance-tools/settings.ts` | write | — | 119 | — | — | keep |
| `set_instance_notification_policy` | `instance-tools/settings.ts` | write | — | 168 | y | — | keep |
| `set_instance_operator_manual` | `instance-tools/settings.ts` | write | — | 56 | — | y | keep |
| `set_instance_settings` | `instance-tools/settings.ts` | write | — | 22 | — | — | keep |
| `set_instance_voice_settings` | `instance-tools/settings.ts` | write | — | 80 | — | y | keep |
| `set_translation_config` | `instance-tools/settings.ts` | write | — | 11 | — | — | keep — description under 20 words |
| `get_agent_stats_schema` | `instance-tools/stats.ts` | read | — | 20 | — | — | keep |
| `get_instance_stats` | `instance-tools/stats.ts` | read | — | 68 | — | — | keep |
| `list_stats_sources` | `instance-tools/stats.ts` | read | — | 39 | — | y | keep |
| `set_agent_stats_schema` | `instance-tools/stats.ts` | write | — | 61 | — | — | keep |
| `set_instance_stats` | `instance-tools/stats.ts` | write | — | 69 | — | — | keep |
| `create_instance_trigger` | `instance-tools/triggers.ts` | write | — | 58 | y | — | keep |
| `delete_instance_trigger` | `instance-tools/triggers.ts` | destructive | — | 14 | — | — | keep — description under 20 words |
| `list_instance_trigger_events` | `instance-tools/triggers.ts` | read | — | 12 | — | — | keep — description under 20 words |
| `list_instance_triggers` | `instance-tools/triggers.ts` | read | — | 12 | — | — | keep — description under 20 words |
| `list_trigger_actions` | `instance-tools/triggers.ts` | read | — | 65 | — | y | keep |
| `preview_instance_trigger` | `instance-tools/triggers.ts` | read | — | 98 | — | — | keep |
| `run_instance_trigger` | `instance-tools/triggers.ts` | runtime | — | 19 | — | — | keep — description under 20 words |
| `set_instance_trigger` | `instance-tools/triggers.ts` | write | — | 103 | — | y | keep |
| `agent_activity` | `storage-tools.ts` | read | — | 13 | — | — | keep — description rewritten (top-20) |
| `create_collection` | `storage-tools.ts` | write | — | 14 | — | — | keep — description rewritten (top-20) |
| `create_instance_ticket` | `storage-tools.ts` | write | — | 54 | — | — | keep |
| `insert_instance_record` | `storage-tools.ts` | write | — | 18 | — | — | keep — description under 20 words |
| `insert_record` | `storage-tools.ts` | write | — | 7 | — | — | keep — description rewritten (top-20) |
| `list_agent_files` | `storage-tools.ts` | read | — | 9 | — | — | keep — description under 20 words |
| `list_collections` | `storage-tools.ts` | read | — | 13 | — | — | keep — description rewritten (top-20) |
| `list_instance_collections` | `storage-tools.ts` | read | — | 16 | — | — | keep — description under 20 words |
| `query_instance_records` | `storage-tools.ts` | read | — | 17 | — | — | keep — description under 20 words |
| `query_records` | `storage-tools.ts` | read | — | 11 | — | — | keep — description rewritten (top-20) |
| `search_agent_knowledge` | `storage-tools.ts` | read | — | 11 | — | — | keep — description under 20 words |
| `triage_job_lead` | `storage-tools.ts` | write | — | 76 | — | — | keep |
| `update_instance_record` | `storage-tools.ts` | write | — | 82 | — | y | keep |
| `update_record` | `storage-tools.ts` | write | — | 6 | — | — | keep — description rewritten (top-20) |
| `upload_agent_file` | `storage-tools.ts` | write | — | 25 | — | — | keep |
| `mcp_server_info` | `tools/server-info.ts` | read | — | 38 | — | — | keep |

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

- **Consolidation (#1243)**: retire the four §4 pairs, decide removals from the `summarize`
  data, give the remaining short descriptions the conventions template, refresh the quick start
  (#1241 B.7), record the tried name for `unknown_tool`, and make refusals say what to do next.
- **Agent eval (#1244)**: a model is given owner-shaped tasks drawn from §6, calls tools through a
  real client, and is scored on first-call success, with a baseline. That is the acceptance measure
  this document's proxies stand in for.
- **Label guidance (#1245)**: surface the label vocabulary in the tools that set labels.
- **commit-close-watch noise (#1246)**: about 40k of 46k error-log rows in 30 days (§3.3).

## 8. Guards added by this audit

- **Tool-count ceiling** (`TOOL_COUNT_CEILINGS` in `workers/mcp/src/tool-count.ts`, tested in
  `tool-count.test.ts`): the surface may not grow past the latest ceiling, and each raise is an
  appended entry with a reason and an issue. Appending is the only way to grow, so a new tool is a
  recorded decision.
- The actionable-error, alias and coercion behaviour is pinned by `argument-normalize.test.ts`,
  through a real server and client.
