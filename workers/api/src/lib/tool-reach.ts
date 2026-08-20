// Where a call to a tool LANDS (#584) — the fact the console's "reaches outside the platform"
// claim needs, and the one the listing did not carry.
//
// ── The claim that was false ──────────────────────────────────────────────────────────────────
//
// Measured on the deployed API over all 34 instances on the operator account (2026-08-15), the
// console's Settings tab told TEN of them, verbatim: "This agent can change its own data — its
// memory, tasks and stored documents — but has no tool that reaches outside the platform." All ten
// held `fetch_url` as `allowed:true` — as does every instance, because it is in `BASE` — and
// `fetch_url` takes a caller-chosen `method` and `body` (`lib/tools.ts`), so it POSTs arbitrary
// payloads to arbitrary public hosts. That sentence is what an owner reads when deciding what to
// put in an agent's knowledge base.
//
// The console derived the claim from "does any listed tool NAME a connector". That was exactly
// true while the listing held connector tools and nothing else, and #525 falsified it by making
// the listing exhaustive: the built-in facilities appear now too, and they carry no connector. So
// connector-less stopped implying platform-internal, and the sentence went on asserting it.
//
// ── Why a better proxy was not the fix ────────────────────────────────────────────────────────
//
// "Names a connector" is wrong in BOTH directions. `fetch_url`, `send_to_cli`,
// `submit_job_application` and `find_confirmation_link` reach outside with no connector; every
// tool of the `supervision` connector names one and never leaves the platform — its own registry
// entry says why ("internal to the platform and to ONE owner (both instances are theirs), so
// there is no external system and no credential").
//
// The other candidates fail the same way and were measured, not assumed:
//
//   • `tier` — `fetch_url` is `base`, the SAME tier as `write_memory`. Tier separates
//     `send_to_cli` (`runtime`) from platform tools and cannot separate "reaches the internet"
//     from "writes my own memory".
//   • `scope` / `mutates` — different questions entirely. `http_reachable` changes nothing and
//     still GETs a URL the caller names; `web_search` is a read that reaches Google. Reach is
//     orthogonal to both, which is exactly why deriving one from the other keeps producing a
//     sentence that is true about one axis and false about the other.
//
// ── What reach means, stated once so nobody re-derives it as a proxy ──────────────────────────
//
// The OUTERMOST boundary a single call to this tool can cross:
//
//   platform — ProAgentStore's own storage and compute, for this owner: the instance's Durable
//              Object, D1, R2, Vectorize. Nothing leaves.
//   machine  — the owner's own computer, over the runner relay.
//   internet — a third-party system: a connector's API, or any host the CALLER names.
//
// Two rules make the boundary decidable rather than a matter of taste:
//
//   1. **The call, not its consequences.** `start_work` hands a goal to this instance's own
//      executor and writes a run row: `platform`. What that executor then does is bounded by the
//      SAME tool policy — its tools are rows in this same listing, each with its own reach — so
//      the union an auditor reads is still complete. Judging a delegating tool by what it might
//      eventually cause makes every tool `internet` and the field worthless.
//   2. **Where the answer depends on the input, take the outermost one.** `enrich` dispatches
//      whatever tool it is handed, `browser_act` drives a browser on the machine to any site.
//      Both are `internet`. Over-reporting reach costs an auditor a question; under-reporting is
//      the false assurance this file exists to end.
//
// ── Declared, never defaulted to the safe answer ──────────────────────────────────────────────
//
// Both tables are exhaustive and `tool-reach-report.test.ts` fails when a tool or a connector
// reaches the listing without an entry — the same discipline `BUILTIN_TOOL_SCOPES` uses to force
// the read/write decision. The fallback is `internet` and is unreachable in production: it fails
// CLOSED, because a default of `platform` for a name nobody classified is precisely how #584
// shipped.
import { CONNECTORS } from "./connectors/registry.js";

/**
 * The reach vocabulary. A LIST first and a type second, so a guard can iterate it — a TS union
 * cannot be iterated, and a hand-copied list in the test is the same defect one layer over (#569).
 */
export const TOOL_REACHES = ["platform", "machine", "internet"] as const;

/** platform = never leaves ProAgentStore · machine = the owner's computer · internet = elsewhere. */
export type ToolReach = (typeof TOOL_REACHES)[number];

/**
 * The reach of every connector, keyed by `Connector.id`.
 *
 * Per CONNECTOR rather than per tool because reach is a property of the system on the other end:
 * every `github_*` tool reaches GitHub, every `tmux_*` tool reaches the machine. A tool needing a
 * different answer from its connector overrides it in {@link TOOL_REACH} below.
 *
 * Covers connectors that ship with `tools: []` (the three connected ACCOUNTS) as well, so the day
 * one of them gains a tool it is already classified rather than falling through to the default.
 */
export const CONNECTOR_REACH: Readonly<Record<string, ToolReach>> = {
	github: "internet",
	meta: "internet",
	// The runner relay: these land on the owner's own computer and nowhere else.
	terminal: "machine",
	tmux: "machine",
	"repo-local": "machine",
	// Reached over the runner relay like tmux — but it drives a real browser to a URL the caller
	// names, so the outermost boundary a call crosses is the internet, not the machine (rule 2).
	browser: "internet",
	// The one connector that is NOT external, and the reason "names a connector" is wrong in both
	// directions: both instances belong to the same owner and the call never leaves the platform.
	supervision: "platform",
	http: "internet",
	mcp: "internet",
	"web-search": "internet",
	google_sheets: "internet",
	google_drive: "internet",
	zoho_workdrive: "internet",
	gmail: "internet",
};

/**
 * The reach of every tool that has no connector to inherit one from — plus any tool that needs a
 * different answer from its connector's (there are none today; the hook is here so an override is
 * a one-line decision rather than a reason to weaken the connector table).
 *
 * Read in full, this is the audit answer for the 55 connector-less rows of the listing. The
 * platform ones dominate and are listed anyway: an omission has to be a FAILURE, not a default.
 */
export const TOOL_REACH: Readonly<Record<string, ToolReach>> = {
	// ── The agent's own storage: memory, tasks, board, knowledge, files, collections, context.
	// All of it is this instance's DO / D1 / R2 / Vectorize, for this owner.
	read_memory: "platform",
	write_memory: "platform",
	delete_memory: "platform",
	get_tasks: "platform",
	create_task: "platform",
	update_task: "platform",
	configure_board: "platform",
	get_activity: "platform",
	get_user_context: "platform",
	set_user_preference: "platform",
	search_knowledge: "platform",
	list_knowledge: "platform",
	read_knowledge: "platform",
	update_knowledge: "platform",
	delete_knowledge: "platform",
	add_knowledge: "platform",
	upload_file: "platform",
	list_files: "platform",
	read_file: "platform",
	delete_file: "platform",
	create_collection: "platform",
	list_collections: "platform",
	insert_record: "platform",
	query_records: "platform",
	update_record: "platform",
	delete_record: "platform",
	// Reads `coding_repos`/`coding_sessions` out of D1. It NAMES machines; it does not touch one.
	list_coding_repos: "platform",
	// ── The agent's own lifecycle (FIRST_PARTY_TOOLS). Rule 1: these write a run/ticket/config row
	// on the platform. What the executor they start then does is bounded by this same listing.
	start_work: "platform",
	check_work: "platform",
	stop_work: "platform",
	get_behaviour: "platform",
	set_behaviour: "platform",
	get_stats: "platform",
	set_stats_card: "platform",
	run_pipeline: "platform",
	create_ticket: "platform",
	record_feedback: "platform",
	// ── PDF forms (#712): read a file from this instance's store, write one back. The bytes
	// never leave the platform, and nothing is fetched — pdf-lib runs in the isolate.
	inspect_pdf_form: "platform",
	fill_pdf_form: "platform",
	build_answer_sheet: "platform",
	// ── Pure pipeline steps: no I/O at all, by their own declarations in steps.ts.
	map: "platform",
	filter: "platform",
	flatten: "platform",
	slice: "platform",
	parse_json: "platform",
	// Scans rows it is HANDED (steps.ts: "pure, no I/O") — the fetching was done by `web_search`.
	extract_contacts: "platform",
	// Writes the instance's own collection and fires the agent-to-agent pump, which starts work on
	// another instance OF THE SAME OWNER. Same argument as `supervision`: still the platform.
	dedupe_upsert: "platform",
	// ── The owner's machine, over the runner relay.
	read_terminal: "machine",
	send_to_cli: "machine",
	// Kills an engine process on the owner's machine.
	end_coding_session: "machine",
	// ── Outside. Each one is why this file exists.
	// The caller picks the method, the body and the host (`lib/tools.ts`). #584's ten instances.
	fetch_url: "internet",
	// Drives a real browser to a third-party ATS and posts a form as the owner.
	submit_job_application: "internet",
	// Reads the owner's connected Gmail — Google's servers, not ours.
	find_confirmation_link: "internet",
	// The declared Gmail tools (#711). Same reach as the line above and for the same reason: the
	// mailbox is Google's. `gmail_download_attachment` is the one worth pausing on — it ends by
	// writing into this instance's own file store, but it gets its bytes from Gmail, and reach is
	// about where the data comes FROM as much as where it goes.
	gmail_search: "internet",
	gmail_read_message: "internet",
	gmail_download_attachment: "internet",
	gmail_archive: "internet",
	gmail_mark_read: "internet",
	// GETs a URL the caller names. `mutates:false` and still outside: reach is not mutation.
	http_reachable: "internet",
	// Dispatches a POST to Google Places from a fixed template.
	geocode: "internet",
	// Rule 2, both of them: `fan_out` forwards the author's whole request (method included) to
	// `http_request`, and `enrich` runs whatever tool name it is given.
	fan_out: "internet",
	enrich: "internet",
	// Sends the prompt to the model provider (BYOK Anthropic, or Workers AI). It changes nothing —
	// `mutates:false`, deliberately — and the data still leaves. Exactly the case that shows reach
	// and mutation are different questions.
	ai_generate: "internet",
};

/**
 * The reach of one tool, or `null` when nothing classifies it.
 *
 * Separated from {@link reachOf} so the guard can tell "declared platform" apart from "fell
 * through to the closed default", which is the difference between a classification and a guess.
 */
export function declaredReachOf(t: { name: string; connector?: string }): ToolReach | null {
	const own = TOOL_REACH[t.name];
	if (own) return own;
	if (t.connector) return CONNECTOR_REACH[t.connector] ?? null;
	return null;
}

/**
 * The reach reported on the listing. Fails CLOSED at `internet` for a name nobody classified —
 * see the header: a default of `platform` is how the false claim shipped in the first place.
 */
export function reachOf(t: { name: string; connector?: string }): ToolReach {
	return declaredReachOf(t) ?? "internet";
}

/** Does this reach leave ProAgentStore? The one question the console's sentence asks. */
export function isOutsideThePlatform(reach: ToolReach): boolean {
	return reach !== "platform";
}

/** Every connector id the registry declares — the denominator the reach guard asserts against. */
export function connectorIds(): string[] {
	return CONNECTORS.map((c) => c.id);
}
