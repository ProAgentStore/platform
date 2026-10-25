/** Per-scope MCP surface audit counts, separated from per-tool annotations (#996). */
import type { McpScope } from "./safety.js";

/** How the surface splits. A ratchet in BOTH directions: silently losing a read-only
 *  annotation is as much a regression as silently gaining one. */
export const MCP_RISK_COUNTS: Record<McpScope, number> = {
	// +1 runtime at #1010: an owner-scoped receipt dispatches one exact reviewed material set to
	// their Runner in review-only mode. It drives a machine but cannot submit or enable an edge.
	// +2 read, +1 write at #671: `list_runner_nodes` and `instance_runner_node` read machine
	// placement, `set_instance_runner_node` writes the pin. The write is `write` and not `runtime`
	// deliberately — it changes where calls are ROUTED without itself driving anything on the
	// machine, so it does not belong in the scope that means "this spends something out there".
	// +1 runtime at #696: `coding_session_open`, the opener that lets #408's continuity be
	// reached from MCP at all. `runtime` and not `write` because it starts a CLI process on
	// somebody's laptop — the distinction the two classes exist to make.
	// +1 read at #699: `coding_terminal`, which reads stored `coding_timeline` rows and asks no
	// runner anything — the pane it returns is the one D1 already holds, not a fresh capture.
	// +2 write at #667: `set_connection_enabled` and `set_supervision_enabled` — the pause that
	// `agent_connections.enabled` (#644) and `agent_supervision.enabled` (#664) each got a writer
	// and a route for and no tool. `write` rather than `destructive` on purpose: this IS the
	// reversible form of the delete beside it, and classing a pause as destructive would put it
	// behind the scope a default connection never holds — i.e. would leave the gap open.
	// +1 read at #683: `coding_instance_deploy_status`, which reads GitHub Actions workflow runs
	// for a coding instance's registered repo. Uses the MCP worker's `GITHUB_TOKEN`, gated by
	// the `read` scope so `MCP_READ_ONLY` blocks it correctly.
	// +1 read at #767: `coding_loop_trace`, the run-id-addressable live feed for a loop run. It
	// reads stored timeline rows and runner state through the API, and is surface-gated to coding.
	// +1 read, +1 write at #739: `get_instance_operator_manual` reads the caller-facing
	// operator manual (no scope gate, i.e. "none" in the contract table, same as the
	// symmetric `get_instance_instructions`) and `set_instance_operator_manual` writes it
	// (`write`). `read` count moves because MCP_RISK_COUNTS tracks the annotation — the tool
	// itself has no `requirePermission` scope gate (ungated reads are "read" annotated).
	// +1 read at #772: `get_instance_connection_guide`, which renders the per-instance
	// connection guide from live state. Reads only — the whole document is derived and the
	// route writes nothing, which is the property #739 Decision 4 makes load-bearing.
	// +1 read at #787: `recent_instances`, which joins the session's own touch record against
	// the roster and each instance's run list. Three GETs and nothing written — the recording
	// half lives in the registration pipeline, not in this tool.
	// +1 read, +1 write at #788: `coding_loop_queue` reads the objectives parked behind an
	// instance's current run, and `coding_loop_queue_cancel` withdraws one before it starts.
	// `write` and not `destructive` for the cancel, on the same reasoning as the enabled/disabled
	// pair above: withdrawing a queued objective stops work that has not begun and destroys
	// nothing — the run it would have become does not exist yet.
	// +1 destructive at #692: `coding_repo_remove`, the counterpart `coding_repo_add` never had.
	// The surface could attach a repo to a coding instance and not detach one, so a binding added in
	// error — a GitHub org the owner does not own, a local workdir that no longer exists — could only
	// be cleaned up in the console. `destructive` rather than `write` because the removal ends any
	// active engine on that repo; see its entry above.
	// +2 read, +3 write at #613 (notifications and account preferences): `list_notifications` and
	// `get_account_preferences` read the account's bell feed and preferences blob;
	// `mark_notification_read`, `mark_all_notifications_read` and `set_account_preferences` write.
	// `write` and not `destructive` for mark-all, though it has no undo: it flips read-state on rows
	// that stay in the feed, and deletes or answers nothing — an `alert` it marks read still needs you.
	// +3 write at #613 (knowledge writes): `update_instance_knowledge` edits a document in place,
	// `ingest_instance_knowledge_url` adds one from a fetched page, `update_instance_record` merges
	// fields into one record. `write` and not `destructive` for both edits: each keeps the object and
	// its id, and an edit can be edited back — the destructive pair (`delete_instance_knowledge`, and
	// deleting a record) stays console-only or confirm-gated as before.
	// +1 read, +1 write at #613 (loop presets): `get_instance_loop_presets` reads the objectives the
	// loop form offers and `set_instance_loop_presets` replaces the instance's own list. `write` and
	// not `runtime`: saving an objective starts nothing — `start_instance_loop` is the call that does.
	// Not `destructive` either, though it replaces a list: the prior list is readable first with the
	// get tool or `dry_run`, and writable back, as with the other instance-config setters.
	// +1 write, +1 destructive at #613 (product feedback): `record_instance_feedback` files a row
	// (`write` — additive, and dismissable with `resolve_feedback`), `delete_feedback` hard-deletes
	// one. `destructive` for the delete: no undo, and the row's snapshot outlives the transcript and
	// the trace, so it may be the only record of what the owner said.
	// +1 read, +1 write at #736 (item b): `get_instance_connector_account` reads which of the owner's
	// accounts an instance resolves to on a multi-account connector, and `set_instance_connector_account`
	// pins it to one. `write` and not `destructive`: it only chooses among credentials already connected
	// (it can never connect or disconnect one, #355), the prior pin is readable first, and it refuses to
	// clear a pin — the one move that would leave the instance refusing every call.
	// +1 read, +2 write at #613 (voice settings): `get_instance_voice_settings` reads the resolved
	// voice block, `set_instance_voice_settings` customises it for one agent and
	// `clear_instance_voice_settings` drops that customisation so the account default applies again.
	// `write` and not `destructive` for the clear, on the same reasoning as the other "use my
	// defaults" setters: it removes a per-agent override, never the account preferences underneath,
	// and the values it drops are readable first with the get tool or `dry_run`.
	// +1 read, +4 runtime, +2 destructive at #613 (a run's detail view and its handoffs):
	// `get_instance_task` reads one ticket; `answer_instance_input`, `resume_instance_takeover`,
	// `end_instance_takeover` and `send_instance_takeover_input` each drive a live run on
	// somebody's machine, which is what `runtime` means; `delete_instance_task` removes the card
	// AND stops the task, and `start_instance_browser_task` can be allowed to commit.
	// `start_instance_browser_task` is annotated `destructive` for the same reason `apply_to_job`
	// is: the annotation describes the tool a host caches, and the tool CAN commit. Its runtime
	// gate is the lighter one when `commit` is false, decided per call.
	// +4 read, +1 write at #613 (trigger and connector metadata): `list_connectors` and
	// `list_instance_connectors` answer what exists and what THIS agent may use;
	// `list_trigger_actions` and `preview_instance_trigger` are what the console's trigger form
	// is built from, so `create_instance_trigger` stops being a blind write.
	// `preview_instance_trigger` is `read` although its route is a POST — the verb carries a
	// draft config, and the route computes and returns without writing. The annotation describes
	// the EFFECT a host should expect, not the HTTP method, and calling it a write would tell a
	// read-only session it cannot check a trigger it is allowed to read.
	// `set_instance_connector_consent` is `write` on the same reasoning as `set_instance_tool`:
	// it changes what an agent is PERMITTED to do, so a read-only session must not widen it.
	// +3 read, +1 write, +2 runtime at #613 (outbound MCP connections — PAGS as an MCP client):
	// `list_mcp_presets`, `list_instance_mcp_grants` and `list_instance_mcp_input_requests` read;
	// `set_instance_mcp_grant` grants one remote tool on one endpoint (`write`, the same class as
	// the connector consent beside it). The two `runtime` ones each reach a THIRD PARTY:
	// `test_instance_mcp_server` contacts the endpoint (and is strictly rate-limited for the SSRF
	// reason its route documents), and `answer_instance_mcp_input_request` retries the paused
	// remote call with the owner's values — sending data off this platform is exactly what
	// `runtime` is for, and neither belongs in a read-only session.
	// +1 read, +1 runtime, +1 destructive at #613 (the pump's failure path):
	// `list_connection_deliveries` reads the outbox, `replay_connection_delivery` re-arms a dead
	// one and `delete_connection` ends an edge. The replay is `runtime` and not `write` because
	// re-arming makes the CONSUMER run — idempotency stops a replay duplicating work already
	// done, but work that never happened now happens, out there, on someone's quota. The delete
	// is `destructive` and confirm-gated because it takes the edge's routing filter and target
	// pipeline with it and orphans the outbox rows that record what was stuck; the reversible
	// form of the same intent is `set_connection_enabled`, which stays `write`.
	// +1 read, +2 write, +1 destructive at #613 (standing agent tasks): the agent's OWN task
	// store — DO state rendered into its prompt, not the runtime board. `create_agent_task` and
	// `update_agent_task` are `write` and not `runtime` because nothing RUNS: they change what
	// the agent carries into its next turn. `delete_agent_task` is `destructive` + confirm on
	// the same footing as `delete_instance_memory` — durable DO state that shapes the prompt and
	// cannot be recovered by re-reading; the retiring-without-losing form is an update to
	// `status: complete`.
	// +1 read, +1 write at #820 (per-instance iteration bounds): `get_instance_loop_limits` reads
	// the floor and ceiling a run is clamped into and `set_instance_loop_limits` configures them.
	// `write` and not `runtime`, on the same reading as the loop presets above: setting a bound
	// starts nothing — `start_instance_loop` is still the call that spends anything. Not
	// `destructive` either, though clearing both bounds discards a configuration: the prior values
	// are readable first with the get tool or `dry_run`, and writable straight back.
	// +1 read, +2 write at #613 (file-connector reads and imports): `list_instance_drive_files`
	// browses a granted Drive folder; `import_instance_drive_file` and
	// `import_instance_workdrive_file` copy ONE file into the instance knowledge base. `write` and
	// not `runtime`: the fetch happens server-side inside a grant the owner already made, and
	// drives no machine. Not `destructive` either — an import ADDS a document, and the document it
	// adds is removable with `delete_instance_knowledge`.
	// +1 read at #815: `account_activity` — the whole account's health in one call, where
	// `recent_instances` fans out per instance and is capped for it. Read, and ungated beyond that:
	// it answers only about instances the caller owns, and both its queries are `user_id`-scoped.
	// +1 read at #823: `error_summary` — the durable error log GROUPED by signature, beside
	// `list_errors`. Read for the same reasons: the query is `user_id`-scoped, there is no
	// `scope=all` on it, and grouping rows the caller can already fetch one by one adds no reach.
	// +1 read at #806: `preview_instance_run_continue` — what a continue would carry forward. READ
	// rather than `runtime` even though it sits beside `continue_instance_run`: it starts nothing
	// and opens no budget, and classing it with the tool it describes would make reading before
	// acting cost the scope of acting — which is the opposite of what a review surface is for.
	// +6 read at #613 (agent-template authoring, read half): `my_agent`,
	// `get_agent_capabilities`, `get_agent_state`, `get_agent_memory`, `agent_messages`,
	// `export_agent`. All READ — every one of the six routes is owner-scoped server-side and none
	// of them writes. `export_agent` is a read in particular: it composes a backup blob out of
	// state + knowledge + memory and stores nothing, so the word "export" is about the SHAPE of
	// the answer rather than about an effect.
	// +1 read, +1 write at #792: `coding_engine_get` / `coding_engine_set` — the instance's standing
	// choice of coding CLI and model. `write` for the set, not `runtime`: it starts nothing and spends
	// nothing — it edits which command the NEXT session launches, the same state the console's CLI
	// engines panel writes — and a session already running is untouched.
	// +4 read, +1 destructive at #613 (the remaining assorted group): the creator and subscriber
	// dashboards, the closed stats-source vocabulary and the behaviour field table are all reads;
	// `delete_instance_message` removes a whole durable turn (and any attached voice audio), so it is
	// destructive, confirmed and dry-runnable. Translation and arbitrary system-message persistence
	// stay excluded: the former is the console's AI gloss cache, the latter a prompt/provenance channel.
	// +2 read, +1 write, +1 destructive at #613: terminal-session is saved per-instance UI state;
	// forgetting a node has a blocker-rich read preflight and a separately confirmed delete.
	// +1 destructive at #496/#613: `resync_instance_personality` overwrites a durable prompt field
	// from the template seed. It is confirmed and dry-runnable; its audit keeps the prompt text out.
	// +1 read at #198: `platform_health`, the read-only diagnostic — every verdict in it is derived
	// from public probes and this session's own latency ring; nothing is written.
	// +1 read at #868: `runner_setup`, the local runner setup checklist — derived from recorded state.
	// +1 read at #904: mcp_server_info reads local server and catalog metadata.
	// +1 read at #906: `secure_input_status` — metadata-only check of secret request status.
	// +1 read at #938: `get_console_link` — builds a URL to a page the caller already owns; writes nothing.
	// +3 read at #945: `local_browser_preflight`, `get_instance_local_browser_settings`,
	// `list_local_browser_runs` — owner-scoped reads of settings, readiness and a run's redacted trace.
	// +1 read at #946: `get_local_browser_consent` — the owner's live site and profile decisions.
	// +1 read at #924: `runner_resource_history` — a machine's stored resource samples.
	// +1 write at #955: `triage_job_lead` is the sole explicit human decision boundary that
	// can hand a Scout lead to another agent; its Apply path changes durable state and emits an
	// application request, while skip/defer/archive only change the lead lifecycle.
	// +1 read at #961: `fleet_snapshot` — every tagged instance's derived status in one call; every
	// query in it is `user_id`-scoped and its GitHub reads are the ones github_list_issues makes.
	// +3 read at #958: `list_applications`, `get_application`, `application_trace` — the owner's
	// application queue, one item and its correlated trace; handles and verdicts, never content.
	// +1 read at #953: `get_application_runner_settings` — the Runner's submission policy.
	// +4 read at #971: `application_runs`, `application_run`, `application_run_supervision` and
	// `tailoring_run` — live run visibility for the apply pipeline, the counterpart of
	// `coding_session_capture`/`coding_timeline`. Two of them pull the owner's machine before
	// answering, which is a READ of a run the owner already started: no run is created, resumed or
	// continued, nothing is dispatched, and nothing external is touched. They carry policy
	// verdicts, pause reasons, event classes and artifact handles — never résumé text, typed form
	// values or page content.
	// +2 read, +1 write at #992: `get_instance_notification_policy` reads one instance's rules
	// and the RESOLVED effective state per channel, `get_notification_vocabulary` reads the
	// types/events/channels a rule may name, and `set_instance_notification_policy` replaces that
	// instance's rules. The write is `write` and not `destructive`: it is reversible by sending
	// the old list back, and "restore inherited" is a first-class call that removes the override.
	// +2 read at #1004: uploaded Tailor source selection and readiness are owner-scoped
	// inspections. They return provenance/status only, never résumé content.
	// +2 at #1013: bounded application handoff and reconciliation projections are secret-safe reads.
	// +1 read at #1027: po_triage_reports reads the coder brain switch, its triggers and the triage reports.
	// +1 read at #1025: coder_questions reads the questions a coder's runs stopped on and their audit trail.
	read: 186, // +1 at #1348: list_release_note_deliveries reads the owner-visible release-note delivery trail. // +1 at #1318: get_instance_auto_resume reads whether an instance continues credit-stopped runs automatically; nothing is changed or carried. +2 at #1312: get_machine_capabilities reads a machine's stored capability record and its change history, and check_capability_requirements runs the start gate's requirement check against it (a GET that only reads); neither starts anything, writes anything or carries a credential. +2 at #1313: calendar_connection_status reads whether Google Calendar is connected and works (a live token check, never returned) and list_instance_calendar_grants reads one instance's granted calendars; neither carries a credential. +2 at #1268: approval_status reads where a held account change stands (diff, expiry, audit, result) and get_approval_gate reads the gate's settings; neither decides anything and neither carries a credential. +1 at #1279: get_instance_gmail_identity reads an instance's pinned Gmail sender and inbound scope, the account's send-as aliases and named blockers; no credential. +1 at #1277: get_instance_email_worker reads a worker-backed mail connection's state, identities, health, consent mode and named blockers; it contains no credential. +1 at #1275: get_machine_thresholds reads a machine's admission thresholds, where each came from and the gate verdict; it changes nothing. +1 at #1267: list_instance_mcp_accounts reads which of the owner's accounts an instance resolves to on one MCP endpoint — the generic connector's counterpart to get_instance_connector_account, keyed on an endpoint rather than a fixed connector id. +1 at #1247: gmail_scout_scan_log reads one scan's per-email decisions (metadata and snippets, owner-only). +1 at #1237: get_agent_operator_manual reads a template's inherited operator manual. +1 at #1233: get_auto_pickup reads brain-free auto-pickup and its last decisions. +1 at #1208: actions_runner_status reads the Actions runners on an agent's machine. +4 at #1217: get_instance_release_notes, slack_bot_status, list_slack_channels and list_instance_slack_grants read the setting, the bot identity and grants, never the token. +4 at #1132: discord_bot_status, list_discord_guilds, list_discord_channels and list_instance_discord_grants read the bot identity and grants, never the token. +4 at #1123: list_http_profiles, get_http_profile, test_http_profile (a storage check, no network) and list_instance_http_bindings read profile metadata, never a secret. +1 at #1108: task_action_log reads one board card's action log; it writes nothing. +2 at #1090: admin_mcp_audit and admin_action_audit read the cross-owner MCP ledger and the admin-action log; admin-only at the API, they write nothing. +1 at #1084: telemetry_health reads per-sink telemetry delivery (pending, dead, lost, last drain); admin-only at the API, it writes nothing. +1 at #1064: get_browser_screenshots reads the owner's screenshot switch. +1 at #1057: native_preflight reads a machine's native-control readiness (permissions, Maestro, devices); it drives and installs nothing. +1 at #1040: usage_drivers reads spend drivers and a baseline-versus-current comparison; it changes nothing. +1 at #1030: job_lead_browser_verifications reads the lead verification queue and its receipts. +2 at #1031: browser_takeover_list / browser_takeover_get read the durable takeover records. +2 at #1031: get_instance_browser_verification and list_eligible_browser_runtimes read settings and live eligibility. +1 at #1009: list_instance_permission_requests reads the owner's own recovery requests and their verified links; it decides nothing. +1 at #1017: coding_loop_lifecycle reads an objective's transition history; it replays nothing.
	// +2 write at #825: `pause_instance` / `resume_instance`. `write` rather than `destructive` —
	// nothing is deleted and nothing is unsubscribed, and classing the OFF switch as destructive
	// would put RESUME behind a scope the caller may not hold, which is the wrong failure mode for
	// a safety toggle (the reasoning `set_instance_connector_consent` already records). Not `read`
	// either: switching an agent off is a real change.
	// +1 write at #906: `secure_input_request`, agent creates a secure input request for a secret.
	// +2 write at #1004: select or clear one owner-scoped uploaded Tailor source slot;
	// both are reversible, so they are write rather than destructive.
	// +1 at #1004: upload_instance_file is owner-scoped instance storage, not an external fetch.
	// +1 write at #1027: set_coder_brain turns the coder brain and its product-owner triage on or off. `write`, not
	// `destructive`: off disables the triage triggers and deletes nothing; on again restores them.
	write: 128, // +1 at #1142: coding_repo_mirror starts background clones of one repo on the instance's connected machines; it adds checkouts and removes nothing. // +1 at #1348: retry_release_note_delivery re-queues one FAILED release note, rechecking the gate first. // +1 at #1318: set_instance_auto_resume turns automatic continuing of credit-stopped runs on or off for one instance - reversible owner configuration; it starts nothing itself. +1 at #1313: grant_instance_calendar grants one Google calendar (verified against Google first) to an instance - reversible owner state, read-only reach. +1 at #1268: set_approval_gate changes the account's approval gate - reversible owner configuration; weakening an enabled gate is itself held for the owner's approval, so the tool cannot lower its own protection. +1 at #1279: set_instance_gmail_identity pins a verified send-as sender and inbound recipient scope (or clears them) - reversible owner configuration; it sends and reads no mail, takes no credential and cannot change the write consent that gates sends. +5 at #1277: begin/complete_email_worker_enrollment (a secure-input handoff; the bridge secret is typed by the owner in the console and consumed server-side, never carried by a tool), test_email_worker_connection (a health probe with the stored credential), set_instance_email_worker_account (a pin) and set_email_worker_identities (narrows approved senders) - reversible owner configuration; none sends or reads mail or changes the write consent that gates sends. +2 at #1275: set_machine_thresholds and reset_machine_thresholds change or remove a machine's admission thresholds - reversible platform settings that apply from the next heartbeat, never touch a running session and delete nothing (the removed overrides are returned as `before`). +1 at #1267: set_instance_mcp_account pins an instance to one connected account on an MCP endpoint, choosing only among accounts already connected (same reasoning as set_instance_connector_account) — never destructive: the prior pin is readable first with list_instance_mcp_accounts or dry_run, and an empty account_id only clears the pin, it connects or disconnects nothing. +1 at #1237: set_agent_operator_manual replaces a template's operator manual — reversible owner text, deletes nothing. +1 at #1233: set_auto_pickup turns brain-free auto-pickup on or off and sets its label rules; reversible owner state that deletes nothing. +4 at #1217: set_instance_release_notes and send_test_release_note (a test note to one channel the owner granted), connect_slack_bot (a Slack-verified bot token) and grant_instance_slack_channel — reversible owner state. +2 at #1132: connect_discord_bot stores a Discord-verified bot token (a rotation keeps grants only for the same bot) and grant_instance_discord_channel grants one channel — reversible owner state. +5 at #1123: create_http_profile, update_http_profile, rotate_http_profile_secret, bind_http_profile and unbind_http_profile — reversible owner state; a rotation replaces a secret the owner supplies. +2 at #1097: reorder_board_item places a card in its column and coding_loop_queue_reorder moves a queued objective; both decide only what starts first, start nothing and delete nothing. +1 at #1081: sync_github_installations binds GitHub App installations the account controls, through the install callback's own membership proof; it never weakens a check or stores a token. +1 at #1073: assert_application_not_submitted records the owner's assertion that an uncertain submit sent nothing; it fills, retries and sends nothing itself. +1 at #1064: set_browser_screenshots turns replay capture on or off for future runs; it deletes nothing. +1 at #1056: job_lead_intake_url adds one owner-chosen posting as a lead awaiting browser verification; additive, idempotent, never a handoff. +1 at #1052: gmail_scout_reprocess reads selected or windowed historical job mail into private Scout leads; additive, never moves the cursor. +1 at #1031: browser_takeover_request records a takeover request and notifies the owner. +1 at #1031: set_instance_browser_verification turns a declared local browser on for one instance. +1 at #1012: retarget_repository_binding moves an idle binding's coordinate in place; it refuses live work and never drives a runner.
	// +1 runtime at #806: `continue_instance_run`. `runtime` rather than `write` for the reason
	// `start_instance_loop` is — it starts an autonomous run that spends on its own — and the
	// two must agree, because a caller holding the scope to start one holding a narrower one to
	// continue it would be a distinction the route itself does not make.
	// +1 runtime at #856: `force_runner_attach`, the remote `pags up --force` for one agent. `runtime`,
	// not `write`: unlike the pin it acts ON the machine — a socket is closed and a runner reconnects.
	// +1 runtime at #859: `runner_update`, a remote CLI update + restart — it acts ON the machine.
	// +1 runtime at #879: `apply_account_coding_default` restarts reachable idle coder sessions
	// so they launch with the account default engine. It is account-scoped state applied to machines.
	// +1 runtime at #881: `coding_engine_reauth`, the remote engine sign-in. `runtime`, not `write`:
	// it opens a terminal on the machine and drives the engine's login CLI there.
	// +1 runtime at #906: `secure_input_inject`, injects a secret to tmux/env/stdin on the runner machine.
	// -1 runtime at #942: `coding_overseer`, retired with the legacy Coder's cross-repo Overseer route.
	// +2 runtime at #944: `start_local_browser_run` / `resume_local_browser_run` — a CLI researching in a
	// browser on the owner's machine; runtime for the reason `coding_loop_start` is.
	// +5 runtime at #958: generate_application_materials, start_application_fill, request_application_review,
	// retry_application, resume_application — each starts or continues a run on the owner's machine.
	runtime: 43, // +1 at #1156: coding_engine_install installs a coding CLI on the owner's machine with the vendor's own installer. // +1 at #1209: actions_runner_setup installs or removes the Actions runner service on the owner's machine. +1 at #1030: verify_job_lead_now starts a browser run on the owner's machine. +1 at #1031: browser_takeover_transition — resuming hands a paused run or runner task back to the machine. +1 at #1032: runner_restart restarts a machine's runner remotely, like runner_update. +2 at #1013: request the exact Runner's bounded handoff or read-only reconciliation.
	// +1 read, +8 destructive at #613 (agent-template authoring, write half): builder planning
	// only computes a proposal; the other eight can delete, overwrite, run a billable template
	// turn, create an enduring version, or create/scaffold a template. They all require the
	// destructive scope, an exact confirm and a no-network dry run, because this is the creator's
	// shared source template rather than a caller-private instance.
	// +1 at #973: `approve_application`. Destructive by this file's own rule — it authorizes a
	// submission to an employer, which cannot be recalled, the same reason `apply_to_job` is.
	// +1 at #1123: `delete_http_profile` drops an encrypted secret and every binding to it; not recoverable.
	// +2 at #1132: `disconnect_discord_bot` drops the token and every Discord grant; `revoke_instance_discord_grant` cuts an agent off a channel.
	// +2 at #1217: `disconnect_slack_bot` drops the Slack token and every Slack grant; `revoke_instance_slack_grant` cuts an instance off a channel.
	// +1 at #1313: `revoke_instance_calendar_grant` cuts an agent off a Google calendar.
	destructive: 39, // +1 at #1348: reconcile_release_note_delivery settles an uncertain send and can duplicate an announcement.
};
