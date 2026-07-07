import { AGENT_TOOLS } from "./lib/tools.js";
import { STORAGE_TOOLS } from "./lib/storage-tools.js";
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

/** The full set — union of every group. Equals the historical CORE_TOOLS exactly, so a
 *  generic agent's tools are unchanged (no regression); only coding/repo agents prune. */
const FULL: readonly string[] = [
	...BASE,
	...KB_READ,
	...KB_WRITE,
	...FILES,
	...COLLECTIONS,
	...APPLY,
	...CODING,
];

/**
 * The tool names an agent may use, resolved from its capabilities:
 *
 * - **repo** (Repo Chat): it genuinely has a vector index → BASE + read-only KB. No
 *   KB writes (ingestion is server-side via the Repo tab), no coding/files/collections.
 * - **coding** (Coder): no vector index — its code lives in live tmux sessions → BASE +
 *   coding tools ONLY. Withholding `search_knowledge` is what stops the empty-index
 *   hallucination at the source, not just in the prompt.
 * - **everything else** (apply, insurance, generic, unknown): the FULL set, unchanged.
 */
export function toolNamesFor(capabilities?: AgentCapabilities): Set<string> {
	const surfaces = capabilities?.surfaces ?? [];
	if (surfaces.includes("repo")) return new Set<string>([...BASE, ...KB_READ]);
	if (surfaces.includes("coding")) return new Set<string>([...BASE, ...CODING]);
	return new Set<string>(FULL);
}

export function buildAgentToolDefinitions(opts?: { emailEnabled?: boolean; capabilities?: AgentCapabilities }) {
	const enabled = toolNamesFor(opts?.capabilities);
	// Permission-gated tools are only offered to the model when the user granted them.
	if (opts?.emailEnabled) enabled.add("find_confirmation_link");

	const toolMap = new Map<string, (typeof AGENT_TOOLS)[number]>();
	for (const t of [...AGENT_TOOLS, ...STORAGE_TOOLS]) {
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
