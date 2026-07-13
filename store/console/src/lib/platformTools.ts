export interface PlatformToolGroup {
	title: string;
	scope: string;
	description: string;
	tools: Array<{
		name: string;
		description: string;
		status?: string;
	}>;
}

export const platformToolGroups: PlatformToolGroup[] = [
	{
		title: "Memory, Tasks, and Context",
		scope: "Every agent",
		description: "Baseline tools available to agent brains for durable state, task tracking, URL reading, activity, and user preferences.",
		tools: [
			{ name: "read_memory", description: "Read saved instance memory." },
			{ name: "write_memory", description: "Save or update durable memory keys." },
			{ name: "delete_memory", description: "Remove stale or duplicate memory." },
			{ name: "get_tasks", description: "Read the instance task board." },
			{ name: "create_task", description: "Create a task for tracked work." },
			{ name: "update_task", description: "Move or update a task." },
			{ name: "fetch_url", description: "Fetch readable content from a URL." },
			{ name: "get_activity", description: "Read recent instance activity." },
			{ name: "get_user_context", description: "Read caller profile context." },
			{ name: "set_user_preference", description: "Store caller preferences for future turns." },
		],
	},
	{
		title: "Knowledge Base",
		scope: "Knowledge-capable agents",
		description: "Vector-backed document retrieval and controlled knowledge mutations. Repo Chat gets read-only access; generic agents can read and write.",
		tools: [
			{ name: "search_knowledge", description: "Semantic search across indexed knowledge." },
			{ name: "list_knowledge", description: "List knowledge documents available to the instance." },
			{ name: "read_knowledge", description: "Read a specific knowledge document." },
			{ name: "add_knowledge", description: "Add a document to instance knowledge." },
			{ name: "update_knowledge", description: "Update an existing knowledge document." },
			{ name: "delete_knowledge", description: "Remove a knowledge document." },
		],
	},
	{
		title: "Files and Collections",
		scope: "Generic and workflow agents",
		description: "Binary file storage plus structured tables for agent-defined records.",
		tools: [
			{ name: "upload_file", description: "Store a file in the instance file catalog." },
			{ name: "list_files", description: "List uploaded files." },
			{ name: "read_file", description: "Read file metadata or content." },
			{ name: "delete_file", description: "Delete an uploaded file." },
			{ name: "create_collection", description: "Create a structured record collection." },
			{ name: "list_collections", description: "List available collections." },
			{ name: "insert_record", description: "Insert a collection record." },
			{ name: "query_records", description: "Query collection records." },
			{ name: "update_record", description: "Update a collection record." },
		],
	},
	{
		title: "Browser, Coding, and Email",
		scope: "Capability-gated",
		description: "Tools exposed only when the agent has the matching runtime, surface, or user-granted account connection.",
		tools: [
			{ name: "submit_job_application", description: "Drive the job-application browser workflow.", status: "Apply agents" },
			{ name: "list_coding_repos", description: "List repos attached to a Coder instance.", status: "Coder" },
			{ name: "read_terminal", description: "Read the live coding CLI terminal.", status: "Coder" },
			{ name: "send_to_cli", description: "Send an instruction to the live coding CLI.", status: "Coder" },
			{ name: "find_confirmation_link", description: "Search Gmail for sign-in confirmation links.", status: "Requires Gmail grant" },
		],
	},
	{
		title: "Connectors and Triggers",
		scope: "Instance configured",
		description: "Account/folder grants and event sources configured by the instance owner, then used by triggers or agent workflows.",
		tools: [
			{ name: "Google Drive folder sync", description: "Import new or changed text-like Drive files into instance knowledge.", status: "Connector" },
			{ name: "Zoho WorkDrive folder sync", description: "Import new or changed WorkDrive files into instance knowledge.", status: "Connector" },
			{ name: "Webhook trigger", description: "Receive external events through an instance-scoped capability URL.", status: "Trigger" },
			{ name: "Cron trigger", description: "Run scheduled tasks, digests, monitoring, or connector syncs.", status: "Trigger" },
		],
	},
	{
		title: "MCP Account Tools",
		scope: "MCP clients",
		description: "Browser-authenticated tools for creating agents, managing private instances, knowledge, messages, and platform discovery.",
		tools: [
			{ name: "create_agent", description: "Create an agent record." },
			{ name: "scaffold_agent", description: "Generate starter files for an agent." },
			{ name: "update_agent", description: "Update agent metadata and configuration." },
			{ name: "subscribe_agent", description: "Create a private instance from a catalog agent." },
			{ name: "chat_with_instance", description: "Chat with a subscribed private instance." },
			{ name: "add_instance_knowledge", description: "Add private knowledge to an instance." },
			{ name: "platform_guide", description: "Read platform guidance through MCP." },
			{ name: "sdk_reference", description: "Read SDK reference guidance through MCP." },
		],
	},
];
