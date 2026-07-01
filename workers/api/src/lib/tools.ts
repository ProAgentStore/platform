/**
 * Agent tools — capabilities agents can invoke during their think loop.
 * Inspired by archagent's agent-tools.ts (update_task, read_memory, write_memory, etc.)
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AgentTask, MemoryEntry } from "../agent-types.js";
import { checkPublicHttpsUrl } from "./ssrf.js";

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<
		string,
		{ type: string; description: string; required?: boolean }
	>;
}

export interface ToolCallRequest {
	name: string;
	input: Record<string, unknown>;
}

export interface ToolCallResult {
	name: string;
	content: string;
	success: boolean;
}

/** All tools available to agents. */
export const AGENT_TOOLS: ToolDef[] = [
	{
		name: "read_memory",
		description:
			"Read all entries from your persistent memory, or filter by type.",
		parameters: {
			type: {
				type: "string",
				description:
					"Optional filter: identity, knowledge, preference, skill, context",
			},
		},
	},
	{
		name: "write_memory",
		description:
			"Write a key-value pair to your persistent memory. Survives across conversations.",
		parameters: {
			key: { type: "string", description: "Memory key", required: true },
			type: {
				type: "string",
				description: "Type: identity, knowledge, preference, skill, context",
				required: true,
			},
			content: {
				type: "string",
				description: "Content to store",
				required: true,
			},
		},
	},
	{
		name: "delete_memory",
		description: "Delete a memory entry by key.",
		parameters: {
			key: {
				type: "string",
				description: "Memory key to delete",
				required: true,
			},
		},
	},
	{
		name: "get_tasks",
		description: "List your current tasks and their status.",
		parameters: {},
	},
	{
		name: "create_task",
		description: "Create a new task for yourself.",
		parameters: {
			title: { type: "string", description: "Task title", required: true },
			description: { type: "string", description: "Task description" },
		},
	},
	{
		name: "update_task",
		description: "Update the status of a task.",
		parameters: {
			id: { type: "string", description: "Task ID", required: true },
			status: {
				type: "string",
				description: "New status: pending, in_progress, blocked, complete",
				required: true,
			},
		},
	},
	{
		name: "fetch_url",
		description: "Fetch content from a URL. Returns the response body as text.",
		parameters: {
			url: { type: "string", description: "URL to fetch", required: true },
			method: { type: "string", description: "HTTP method (default: GET)" },
		},
	},
	{
		name: "store_file",
		description: "Store a file in your persistent R2 storage.",
		parameters: {
			key: { type: "string", description: "File path/name", required: true },
			content: { type: "string", description: "File content", required: true },
			contentType: {
				type: "string",
				description: "MIME type (default: text/plain)",
			},
		},
	},
	{
		name: "read_file",
		description: "Read a file from your persistent R2 storage.",
		parameters: {
			key: { type: "string", description: "File path/name", required: true },
		},
	},
	{
		name: "list_files",
		description: "List files in your R2 storage.",
		parameters: {
			prefix: {
				type: "string",
				description: "Optional path prefix to filter by",
			},
		},
	},
];

/** Execute a tool call against DO storage + R2. */
export async function executeTool(
	call: ToolCallRequest,
	storage: DurableObjectStorage,
	r2: R2Bucket | null,
	agentId: string,
): Promise<ToolCallResult> {
	try {
		switch (call.name) {
			case "read_memory": {
				const all = await storage.list<MemoryEntry>({ prefix: "mem:" });
				let entries = [...all.values()];
				const typeFilter = call.input.type as string | undefined;
				if (typeFilter) entries = entries.filter((e) => e.type === typeFilter);
				return {
					name: call.name,
					content: JSON.stringify(entries),
					success: true,
				};
			}

			case "write_memory": {
				const { key, type, content } = call.input as {
					key: string;
					type: string;
					content: string;
				};
				if (!key || !type || content === undefined) {
					return {
						name: call.name,
						content: "key, type, content required",
						success: false,
					};
				}
				const entry: MemoryEntry = {
					key,
					type: type as MemoryEntry["type"],
					content,
					updatedAt: new Date().toISOString(),
				};
				await storage.put(`mem:${key}`, entry);
				return {
					name: call.name,
					content: `Stored memory: ${key}`,
					success: true,
				};
			}

			case "delete_memory": {
				const key = call.input.key as string;
				if (!key)
					return { name: call.name, content: "key required", success: false };
				await storage.delete(`mem:${key}`);
				return {
					name: call.name,
					content: `Deleted memory: ${key}`,
					success: true,
				};
			}

			case "get_tasks": {
				const all = await storage.list<AgentTask>({ prefix: "task:" });
				return {
					name: call.name,
					content: JSON.stringify([...all.values()]),
					success: true,
				};
			}

			case "create_task": {
				const { title, description } = call.input as {
					title: string;
					description?: string;
				};
				if (!title)
					return { name: call.name, content: "title required", success: false };
				const task: AgentTask = {
					id: crypto.randomUUID(),
					title,
					description: description || "",
					status: "pending",
					assignedBy: "self",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				await storage.put(`task:${task.id}`, task);
				return {
					name: call.name,
					content: `Created task: ${task.title} (${task.id})`,
					success: true,
				};
			}

			case "update_task": {
				const { id, status } = call.input as { id: string; status: string };
				if (!id || !status)
					return {
						name: call.name,
						content: "id and status required",
						success: false,
					};
				const existing = await storage.get<AgentTask>(`task:${id}`);
				if (!existing) {
					// Fallback: find by title (archagent pattern)
					const all = await storage.list<AgentTask>({ prefix: "task:" });
					const match = [...all.entries()].find(([, t]) =>
						t.title.toLowerCase().includes(id.toLowerCase()),
					);
					if (!match)
						return {
							name: call.name,
							content: `Task not found: ${id}`,
							success: false,
						};
					const [key, task] = match;
					task.status = status as AgentTask["status"];
					task.updatedAt = new Date().toISOString();
					await storage.put(key, task);
					return {
						name: call.name,
						content: `Updated task "${task.title}" to ${status}`,
						success: true,
					};
				}
				existing.status = status as AgentTask["status"];
				existing.updatedAt = new Date().toISOString();
				await storage.put(`task:${id}`, existing);
				return {
					name: call.name,
					content: `Updated task "${existing.title}" to ${status}`,
					success: true,
				};
			}

			case "fetch_url": {
				const url = call.input.url as string;
				const method = (call.input.method as string) || "GET";
				if (!url)
					return { name: call.name, content: "url required", success: false };
				// SSRF protection: https-only + reject non-public hosts (shared guard).
				const check = checkPublicHttpsUrl(url);
				if (!check.ok) return { name: call.name, content: check.reason, success: false };
				const res = await fetch(url, {
					method,
					headers: { "User-Agent": "ProAgentStore-Agent" },
				});
				const text = await res.text();
				const truncated =
					text.length > 4000 ? `${text.slice(0, 4000)}...[truncated]` : text;
				return { name: call.name, content: truncated, success: res.ok };
			}

			case "store_file": {
				if (!r2)
					return {
						name: call.name,
						content: "R2 storage not available",
						success: false,
					};
				const { key, content, contentType } = call.input as {
					key: string;
					content: string;
					contentType?: string;
				};
				if (!key || content === undefined)
					return {
						name: call.name,
						content: "key and content required",
						success: false,
					};
				await r2.put(`agents/${agentId}/${key}`, content, {
					httpMetadata: { contentType: contentType || "text/plain" },
				});
				return {
					name: call.name,
					content: `Stored file: ${key}`,
					success: true,
				};
			}

			case "read_file": {
				if (!r2)
					return {
						name: call.name,
						content: "R2 storage not available",
						success: false,
					};
				const key = call.input.key as string;
				if (!key)
					return { name: call.name, content: "key required", success: false };
				const obj = await r2.get(`agents/${agentId}/${key}`);
				if (!obj)
					return {
						name: call.name,
						content: `File not found: ${key}`,
						success: false,
					};
				const text = await obj.text();
				return { name: call.name, content: text, success: true };
			}

			case "list_files": {
				if (!r2)
					return {
						name: call.name,
						content: "R2 storage not available",
						success: false,
					};
				const prefix = (call.input.prefix as string) || "";
				const listed = await r2.list({ prefix: `agents/${agentId}/${prefix}` });
				const files = listed.objects.map((o) => ({
					key: o.key.replace(`agents/${agentId}/`, ""),
					size: o.size,
				}));
				return {
					name: call.name,
					content: JSON.stringify(files),
					success: true,
				};
			}

			default:
				return {
					name: call.name,
					content: `Unknown tool: ${call.name}`,
					success: false,
				};
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { name: call.name, content: `Tool error: ${msg}`, success: false };
	}
}
