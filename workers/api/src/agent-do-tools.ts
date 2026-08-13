import { AGENT_TOOLS } from "./lib/tools.js";
import { optionsFor } from "./lib/surface-options.js";
import { STORAGE_TOOLS } from "./lib/storage-tools.js";
import { registryConnectorGroups, registryToolDefs, type JsonSchema } from "./lib/tool-registry.js";
import type { AgentCapabilities } from "./lib/agent-capabilities.js";

// ── Tool groups ──────────────────────────────────────────────────────────────
// Tools are gated by agent capability, not handed out uniformly. Previously EVERY
// agent got the full set — so a Coder (which has no vector index; its code lives in
// live tmux sessions) was offered `search_knowledge`, called it, found an empty store,
// and told the user the code "isn't indexed" — a hallucinated failure. Grouping the
// tools lets each capability expose exactly what it can actually use.

/** Universal agent facilities every agent gets: memory, tasks, web fetch, context. */
export const BASE = [
	"read_memory",
	"write_memory",
	"delete_memory",
	"get_tasks",
	"create_task",
	"update_task",
	"fetch_url",
	"get_activity",
	"get_user_context",
	"set_user_preference",
	// Every agent owns a work board; let it reshape its own columns/view on request.
	"configure_board",
	// Start a declarative data pipeline the owner configured on this instance (#97).
	"run_pipeline",
	// Hand a goal to the agent's OWN executor (its Pilot), when it has one.
	//
	// Without this a Repo Coder's chat could not act at all: `drive:false` correctly removes the
	// engine tools — a chat driving the CLI would be a second, uncoordinated driver — but nothing
	// replaced them. Asked to "just do it", the agent reached for the only action-shaped tool it
	// had, invented a pipeline named "coding", failed, and then told the user the engine was
	// running. It refuses cleanly on an agent with no separate executor.
	"start_work",
	// Look at what `start_work` actually did (#256).
	//
	// Granted wherever `start_work` is, because the pair is the point: an agent that can act but
	// cannot observe its own actions is structurally forced to either fabricate or deny, and this
	// instance did both. After `start_work` really ran `git pull` on the user's machine, a direct
	// challenge got "I did not pull anything. I have no ability to run shell commands" — it had no
	// tool that could settle the question, so it deferred to a prompt that said it could not act.
	//
	// Base rather than creator-selectable for the same reason `start_work` is: a creator who forgot
	// to declare it would ship an agent that can only guess about its own work.
	"check_work",
	// STOP what `start_work` started (#540) — the third verb of the same object's lifecycle.
	//
	// Base for a reason the other two only imply: an agent that can start work and cannot stop it is
	// not a smaller agent, it is a broken one. The owner asked five times to finish a session and was
	// told *"that's controlled by the app on your device"* — a fabrication he then reported twice
	// through `record_feedback`. The model did not invent that because it was careless; it invented
	// it because it had no tool and no true remedy to offer, and a prompt sentence cannot supply one
	// (the lesson of #493/#494 and the fix that worked, 644e5e2: give it the missing fact).
	//
	// Creator-selectable would put the stop behind the same decision that already lost `check_work`
	// on the agents that most needed it: the Repo Coder in #540 declares fourteen tools, none of
	// which stops anything, and its declaration is an AUTHORITATIVE allowlist.
	"stop_work",
	// Read and change how the agent communicates (#224).
	//
	// Base rather than creator-selectable because the alternative is what actually happened: asked
	// to be less technical, an agent with no behaviour tool wrote `preference:response_style` into
	// MEMORY and read it back, which looks like it worked and stores character in the place meant
	// for subject-matter knowledge. Every agent can be asked to change its manner, so every agent
	// needs somewhere real to put the answer.
	//
	// set_behaviour is confined to SELF_WRITABLE_FIELDS — guardrails are not self-writable.
	"get_behaviour",
	"set_behaviour",
	// Read and configure what the agent tracks about itself (#312).
	//
	// Base for the same reason the behaviour pair is: ANY agent can be asked "how many did you find
	// this week" or "start tracking that for me", and an agent with no proper home for the answer
	// invents one — the path that put `preference:response_style` into memory (#226) and made a
	// Repo Coder invent a pipeline named "coding". `set_stats_card` writes only the subscriber's own
	// override, and can only name a source from the closed vocabulary, so it changes the VIEW and
	// never the scope.
	"get_stats",
	"set_stats_card",
	// Record that the user says the agent got something wrong (#514).
	//
	// Base for the same reason the behaviour pair is, and with the same evidence behind it: told
	// "you got that wrong, write it down", an agent with nowhere to put it reaches for the tool it
	// already has. #506 is the live instance — the owner asked twice for a bug to be filed and it
	// ended as `write_memory → fact:pending issue:…`, a promise nothing schedules and nothing
	// re-reads. A complaint is not a fact about the subject and not a manner to adopt; without a
	// home of its own it lands in one of those two and is never read again.
	//
	// The console's flag on a message is the path that CANNOT fail (no model in it). This is the
	// one that catches the complaint said out loud mid-conversation, hands-free.
	"record_feedback",
] as const;

/** Read the vector knowledge base (RAG). Only agents that HAVE an index get these.
 *  Exported because it is also the answer to "can this agent use a file connector at all"
 *  (lib/instance-connector-policy.ts, #352) — a Drive import lands in the knowledge base and
 *  nowhere else, so an agent holding none of these names cannot reach it. Shared rather than
 *  restated so the two cannot drift into disagreeing about which names read the index. */
export const KB_READ = ["search_knowledge", "list_knowledge", "read_knowledge"] as const;
/** Mutate the knowledge base. */
const KB_WRITE = ["update_knowledge", "delete_knowledge", "add_knowledge"] as const;
/** Binary file storage (R2). */
const FILES = ["upload_file", "list_files", "read_file", "delete_file"] as const;
/**
 * Structured collections (agent-defined tables).
 *
 * `delete_record` is declared in STORAGE_TOOLS with a working, tested handler but was in NO
 * group — and since FULL is the union of the groups and CREATOR_SELECTABLE_TOOLS is built from
 * TOOL_CATALOG, the name was unreachable through every path. `buildAgentToolDefinitions` never
 * showed it to the model, a text-embedded call was refused as "not available to this agent", and
 * even an explicit `capabilities.tools:["delete_record"]` was silently dropped as not-in-catalog.
 * So a collections agent told "delete the duplicate lead" could create and update records forever
 * but never remove one. Its test passes by calling `executeStorageTool` directly, past the gate.
 */
const COLLECTIONS = ["create_collection", "list_collections", "insert_record", "query_records", "update_record"] as const;

/**
 * Irreversible collection writes — DECLARABLE but never granted by default.
 *
 * `delete_record` was unreachable through every path, which is a bug (a collections agent could
 * create and update forever but never remove). Folding it into COLLECTIONS fixed reachability but
 * overcorrected: COLLECTIONS flows into FULL, and FULL is the default for every agent that
 * declares no `capabilities.tools` — so every existing production agent would silently gain an
 * irreversible delete, with no owner opt-in (the write-consent gate covers registry connectors,
 * not STORAGE_TOOLS) and no undo. Its own group instead: a creator opts in by declaring it,
 * nobody inherits it.
 */
const COLLECTIONS_DESTRUCTIVE = ["delete_record"] as const;
/** Legacy selector-based job submit (superseded by the apply workflow). */
const APPLY = ["submit_job_application"] as const;
/** Live coding-session awareness: list repos + read/drive the engine's terminal. */
const CODING = ["list_coding_repos", "read_terminal", "send_to_cli"] as const;

/** The full set — union of every group. Equals the historical CORE_TOOLS plus
 *  delete_memory (added so agents can consolidate stale/duplicate memory keys —
 *  without it they could overwrite but never remove); only coding/repo agents prune. */
const FULL: readonly string[] = [
	...BASE,
	...KB_READ,
	...KB_WRITE,
	...FILES,
	...COLLECTIONS,
	...APPLY,
	...CODING,
];

// ── The tool catalog (data) ──────────────────────────────────────────────────
// The open, data-driven vocabulary a creator picks from when declaring an agent's
// `capabilities.tools`. Enumerable so the authoring UI (#55) and the pre-review
// safety scanner (#54) can list/reason about what an agent may do — instead of the
// tool set being implied by a hardcoded per-surface `switch`. Deliberately EXCLUDES
// the permission-gated `find_confirmation_link` (granted only via user permission,
// never by declaration) and the legacy `submit_job_application` (superseded by the
// apply workflow).

/** One selectable group in the catalog. `base` is always granted; the rest are opt-in. */
export interface ToolCatalogGroup {
	id: string;
	label: string;
	tools: readonly string[];
	/** base = always granted · standard = creator-selectable · runtime = needs a local runner · connector = external system. */
	tier: "base" | "standard" | "runtime" | "connector";
}

export const TOOL_CATALOG: readonly ToolCatalogGroup[] = [
	{ id: "base", label: "Memory, tasks, web fetch & context", tools: BASE, tier: "base" },
	{ id: "kb_read", label: "Knowledge base — read (RAG)", tools: KB_READ, tier: "standard" },
	{ id: "kb_write", label: "Knowledge base — write", tools: KB_WRITE, tier: "standard" },
	{ id: "files", label: "File storage", tools: FILES, tier: "standard" },
	{ id: "collections", label: "Structured collections", tools: COLLECTIONS, tier: "standard" },
	{ id: "collections_destructive", label: "Structured collections — delete", tools: COLLECTIONS_DESTRUCTIVE, tier: "standard" },
	{ id: "coding", label: "Live coding session", tools: CODING, tier: "runtime" },
	// Connector tools (issue #85/#86): one catalog group per external system, from the
	// registry — a creator declares them in capabilities.tools like any other tool.
	...registryConnectorGroups().map((g): ToolCatalogGroup => ({
		id: `connector:${g.connector}`,
		label: `${g.connector} connector`,
		tools: g.tools,
		tier: "connector",
	})),
];

/** Tool names a creator may grant via `capabilities.tools` (everything non-`base` in
 *  the catalog). BASE is always added on top, so it's intentionally excluded here. */
export const CREATOR_SELECTABLE_TOOLS: ReadonlySet<string> = new Set(
	TOOL_CATALOG.filter((g) => g.tier !== "base").flatMap((g) => g.tools),
);

/**
 * The tool names an agent may use, resolved from its capabilities:
 *
 * - **repo** (Repo Chat): it genuinely has a vector index → BASE + read-only KB. No
 *   KB writes (ingestion is server-side via the Repo tab), no coding/files/collections.
 * - **coding** (Coder): no vector index — its code lives in live tmux sessions → BASE +
 *   coding tools ONLY. Withholding `search_knowledge` is what stops the empty-index
 *   hallucination at the source, not just in the prompt.
 * - **everything else** (apply, insurance, generic, unknown): the FULL set, unchanged.
 *
 * A declared `capabilities.tools` allowlist takes precedence over all of the above:
 * the agent gets exactly those catalog tools plus the universal BASE facilities. This
 * is the data-driven path that lets a third-party creator scope tools without a code
 * change; the per-surface cases remain the default for agents that don't declare one.
 *
 * EXCEPTION (issue #119 / CODER-008): for a `coding`-surface agent the delegation tools
 * (`CODING`: send_to_cli, read_terminal, list_coding_repos) are a hard invariant and are
 * always added last, even over a declared allowlist — the orchestrator must never lose the
 * ability to drive and observe its Engines.
 */
export function toolNamesFor(capabilities?: AgentCapabilities): Set<string> {
	const surfaces = capabilities?.surfaces ?? [];
	const declared = capabilities?.tools;
	let set: Set<string>;
	if (declared?.length) {
		set = new Set<string>(BASE);
		for (const name of declared) if (CREATOR_SELECTABLE_TOOLS.has(name)) set.add(name);
	} else if (surfaces.includes("repo")) {
		set = new Set<string>([...BASE, ...KB_READ]);
	} else if (surfaces.includes("coding")) {
		// The DEFAULT tool set for a coding agent. Also honours drive:false — otherwise an agent
		// that declares no allowlist would still receive the drive tools here, before the
		// invariant below ever runs, and the opt-out would silently do nothing.
		set = optionsFor(capabilities, "coding")?.drive === false ? new Set<string>(BASE) : new Set<string>([...BASE, ...CODING]);
	} else {
		set = new Set<string>(FULL);
	}
	// Invariant (issue #119 / CODER-008): a `coding`-surface agent that DRIVES its own engines
	// always keeps the delegation tools (send_to_cli, read_terminal, list_coding_repos), even
	// when a declared allowlist would omit them — silently dropping them is what once left an
	// orchestrator unable to send tasks, after which it deflected or hallucinated success.
	//
	// The premise is now conditional, because Coder 2 split "coding agent" in two: a Repo Coder
	// is DRIVEN BY its Lead, so carrying these would make its chat a third way to drive an
	// engine, alongside the Co-pilot and the Overseer — the overlapping drive-paths #154 exists
	// to remove. It opts out with `{id:"coding", drive:false}`; its Coding tab and its Pilot are
	// unaffected, since neither goes through chat tools. Default stays true, so every existing
	// agent is untouched.
	if (optionsFor(capabilities, "coding")?.drive) for (const t of CODING) set.add(t);
	// Invariant (#540): an agent with a coding surface can END its coding session, whatever else it
	// may or may not do.
	//
	// Gated on the SURFACE and deliberately not on `drive`, unlike the CODING block above. `drive`
	// answers "may this chat type into the engine", and ending a session is not typing into it — it
	// is relinquishing it. The agent this ticket is about is a Repo Coder with `drive:false`, so a
	// drive-gated stop would have been withheld from the exact instance whose owner asked five times.
	//
	// Not in `CODING`, and therefore not in `FULL`: every generic agent inherits FULL, and a doc-chat
	// agent that has never had a session does not need a tool for ending one — that is the leak class
	// the capability registry closes. Not in `TOOL_CATALOG` either, for the reason
	// `find_confirmation_link` is not: it is granted by what the agent IS, so a declaration could only
	// add noise, and an authoritative allowlist that omitted it would recreate this very bug.
	if (surfaces.includes("coding")) set.add("end_coding_session");
	return set;
}

export function buildAgentToolDefinitions(opts?: {
	emailEnabled?: boolean;
	capabilities?: AgentCapabilities;
	/** The owner's per-instance off-switches (`config.disabledTools`). Applied LAST so it
	 *  overrides every grant above it, including the coding invariant: the subscriber's veto
	 *  over their own copy is the one control a creator's declaration must not outrank. */
	disabledTools?: readonly string[];
}) {
	const enabled = toolNamesFor(opts?.capabilities);
	// Permission-gated tools are only offered to the model when the user granted them.
	if (opts?.emailEnabled) enabled.add("find_confirmation_link");
	for (const name of opts?.disabledTools ?? []) enabled.delete(name);

	// Two def shapes are merged: the legacy AGENT_TOOLS/STORAGE_TOOLS carry an ad-hoc
	// `parameters` map (rebuilt into a JSON Schema below); registry tools already carry a
	// draft-07 `jsonSchema` and are passed through verbatim. Both yield the same
	// {type,properties,required} object the LLM has always seen — no behaviour change.
	type LegacyDef = { name: string; description: string; parameters: Record<string, { type: string; description: string; required?: boolean }> };
	type SchemaDef = { name: string; description: string; jsonSchema: JsonSchema };
	const toolMap = new Map<string, LegacyDef | SchemaDef>();
	for (const t of [...AGENT_TOOLS, ...STORAGE_TOOLS, ...registryToolDefs()]) {
		if (enabled.has(t.name)) toolMap.set(t.name, t);
	}

	// Guardrail (issue #119 / CODER-008): the coding delegation tools are the orchestrator's
	// core capability. If one is enabled but has NO backing definition, it would be silently
	// dropped from the set handed to the model — the exact regression that left the super agent
	// unable to send tasks (it then deflected or fabricated results). Fail loudly instead so a
	// wiring regression is caught at build time, not discovered mid-conversation.
	if (opts?.capabilities?.surfaces?.includes("coding")) {
		const missing = CODING.filter((name) => enabled.has(name) && !toolMap.has(name));
		if (missing.length) {
			throw new Error(
				`Coder orchestrator is missing delegation tool definition(s): ${missing.join(", ")}. ` +
					"The agent cannot drive/observe its Engines — check STORAGE_TOOLS registration in lib/storage-tools.ts.",
			);
		}
	}

	return [...toolMap.values()].map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters:
				"jsonSchema" in t
					? t.jsonSchema
					: {
							type: "object",
							properties: Object.fromEntries(
								Object.entries(t.parameters).map(([k, v]) => [
									k,
									{ type: v.type, description: v.description },
								]),
							),
							required: Object.entries(t.parameters)
								.filter(([, v]) => v.required)
								.map(([k]) => k),
						},
		},
	}));
}

export function storageToolNameSet(): Set<string> {
	return new Set(STORAGE_TOOLS.map((t) => t.name));
}
