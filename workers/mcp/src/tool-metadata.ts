/**
 * What the server publishes ABOUT a tool, as opposed to what the tool does.
 *
 * Everything here is advisory metadata read by the calling host and model. None of it is a
 * check: `safety.ts` remains the only thing that decides whether a call runs. Nothing in
 * this module may ever be imported by a handler or by the safety layer — `index.test.ts`
 * fails the build if it is.
 */
import { z } from "zod";
import { DIRECT_BEFORE_RUN, NESTED_TOOL_SEQUENCE } from "./instance-tool-guidance.js";
import type { McpScope } from "./safety.js";

/**
 * Sent once, in the `initialize` response, and read by the host alongside every tool's own
 * description. Until #561 the second `McpServer` constructor argument was absent, so this
 * server said NOTHING about itself: 135 tools with no ordering between them, and no way for
 * a model to learn that almost every tool needs an instance id it can only get from
 * `my_instances`.
 *
 * OpenAI's guidance: "Use server instructions for guidance that applies across tools, such
 * as required tool sequences … Keep the most important details in the first 512 characters."
 * So the sequence comes first and the safety vocabulary second — a caller that reads no
 * further than the cut still learns the order it has to call things in.
 *
 * The second sentence is the OTHER required sequence (#743). This surface is the management
 * layer; an instance's own connector tools are one level down, and nothing told a caller they
 * existed. Measured 2026-08-23: an external client asked to triage a repo's issues, concluded it
 * had "no GitHub connector", and drove the owner's CLI to shell out for `gh issue list` — while
 * `github_list_issues` was declared, consented and callable on that instance through
 * `call_instance_tool`. It then advised the owner to configure a connector that was already
 * working. That is a routing failure, not a model error: no string on this surface named the
 * pattern. `platform_guide` carries the same rule for the population whose `tools/list` is
 * cached (#703); this is the copy every client reads at `initialize`.
 *
 * `index.test.ts` asserts `my_instances` still falls inside the first 512 characters, so an
 * addition goes AFTER the id-first sentence, never before it.
 */
export const SERVER_INSTRUCTIONS = [
	"ProAgentStore hosts server-side AI agents. Almost every tool acts on ONE agent instance, so start by getting an id: my_instances lists the ones the connected user already runs, recent_instances the few they drove most recently with each one's live run health; list_agents is the public catalogue and subscribe_agent creates an instance from it.",
	"Before calling a tool, read its input schema from tools/list and send exactly those snake_case parameter names. IDs, task IDs, session IDs, job keys, node names and cursors are opaque: copy them exactly from the tool that returned them, do not derive, shorten, pluralize or rename them.",
	"An instance's OWN tools are one level down from this surface and are usually the direct path: list_instance_tools names what one instance may actually run — its GitHub, HTTP and search connectors as well as its own memory, files and knowledge — and call_instance_tool invokes one. Check there BEFORE reaching for coding_session_message: driving a terminal to shell out for something an instance tool already does returns a truncated pane instead of structured data, and is the fallback rather than the first path.",
	NESTED_TOOL_SEQUENCE,
	DIRECT_BEFORE_RUN,
	"To debug what an agent did, call agent_trace first (chat turns, steps and errors on one timeline), then instance_messages or list_errors for detail. usage_summary reports spend.",
	"Tool annotations are accurate: readOnlyHint true means the tool only reads. A tool that changes state takes dry_run — call it that way first to see what would happen. The most consequential tools also require an exact confirm string and a connection holding the destructive scope; those refusals are real and cannot be argued past.",
	"If you already know the one instance you will drive for this whole session, connect to /mcp/i/<instance_id> instead: that session publishes only that instance's own tools under their real names with no instance_id argument, plus chat, guide and messages, and none of the platform-wide tools above.",
].join(" ");

/** Words that read wrong in sentence case — expanded rather than title-cased. */
const ACRONYMS: Record<string, string> = {
	ai: "AI",
	api: "API",
	cli: "CLI",
	kb: "KB",
	mcp: "MCP",
	sdk: "SDK",
	url: "URL",
};

/**
 * A human-readable title, DERIVED from the tool's own name rather than written down
 * per tool — `coding_session_capture` → "Coding session capture".
 *
 * OpenAI's plugin guidance asks each tool for "an action-oriented name and human-readable
 * title", and the title is one of the fields its review scan imports. A hand-written title
 * per tool would be 135 strings that no test could hold to the name they belong to; derived,
 * a renamed tool retitles itself.
 */
export function titleFor(name: string): string {
	const words = name.split("_").filter(Boolean);
	if (words.length === 0) return name;
	return words
		.map((word, index) => {
			const acronym = ACRONYMS[word];
			if (acronym) return acronym;
			return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
		})
		.join(" ");
}

// ── Tool annotations (#561) ──────────────────────────────────────────────────
//
// MCP's four hints are the channel a host reads to decide whether a call needs a
// confirmation. This server declared none of them, and the spec's defaults are the
// pessimistic ones — `readOnlyHint` false, `destructiveHint` true, `openWorldHint` true
// (schema/2025-06-18 lines 890-922). So every tool presented as not-read-only, destructive
// and open-world: `list_agents` and `usage_summary` on the same footing as `delete_agent`.
//
// The server already knows better than that. `safety.ts` classifies each tool read / write
// / runtime / destructive, and the classification is ENFORCED: `DEFAULT_SCOPES` grants
// read+write+runtime and never `destructive`, and a destructive tool additionally demands
// an exact `confirm` string. What is published below is that same boundary, restated in
// the vocabulary a host understands.
//
// Why this is a table and not a derivation. The enforced scope lives inside each handler,
// as an argument to a `requirePermission` call that runs at INVOCATION time; `tools/list`
// is answered at registration time, when no handler has run. Worse, the scope does not
// cover the surface: 58 of the 135 tools never call `requirePermission` at all — a read
// gate that can never deny is dead code — and "ungated" is not the same claim as
// "read-only" (`chat_with_agent` is ungated and runs inference). A naive
// ungated ⇒ readOnlyHint:true would have mislabelled it.
//
// So the risk class is written down here and then DERIVED BACK from the handlers in the
// test, over the whole registered surface (ADR 0002):
//
//   · every registered tool has exactly one entry, and no entry has no tool;
//   · the announced class is never LAXER than the scope the handler enforces;
//   · a tool announced read-only must issue no non-GET request when driven;
//   · a tool announced non-destructive must demand no `confirm` and must not be
//     destructive-scoped — i.e. the published line is exactly the enforced one.
//
// Four entries are deliberately STRICTER than the gate, which the test permits and the
// reverse of which it fails. They are marked below.

/** What the server ANNOUNCES about a tool. Same vocabulary as `McpScope` on purpose: this
 *  is the enforced classification restated, not a second one. */
export const TOOL_RISK: Record<string, McpScope> = {
	// ── read: only reads. Announced `readOnlyHint: true`. ──
	agent_activity: "read",
	agent_analytics: "read",
	agent_deploy_status: "read",
	agent_info: "read",
	agent_trace: "read",
	billing_status: "read",
	check_instance_loop: "read",
	coding_diagnostics: "read",
	coding_instance_deploy_status: "read",
	coding_loop_trace: "read",
	coding_loop_queue: "read",
	coding_loop_status: "read",
	coding_repos_list: "read",
	coding_engine_get: "read",
	coding_session_capture: "read",
	coding_terminal: "read",
	coding_timeline: "read",
	get_instance_connection_guide: "read",
	coding_sessions_list: "read",
	connector_status: "read",
	email_status: "read",
	get_agent_board_config: "read",
	account_activity: "read",
	get_account_preferences: "read",
	get_agent_settings_schema: "read",
	get_agent_stats_schema: "read",
	get_apply_tips: "read",
	get_budget_limits: "read",
	get_instance_board_config: "read",
	get_instance_instructions: "read",
	get_instance_connector_account: "read",
	get_instance_loop_limits: "read",
	list_instance_drive_files: "read",
	get_instance_loop_presets: "read",
	get_instance_operator_manual: "read",
	get_instance_memory: "read",
	get_instance_pipeline: "read",
	get_instance_settings: "read",
	get_instance_state: "read",
	get_instance_task: "read",
	get_instance_voice_settings: "read",
	get_instance_stats: "read",
	get_profile: "read",
	get_translation_config: "read",
	ingest_repo_status: "read",
	instance_activity: "read",
	instance_board: "read",
	instance_messages: "read",
	instance_runner_node: "read",
	instance_runtime_status: "read",
	instance_task_events: "read",
	keys_status: "read",
	list_agent_files: "read",
	list_agent_tasks: "read",
	list_agent_repo_files: "read",
	list_agents: "read",
	list_collections: "read",
	list_connection_deliveries: "read",
	list_connections: "read",
	error_summary: "read",
	preview_instance_run_continue: "read",
	my_agent: "read",
	get_agent_capabilities: "read",
	get_agent_state: "read",
	get_agent_memory: "read",
	agent_messages: "read",
	export_agent: "read",
	plan_agent_builder: "read",
	list_errors: "read",
	list_feedback: "read",
	list_notifications: "read",
	list_instance_collections: "read",
	list_instance_connector_grants: "read",
	list_instance_files: "read",
	list_instance_knowledge: "read",
	list_connectors: "read",
	list_instance_connectors: "read",
	list_instance_mcp_grants: "read",
	list_instance_mcp_input_requests: "read",
	list_mcp_presets: "read",
	list_instance_tools: "read",
	list_trigger_actions: "read",
	preview_instance_trigger: "read",
	list_instance_trigger_events: "read",
	list_instance_triggers: "read",
	list_knowledge: "read",
	list_pipeline_runs: "read",
	list_runner_nodes: "read",
	list_supervision: "read",
	mcp_audit_log: "read",
	my_agents: "read",
	my_instances: "read",
	platform_guide: "read",
	platform_health: "read",
	query_instance_records: "read",
	query_records: "read",
	read_agent_file: "read",
	recent_instances: "read",
	sdk_reference: "read",
	// The two reads that POST: the API expresses a vector query as a request BODY, so the
	// method says "write" and the tool does not. Named in the test's exemption list, which
	// fails if either of them stops POSTing (a stale exemption is a hole).
	search_agent_knowledge: "read",
	search_instance_knowledge: "read",
	system_status: "read",
	ticket_thread: "read",
	usage_summary: "read",
	vector_stats: "read",
	whoami: "read",

	// ── write: adds to or updates PAGS state, and this server grants it on a default
	//    connection. Announced `readOnlyHint: false, destructiveHint: false`. ──
	add_instance_knowledge: "write",
	add_knowledge: "write",
	ask_ticket: "write",
	clear_finished_tasks: "write",
	coding_loop_queue_cancel: "write",
	coding_loop_stop: "write",
	coding_repo_add: "write",
	coding_engine_set: "write",
	create_agent: "write",
	create_collection: "write",
	create_connection: "write",
	create_instance_ticket: "write",
	create_instance_trigger: "write",
	create_supervision: "write",
	grant_instance_connector_folder: "write",
	hint_instance_task: "write",
	ingest_repo: "write",
	insert_instance_record: "write",
	ingest_instance_knowledge_url: "write",
	insert_record: "write",
	mark_all_notifications_read: "write",
	mark_notification_read: "write",
	record_instance_feedback: "write",
	rename_instance: "write",
	resolve_feedback: "write",
	scaffold_agent: "write",
	set_account_preferences: "write",
	set_agent_settings_schema: "write",
	set_agent_stats_schema: "write",
	set_board_item_status: "write",
	set_budget_limits: "write",
	set_connection_enabled: "write",
	set_instance_board_config: "write",
	set_instance_instructions: "write",
	set_instance_connector_account: "write",
	import_instance_drive_file: "write",
	import_instance_workdrive_file: "write",
	set_instance_loop_limits: "write",
	set_instance_loop_presets: "write",
	set_instance_model: "write",
	set_instance_operator_manual: "write",
	set_instance_runner_node: "write",
	set_instance_settings: "write",
	set_instance_stats: "write",
	set_instance_connector_consent: "write",
	set_instance_mcp_grant: "write",
	create_agent_task: "write",
	update_agent_task: "write",
	set_instance_tool: "write",
	set_supervision_enabled: "write",
	set_translation_config: "write",
	set_instance_voice_settings: "write",
	clear_instance_voice_settings: "write",
	stop_instance_loop: "write",
	pause_instance: "write",
	resume_instance: "write",
	update_board_ticket: "write",
	update_instance_knowledge: "write",
	update_instance_record: "write",
	subscribe_agent: "write",
	update_agent: "write",
	update_agent_board_config: "write",
	update_profile: "write",
	update_record: "write",
	upload_agent_file: "write",
	upload_resume: "write",
	write_instance_memory: "write",

	// ── runtime: drives something whose effects this server does not model — a machine, a
	//    deploy, an agent turn. Announced `destructiveHint: true`, which reads "MAY perform
	//    destructive updates": we cannot promise these are additive, so the honest value is
	//    the pessimistic one, stated rather than left to the default. It lands on the same
	//    annotation as `destructive` deliberately — the difference between those two is a
	//    difference in the GATE (scope + confirm), not in what a host should ask a user. ──
	answer_instance_mcp_input_request: "runtime",
	approve_instance_task: "runtime",
	replay_connection_delivery: "runtime",
	test_instance_mcp_server: "runtime",
	answer_instance_input: "runtime",
	end_instance_takeover: "runtime",
	resume_instance_takeover: "runtime",
	send_instance_takeover_input: "runtime",
	// STRICTER than its gate (it has none): the trial-chat surface is public, so nothing
	// gates it — but a trial chat runs inference and opens a session, and "ungated" is not
	// "read-only". This is the tool a scope-shaped derivation would have got wrong.
	chat_with_agent: "runtime",
	chat_with_instance: "runtime",
	// STRICTER than its gate (`write`): a generic invoker. What it does is decided by the
	// registry entry for the tool it is handed, which this worker deliberately does not
	// model — so it cannot promise the call is additive.
	call_instance_tool: "runtime",
	coding_loop_start: "runtime",
	coding_overseer: "runtime",
	coding_session_end: "runtime",
	coding_session_fresh: "runtime",
	coding_session_message: "runtime",
	// Opens a repo's conversation, which launches the engine on the user's machine — the same
	// act `coding_session_fresh` performs, so it takes the same class (#696).
	coding_session_open: "runtime",
	coding_session_restart: "runtime",
	register_instance_runtime: "runtime",
	run_instance_task: "runtime",
	run_instance_trigger: "runtime",
	// STRICTER than its gate (`write`): starting a loop hands the agent an objective and
	// lets it act unattended until it stops.
	start_instance_loop: "runtime",
	// A continue STARTS a run, so it carries the same scope as starting one (#806).
	continue_instance_run: "runtime",
	trigger_agent_deploy: "runtime",

	// ── destructive: deletes, overwrites, or commits an irreversible external action.
	//    Announced `destructiveHint: true`. Every one of these also demands a `confirm`
	//    string and a connection holding the `destructive` scope. ──
	// STRICTER than its gate on one path: `write` for one repo, `destructive` for all
	// (contract.test.ts). An annotation has one value per tool, so it takes the worse one.
	remove_repo: "destructive",
	// Gated `runtime` for a dry run and `destructive` for a real submit — a real submit
	// sends an application to a third party and cannot be recalled.
	apply_to_job: "destructive",
	// Gated `write`, but both overwrite a file in a GitHub repo, which is why they were
	// given confirmation strings. The confirm requirement is the honest discriminator here,
	// not the scope name.
	batch_write_agent_files: "destructive",
	write_agent_file: "destructive",
	cancel_instance: "destructive",
	cancel_instance_task: "destructive",
	delete_instance_task: "destructive",
	start_instance_browser_task: "destructive",
	// #692: detaching a repo from a coding instance. The BINDING is cheap to recreate with
	// `coding_repo_add`, which on its own would argue for `write` — but removing it asks the runner
	// to end any active session on that repo first, so the call reaches out and stops engine
	// processes on the owner's machine. A scope is about what a call can disturb, not about how hard
	// the row is to retype.
	coding_repo_remove: "destructive",
	clear_instance_messages: "destructive",
	delete_instance_connector_grant: "destructive",
	delete_instance_file: "destructive",
	delete_instance_knowledge: "destructive",
	delete_instance_memory: "destructive",
	delete_agent_task: "destructive",
	delete_agent: "destructive",
	delete_agent_knowledge: "destructive",
	set_agent_capabilities: "destructive",
	set_agent_state: "destructive",
	chat_with_my_agent: "destructive",
	create_agent_version: "destructive",
	rollback_agent_version: "destructive",
	execute_agent_builder_plan: "destructive",
	delete_connection: "destructive",
	delete_feedback: "destructive",
	delete_instance_trigger: "destructive",
	delete_supervision: "destructive",
	unregister_instance_runtime: "destructive",
};

/** How the surface splits. A ratchet in BOTH directions: silently losing a read-only
 *  annotation is as much a regression as silently gaining one. */
export const MCP_RISK_COUNTS: Record<McpScope, number> = {
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
	// +1 read at #198: `platform_health`, the read-only diagnostic — every verdict in it is derived
	// from public probes and this session's own latency ring; nothing is written.
	read: 106,
	// +2 write at #825: `pause_instance` / `resume_instance`. `write` rather than `destructive` —
	// nothing is deleted and nothing is unsubscribed, and classing the OFF switch as destructive
	// would put RESUME behind a scope the caller may not hold, which is the wrong failure mode for
	// a safety toggle (the reasoning `set_instance_connector_consent` already records). Not `read`
	// either: switching an agent off is a real change.
	write: 67,
	// +1 runtime at #806: `continue_instance_run`. `runtime` rather than `write` for the reason
	// `start_instance_loop` is — it starts an autonomous run that spends on its own — and the
	// two must agree, because a caller holding the scope to start one holding a narrower one to
	// continue it would be a distinction the route itself does not make.
	runtime: 24,
	// +1 read, +8 destructive at #613 (agent-template authoring, write half): builder planning
	// only computes a proposal; the other eight can delete, overwrite, run a billable template
	// turn, create an enduring version, or create/scaffold a template. They all require the
	// destructive scope, an exact confirm and a no-network dry run, because this is the creator's
	// shared source template rather than a caller-private instance.
	destructive: 28,
};

/** The subset of MCP's `ToolAnnotations` this server can state honestly.
 *
 *  `idempotentHint` and `openWorldHint` are deliberately absent, everywhere. PAGS has no
 *  notion of idempotency, and no per-tool record of which tools reach an external system —
 *  `tier` in `lib/builtin-tool-policy.ts` classifies an AGENT's tools, not this server's,
 *  and does not map onto these names. Both spec defaults (idempotent false, open-world
 *  true) err on the cautious side, so omitting them costs a host nothing; guessing them
 *  would cost it exactly what this issue is about. */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
}

/**
 * What `tools/list` publishes for one tool, or `undefined` for a tool with no entry — an
 * unclassified tool falls back to the spec's pessimistic defaults rather than to a guess.
 */
export function annotationsFor(name: string): ToolAnnotations | undefined {
	return annotationsForRisk(TOOL_RISK[name]);
}

/**
 * The same mapping, from a risk CLASS rather than a tool name. `annotationsFor` is the
 * platform-wide surface's lookup through `TOOL_RISK`; a pinned session (#783, `pinned.ts`)
 * registers tools named by an instance's policy rows, which no static table can classify, so
 * it announces each row's own `mutates` through this — one place turns a class into the wire
 * object, whichever surface asked.
 */
export function annotationsForRisk(risk: McpScope | undefined): ToolAnnotations | undefined {
	switch (risk) {
		case "read":
			// destructiveHint is only meaningful when readOnlyHint is false, but it is stated
			// anyway: a host that reads the two independently must not see the default `true`
			// on a tool that cannot write.
			return { readOnlyHint: true, destructiveHint: false };
		case "write":
			return { readOnlyHint: false, destructiveHint: false };
		case "runtime":
			// `destructiveHint` reads "MAY perform destructive updates", and a tool that types
			// into a live CLI or fires a deploy may. Stating the pessimistic value explicitly
			// rather than leaving it to the spec's default is the same claim, and it is the one
			// Anthropic's directory policy §5.E asks to be declared rather than implied.
			return { readOnlyHint: false, destructiveHint: true };
		case "destructive":
			return { readOnlyHint: false, destructiveHint: true };
		default:
			return undefined;
	}
}

// ── Output schemas (#561, part 2) ────────────────────────────────────────────
//
// MCP 2025-06-18 pairs `outputSchema` with `structuredContent`: a caller reads a field out
// of one result and puts it into the next call instead of parsing prose. OpenAI asks for
// one "when the tool returns structured data" and its review scan imports them.
//
// Declared for TWO tools, and the restraint is the design. An output schema is a BINDING
// contract — "Servers MUST provide structured results that conform to this schema", which
// the pinned SDK enforces by rejecting the call (`validateToolOutput`, mcp.js:185-207). So
// a schema that drifts from what the API actually returns does not degrade a result, it
// fails one. And drift is the likely case here: the response shapes belong to
// `workers/api`, a SEPARATE deployable this worker cannot import, so a transcribed schema
// for something like `/v1/usage` — totals, six groupings, payer coverage, unmetered — would
// be a copy with nothing able to hold it to its source. The `columnFor` comment in
// `instance-tools/shared.ts` is what that costs when it goes wrong.
//
// The two below are the ones that pay for themselves anyway: their whole content is the
// IDENTIFIER the next call needs (`agent_info`, `subscribe_agent`, and every instance tool
// in the server). Every field is optional and the objects passthrough, so a field added or
// renamed in `workers/api` cannot fail a call — the schema describes what a caller may rely
// on finding, not everything it will receive.
//
// The rest of the surface deliberately declares none: a tool that returns a one-line
// acknowledgement gains nothing from a schema and takes on the obligation anyway.

/** Zod raw shapes, keyed by tool name. `undefined` for a tool that declares no schema. */
export const TOOL_OUTPUT: Record<string, z.ZodRawShape> = {
	list_agents: {
		agents: z
			.array(
				z
					.object({
						id: z.string().optional(),
						slug: z.string().optional(),
						name: z.string().optional(),
						category: z.string().optional(),
						description: z.string().optional(),
					})
					.passthrough(),
			)
			.optional()
			.describe("Published agents. `id` or `slug` is what agent_info and subscribe_agent take."),
		error: z.string().optional().describe("Set instead of the payload when the call was refused."),
	},
	my_instances: {
		instances: z
			.array(
				z
					.object({
						id: z.string().optional(),
						agent_id: z.string().optional(),
						slug: z.string().optional(),
						name: z.string().optional(),
						status: z.string().optional(),
					})
					.passthrough(),
			)
			.optional()
			.describe("Your subscribed instances. `id` is the instance_id every instance tool takes."),
		error: z.string().optional().describe("Set instead of the payload when the call was refused."),
	},
};

export function outputSchemaFor(name: string): z.ZodRawShape | undefined {
	return TOOL_OUTPUT[name];
}
