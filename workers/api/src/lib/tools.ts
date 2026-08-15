/**
 * Agent tools — capabilities agents can invoke during their think loop.
 * Inspired by archagent's agent-tools.ts (update_task, read_memory, write_memory, etc.)
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AgentTask, MemoryEntry } from "../agent-types.js";
import { MAX_TASKS } from "./agent-tasks.js";
import { safeFetch, SsrfError } from "./ssrf.js";
import { annotateFetchResult } from "./fetch-url-diagnosis.js";
import { fenceUntrusted } from "./untrusted-fence.js";

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<
		string,
		{ type: string; description: string; required?: boolean }
	>;
}

/**
 * The draft-07 object schema for a legacy `ToolDef`, built from its ad-hoc `parameters` map.
 *
 * ONE converter, called by both readers of these definitions: `buildAgentToolDefinitions` (what the
 * model is shown) and `builtinToolPolicyInputs` (what the tool listing reports, #525). A second copy
 * would let the audit surface describe a different schema from the one the agent is offered, which
 * is the drift the listing exists to make impossible.
 */
export function legacyToolSchema(def: ToolDef): { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[] } {
	return {
		type: "object",
		properties: Object.fromEntries(Object.entries(def.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])),
		required: Object.entries(def.parameters)
			.filter(([, v]) => v.required)
			.map(([k]) => k),
	};
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
			"Store or update a fact in persistent memory (survives across conversations). Writing to an existing key OVERWRITES it. Check your current memory keys first: if one already covers this fact, write to that exact key — NEVER create a second key for the same fact (e.g. do not add user_language when language exists).",
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
		description:
			"Delete a memory entry by its exact key. Only claim a memory was deleted after this returns success.",
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
			body: { type: "string", description: "Request body for POST/PUT/PATCH (e.g. a JSON string)" },
			contentType: { type: "string", description: "Content-Type for the body (default: application/json)" },
		},
	},
	// `store_file` was DELETED here (#444), not grouped into the `files` catalog group.
	//
	// It had a definition, a working handler that put bytes in R2, and membership in no
	// TOOL_CATALOG group — the `delete_record` shape, unreachable through every path including an
	// explicit `capabilities.tools:["store_file"]`, which `toolNamesFor` drops without a word.
	//
	// Grouping it would have been WORSE than leaving it inert. It wrote to the legacy
	// `agents/{agentId}/{key}` prefix, while the storage engine keeps files at
	// `agents/{agentId}/files/{id}/{name}`. The two names below that read that legacy prefix are
	// themselves shadowed: `buildAgentToolDefinitions` merges AGENT_TOOLS then STORAGE_TOOLS into
	// one Map by name, and `agent-think.ts` checks `storageToolNames` BEFORE this executor — so
	// `read_file`/`list_files` resolve to the storage engine's versions everywhere. Putting
	// `store_file` in the `files` group (which flows into FULL, the default for every agent that
	// declares nothing) would therefore have handed every production agent a write whose result no
	// tool can list, read or delete. `upload_file` (storage-tools.ts) is the write that works.
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
	{
		name: "configure_board",
		description:
			"Customize your own work board — the kanban shown in the console. Set `columns` to a JSON array of {id,title,color?,statuses?,catchAll?} to replace the columns (ordered; each card lands in the first column whose `statuses` include its status, else the column with catchAll:true). Set `view` to 'kanban' or 'list' to change the default view. Set reset:true to drop your custom columns and use the agent's defaults. Do this when the user asks to add/rename/reorder columns or switch views.",
		parameters: {
			columns: { type: "string", description: 'JSON array of columns, e.g. [{"id":"todo","title":"To do","color":"#eab308","statuses":["queued"]},{"id":"done","title":"Done","color":"#22c55e","statuses":["completed"],"catchAll":true}]' },
			view: { type: "string", description: "Default board view: 'kanban' or 'list'." },
			reset: { type: "boolean", description: "Set true to remove custom columns and fall back to the agent's default columns." },
		},
	},
];

/** One-line snapshot of all memory keys, appended to write/delete results so the
 *  model immediately sees duplicates it just created (e.g. `language` AND `user_language`). */
/**
 * A memory row as `read_memory` hands it back, with the platform's reading of its own provenance.
 *
 * Only `source: "summary"` rows gain anything: those were INFERRED by a summariser from a past
 * conversation, with no way to know whether it was reading a durable fact or a momentary one. A
 * user-set or agent-written entry is left byte-identical.
 */
export function markInferred(m: MemoryEntry): MemoryEntry & { inferred?: true; note?: string } {
	if (m.source !== "summary") return m;
	return {
		...m,
		inferred: true,
		note: "Auto-noted by a summariser from an earlier conversation, not told to you. A live tool result or a status block in your prompt is current and outranks this — check it now rather than refusing or reporting on the strength of this entry.",
	};
}

async function memoryKeyList(storage: DurableObjectStorage): Promise<string> {
	const all = await storage.list<MemoryEntry>({ prefix: "mem:" });
	const keys = [...all.keys()].map((k) => k.slice("mem:".length)).sort();
	return keys.length === 0
		? "Memory is now empty."
		: `All memory keys: ${keys.join(", ")}`;
}

/**
 * What `fetch_url` needs to know about the CALLER in order to explain its own failures (#494/#493).
 *
 * Optional, and absent means "annotate nothing": the diagnosis asserts things about this agent's
 * resolved tool set, so a caller that cannot supply one must not get a note guessing at it.
 * `agent-think.ts` is the only caller today and passes both.
 */
export interface ToolExecContext {
	/** Resolved tool names — post-allowlist, post-`config.disabledTools`. */
	toolNames?: ReadonlySet<string>;
	/** `config.githubRepo`, unvalidated; the diagnosis applies the Deployment block's own guard. */
	configuredRepo?: unknown;
}

/** Execute a tool call against DO storage + R2. */
export async function executeTool(
	call: ToolCallRequest,
	storage: DurableObjectStorage,
	r2: R2Bucket | null,
	agentId: string,
	ctx: ToolExecContext = {},
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
					// THE SECOND DOOR (#495). The dated, ranked `## Your Memory` block bounds what the
					// prompt repeats; this tool returns the same rows raw, and it is the door the
					// incident actually came through — `read_memory` surfaced "Write access to terminal
					// connector is not enabled" at 07:15:19 and the agent refused a call it was
					// permitted to make eight minutes later. A rule in the prompt about entries "marked
					// auto-noted" says nothing about a JSON row that carries no marking, and the entry
					// this tool returns may be one the prompt deliberately stopped repeating.
					//
					// So the fact travels WITH the data rather than as a rule about it: `stale` is
					// derived from `source`, which is provenance the platform recorded rather than a
					// judgement about the content.
					content: JSON.stringify(entries.map(markInferred)),
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
				// Runtime guard for user-owned memory: the prompt tells the model not to
				// overwrite (user-set) entries, but that's advisory only — untrusted RAG /
				// webhook text (treated as attacker-authored) could nudge a write_memory that
				// clobbers a user fact AND flips its source to "agent", destroying the marker.
				// Enforce it: never overwrite a source:"user" entry from a tool call.
				const priorMem = await storage.get<MemoryEntry>(`mem:${key}`);
				if (priorMem?.source === "user") {
					return {
						name: call.name,
						content: `"${key}" is user-set and protected — leave it as the user defined it. Use a different key to record something related.`,
						success: false,
					};
				}
				const entry: MemoryEntry = {
					key,
					type: type as MemoryEntry["type"],
					content,
					updatedAt: new Date().toISOString(),
					source: "agent",
				};
				await storage.put(`mem:${key}`, entry);
				return {
					name: call.name,
					// WHAT MEMORY IS NOT (#506). Asked to file two GitHub bug reports it had no tool
					// for, the Coder Lead wrote `fact:pending issue:Heartfull:event link shows ID
					// instead of event name` and said "I'll file the issue as soon as the current run
					// finishes". Nothing schedules that. Nothing re-reads memory on an event. The bug
					// report was still a memory key when the owner asked again the next day.
					//
					// The belief that produced it is about the PLATFORM, not about the request: that
					// something will come back for this. It is stated in the tool result rather than in
					// a prompt rule for the reason this repo has now recorded three times (#493, #494,
					// #517) — a standing instruction loses to what the model concludes in the turn it
					// is in, and the fix that holds puts the fact in the data it is looking at.
					content:
						`Stored memory: ${key}. ${await memoryKeyList(storage)}` +
						" Memory is only read back into your prompt — nothing acts on it, and no event will wake you to finish" +
						" something you left here. If this records work still to be done, do it now or create_task it;" +
						" a note to yourself is not a record anyone will act on.",
					success: true,
				};
			}

			case "delete_memory": {
				const key = call.input.key as string;
				if (!key)
					return { name: call.name, content: "key required", success: false };
				// Same protection as write_memory: a tool call must not delete a user-set entry.
				const toDelete = await storage.get<MemoryEntry>(`mem:${key}`);
				if (toDelete?.source === "user") {
					return { name: call.name, content: `"${key}" is user-set and protected — only the user can remove it.`, success: false };
				}
				const existed = await storage.delete(`mem:${key}`);
				if (!existed)
					return {
						name: call.name,
						content: `No memory with key: ${key}. ${await memoryKeyList(storage)}`,
						success: false,
					};
				return {
					name: call.name,
					content: `Deleted memory: ${key}. ${await memoryKeyList(storage)}`,
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
				// The store is durable and, before #337, only the agent itself ever marked a task
				// complete — so without a ceiling "the agent keeps a list" becomes an unbounded pile
				// of self-assigned work that steers every future turn. Refuse honestly and name the
				// way out rather than silently dropping the write.
				const held = await storage.list<AgentTask>({ prefix: "task:" });
				if (held.size >= MAX_TASKS)
					return {
						name: call.name,
						content: `Task limit reached (${MAX_TASKS} tasks). Complete or delete some before creating more.`,
						success: false,
					};
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
				const method = ((call.input.method as string) || "GET").toUpperCase();
				const body = call.input.body as string | undefined;
				if (!url)
					return { name: call.name, content: "url required", success: false };
				const headers: Record<string, string> = { "User-Agent": "ProAgentStore-Agent" };
				const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";
				if (hasBody) headers["Content-Type"] = (call.input.contentType as string) || "application/json";
				// SSRF protection: https-only + reject non-public hosts, re-validated on EVERY
				// redirect hop (a public host can 302 you to 127.0.0.1 / metadata otherwise).
				let res: Response;
				try {
					res = await safeFetch(url, { method, headers, body: hasBody ? body : undefined });
				} catch (e) {
					return { name: call.name, content: e instanceof SsrfError ? e.message : `fetch failed: ${e instanceof Error ? e.message : String(e)}`, success: false };
				}
				const text = await res.text();
				const truncated =
					text.length > 4000 ? `${text.slice(0, 4000)}...[truncated]` : text;
				// #308: up to 4000 characters of an arbitrary page, straight onto the instruction
				// path — and the URL routinely comes from a document the agent just read, so this is
				// the most obviously attacker-authored text any tool returns. Fenced with the same
				// module RAG and the MCP resource reads use (#263); a hand-written wrapper here would
				// lack `neutralizeFenceMarkers` and the body could close its own block.
				//
				// The BODY only. Our own framing — the status line below — stays outside, or the
				// model loses the ability to tell a 500 from a page containing the word 500.
				const fenced = fenceUntrusted(truncated, `the page at ${url}`);
				// On a failure, lead with the HTTP status so the agent (and the durable log)
				// know HOW it failed — a bare "Internal Server Error" body hid that it was a
				// 500 vs a 4xx, which let an agent misread it as "queued".
				// The status is read HERE, from the response, rather than parsed back out of the string
				// below — the framing above is a display decision and a diagnosis that depended on it
				// would break silently the first time someone reworded it.
				//
				// Appended AFTER the fence, never inside it: this is the platform's own voice, and the
				// note is only ever added on a failure status, where the result already carries the
				// `HTTP …` prefix outside the block (so `unfenceUntrusted` could not have matched it
				// anyway, and nothing downstream changes shape).
				return annotateFetchResult(
					{
						name: call.name,
						content: res.ok ? fenced : `HTTP ${res.status} ${res.statusText}: ${truncated ? fenced : "(no response body)"}`,
						success: res.ok,
					},
					{ url, status: res.status, toolNames: ctx.toolNames, configuredRepo: ctx.configuredRepo },
				);
			}

			// `store_file`'s handler is deleted with its definition (#444) — see the note above
			// AGENT_TOOLS. Nothing could dispatch to it: it was in no catalog group, so
			// `toolNamesFor` never enabled the name on any path.

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
