import { AGENT_TOOLS } from "./lib/tools.js";
import { STORAGE_TOOLS } from "./lib/storage-tools.js";
import { registryConnectorGroups, registryToolDefs } from "./lib/tool-registry.js";
import type { AgentCapabilities } from "./lib/agent-capabilities.js";

// ── Tool groups ──────────────────────────────────────────────────────────────
// Tools are gated by agent capability, not handed out uniformly. Previously EVERY
// agent got the full set — so a Coder (which has no vector index; its code lives in
// live tmux sessions) was offered `search_knowledge`, called it, found an empty store,
// and told the user the code "isn't indexed" — a hallucinated failure. Grouping the
// tools lets each capability expose exactly what it can actually use.

/** Universal agent facilities every agent gets: memory, tasks, web fetch, context. */
const BASE = [
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
] as const;

/** Read the vector knowledge base (RAG). Only agents that HAVE an index get these. */
const KB_READ = ["search_knowledge", "list_knowledge", "read_knowledge"] as const;
/** Mutate the knowledge base. */
const KB_WRITE = ["update_knowledge", "delete_knowledge", "add_knowledge"] as const;
/** Binary file storage (R2). */
const FILES = ["upload_file", "list_files", "read_file", "delete_file"] as const;
/** Structured collections (agent-defined tables). */
const COLLECTIONS = ["create_collection", "list_collections", "insert_record", "query_records", "update_record"] as const;
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
 */
export function toolNamesFor(capabilities?: AgentCapabilities): Set<string> {
	const declared = capabilities?.tools;
	if (declared && declared.length) {
		const set = new Set<string>(BASE);
		for (const name of declared) if (CREATOR_SELECTABLE_TOOLS.has(name)) set.add(name);
		return set;
	}
	const surfaces = capabilities?.surfaces ?? [];
	if (surfaces.includes("repo")) return new Set<string>([...BASE, ...KB_READ]);
	if (surfaces.includes("coding")) return new Set<string>([...BASE, ...CODING]);
	return new Set<string>(FULL);
}

export function buildAgentToolDefinitions(opts?: { emailEnabled?: boolean; capabilities?: AgentCapabilities }) {
	const enabled = toolNamesFor(opts?.capabilities);
	// Permission-gated tools are only offered to the model when the user granted them.
	if (opts?.emailEnabled) enabled.add("find_confirmation_link");

	const toolMap = new Map<string, { name: string; description: string; parameters: Record<string, { type: string; description: string; required?: boolean }> }>();
	for (const t of [...AGENT_TOOLS, ...STORAGE_TOOLS, ...registryToolDefs()]) {
		if (enabled.has(t.name)) toolMap.set(t.name, t);
	}
	return [...toolMap.values()].map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: {
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
