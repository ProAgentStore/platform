import { AGENT_TOOLS } from "./lib/tools.js";
import { STORAGE_TOOLS } from "./lib/storage-tools.js";

const CORE_TOOLS = new Set([
	"read_memory",
	"write_memory",
	"get_tasks",
	"create_task",
	"update_task",
	"fetch_url",
	"search_knowledge",
	"list_knowledge",
	"read_knowledge",
	"update_knowledge",
	"delete_knowledge",
	"add_knowledge",
	"upload_file",
	"list_files",
	"read_file",
	"delete_file",
	"create_collection",
	"list_collections",
	"insert_record",
	"query_records",
	"update_record",
	"get_activity",
	"get_user_context",
	"set_user_preference",
	"submit_job_application",
	"list_coding_repos",
	"read_terminal",
	"send_to_cli",
]);

export function buildAgentToolDefinitions(opts?: { emailEnabled?: boolean }) {
	const enabled = new Set(CORE_TOOLS);
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
