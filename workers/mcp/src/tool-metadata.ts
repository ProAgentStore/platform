/**
 * What the server publishes ABOUT a tool, as opposed to what the tool does.
 *
 * Everything here is advisory metadata read by the calling host and model. None of it is a
 * check: `safety.ts` remains the only thing that decides whether a call runs. Nothing in
 * this module may ever be imported by a handler or by the safety layer — `index.test.ts`
 * fails the build if it is.
 */
import { z } from "zod";
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
 */
export const SERVER_INSTRUCTIONS = [
	"ProAgentStore hosts server-side AI agents. Almost every tool acts on ONE agent instance, so start by getting an id: my_instances lists the ones the connected user already runs; list_agents is the public catalogue and subscribe_agent creates an instance from it.",
	"To debug what an agent did, call agent_trace first (chat turns, steps and errors on one timeline), then instance_messages or list_errors for detail. usage_summary reports spend.",
	"Tool annotations are accurate: readOnlyHint true means the tool only reads. A tool that changes state takes dry_run — call it that way first to see what would happen. The most consequential tools also require an exact confirm string and a connection holding the destructive scope; those refusals are real and cannot be argued past.",
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
	coding_loop_status: "read",
	coding_repos_list: "read",
	coding_session_capture: "read",
	coding_timeline: "read",
	coding_sessions_list: "read",
	connector_status: "read",
	email_status: "read",
	get_agent_board_config: "read",
	get_agent_settings_schema: "read",
	get_agent_stats_schema: "read",
	get_apply_tips: "read",
	get_budget_limits: "read",
	get_instance_board_config: "read",
	get_instance_instructions: "read",
	get_instance_memory: "read",
	get_instance_pipeline: "read",
	get_instance_settings: "read",
	get_instance_state: "read",
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
	list_agent_repo_files: "read",
	list_agents: "read",
	list_collections: "read",
	list_connections: "read",
	list_errors: "read",
	list_feedback: "read",
	list_instance_collections: "read",
	list_instance_connector_grants: "read",
	list_instance_files: "read",
	list_instance_knowledge: "read",
	list_instance_tools: "read",
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
	query_instance_records: "read",
	query_records: "read",
	read_agent_file: "read",
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
	coding_loop_stop: "write",
	coding_repo_add: "write",
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
	insert_record: "write",
	rename_instance: "write",
	resolve_feedback: "write",
	scaffold_agent: "write",
	set_agent_settings_schema: "write",
	set_agent_stats_schema: "write",
	set_board_item_status: "write",
	set_budget_limits: "write",
	set_instance_board_config: "write",
	set_instance_instructions: "write",
	set_instance_model: "write",
	set_instance_runner_node: "write",
	set_instance_settings: "write",
	set_instance_stats: "write",
	set_instance_tool: "write",
	set_translation_config: "write",
	stop_instance_loop: "write",
	update_board_ticket: "write",
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
	approve_instance_task: "runtime",
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
	clear_instance_messages: "destructive",
	delete_instance_connector_grant: "destructive",
	delete_instance_file: "destructive",
	delete_instance_knowledge: "destructive",
	delete_instance_memory: "destructive",
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
	read: 70,
	write: 42,
	runtime: 16,
	destructive: 14,
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
	switch (TOOL_RISK[name]) {
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
