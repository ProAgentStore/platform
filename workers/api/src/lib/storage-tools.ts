/**
 * Storage tools — capabilities agents can invoke for files, collections, and vector search.
 * Extends the base AGENT_TOOLS with the new storage engine.
 */
import { AgentStorageEngine } from "../agent-storage.js";
import type { CollectionField } from "../agent-storage-types.js";
import type { ToolCallResult, ToolDef } from "./tools.js";

export interface StorageToolCallRequest {
	name: string;
	input: Record<string, unknown>;
}

/** Storage-specific tools available to agents. */
export const STORAGE_TOOLS: ToolDef[] = [
	// ── Vector Search ─────────────────────────────────────────────────────────
	{
		name: "search_knowledge",
		description:
			"Semantic search across your knowledge base, conversation history, and files. Returns the most relevant chunks.",
		parameters: {
			query: { type: "string", description: "Natural language search query", required: true },
			top_k: { type: "number", description: "Number of results (default 5, max 20)" },
			source_type: { type: "string", description: "Filter by source: knowledge, message, file, collection" },
		},
	},

	// ── File Storage ──────────────────────────────────────────────────────────
	{
		name: "upload_file",
		description:
			"Store a file (text content) in your persistent file storage. For documents, notes, resumes, reports.",
		parameters: {
			name: { type: "string", description: "File name with extension", required: true },
			content: { type: "string", description: "File content (text)", required: true },
			mime_type: { type: "string", description: "MIME type (default: text/plain)" },
			path: { type: "string", description: "Virtual folder path (e.g. /resumes/)" },
			tags: { type: "string", description: "Comma-separated tags for organization" },
		},
	},
	{
		name: "list_files",
		description: "List files in your storage, optionally filtered by tags or MIME type.",
		parameters: {
			tags: { type: "string", description: "Comma-separated tags to filter by" },
			mime_type: { type: "string", description: "Filter by MIME type prefix (e.g. application/pdf)" },
		},
	},
	{
		name: "read_file",
		description: "Read a file's contents from your storage by ID.",
		parameters: {
			id: { type: "string", description: "File ID", required: true },
		},
	},
	{
		name: "delete_file",
		description: "Delete a file from your storage.",
		parameters: {
			id: { type: "string", description: "File ID to delete", required: true },
		},
	},

	// ── Collections (Structured Storage) ──────────────────────────────────────
	{
		name: "create_collection",
		description:
			"Create a new data collection (like a database table). Define fields with types and indexing.",
		parameters: {
			name: { type: "string", description: "Collection name (lowercase, no spaces)", required: true },
			fields: {
				type: "string",
				description:
					'JSON array of field definitions. Each: {"name":"...", "type":"string|number|boolean|date|json|reference", "required":true/false, "indexed":true/false}',
				required: true,
			},
		},
	},
	{
		name: "list_collections",
		description: "List all your data collections and their schemas.",
		parameters: {},
	},
	{
		name: "insert_record",
		description: "Insert a new record into a collection.",
		parameters: {
			collection: { type: "string", description: "Collection name", required: true },
			data: { type: "string", description: "JSON object with field values", required: true },
		},
	},
	{
		name: "query_records",
		description: "Query records from a collection with optional filtering and sorting.",
		parameters: {
			collection: { type: "string", description: "Collection name", required: true },
			where: { type: "string", description: "JSON filter object (e.g. {\"status\":\"active\"})" },
			order_by: { type: "string", description: "Field name to sort by" },
			order_dir: { type: "string", description: "Sort direction: asc or desc" },
			limit: { type: "number", description: "Max results (default 50)" },
		},
	},
	{
		name: "update_record",
		description: "Update fields on an existing record.",
		parameters: {
			collection: { type: "string", description: "Collection name", required: true },
			id: { type: "string", description: "Record ID", required: true },
			data: { type: "string", description: "JSON object with fields to update", required: true },
		},
	},
	{
		name: "delete_record",
		description: "Delete a record from a collection.",
		parameters: {
			collection: { type: "string", description: "Collection name", required: true },
			id: { type: "string", description: "Record ID", required: true },
		},
	},

	// ── Activity & Context ────────────────────────────────────────────────────
	{
		name: "get_activity",
		description: "Get your recent activity log (tool calls, events, file uploads, etc.).",
		parameters: {
			limit: { type: "number", description: "Number of events (default 20)" },
			type: { type: "string", description: "Filter by event type" },
		},
	},
	{
		name: "get_user_context",
		description: "Get information about a user you've interacted with (preferences, history count).",
		parameters: {
			user_id: { type: "string", description: "User ID", required: true },
		},
	},
	{
		name: "set_user_preference",
		description: "Remember a preference or fact about a specific user.",
		parameters: {
			user_id: { type: "string", description: "User ID", required: true },
			key: { type: "string", description: "Preference key (e.g. 'timezone', 'language')", required: true },
			value: { type: "string", description: "Preference value", required: true },
		},
	},
	{
		name: "submit_job_application",
		description: "Create an approval-gated browser runner task to submit a job application. This only creates the browser task; the application is not submitted until the user approves the task and the runner completes it. Do not mark application records as submitted from this tool result alone.",
		parameters: {
			url: { type: "string", description: "Job posting URL", required: true },
			resume_path: { type: "string", description: "Absolute local path to the resume file on the connected runner machine", required: true },
			full_name: { type: "string", description: "Candidate full name", required: true },
			email: { type: "string", description: "Candidate email", required: true },
			phone: { type: "string", description: "Candidate phone number" },
			location: { type: "string", description: "Candidate location" },
			linkedin: { type: "string", description: "Candidate LinkedIn URL" },
			portfolio: { type: "string", description: "Candidate portfolio URL" },
			work_authorization: { type: "string", description: "Candidate work authorization status" },
			cover_note: { type: "string", description: "Cover note text to paste into the application form" },
			authenticated: { type: "boolean", description: "Use an authenticated application flow when true. Defaults to true." },
		},
	},
];

export interface StorageToolContext {
	env?: { DB: D1Database; KEY_ENCRYPTION_KEY?: string };
	agentId?: string;
	userId?: string;
}

/** Execute a storage tool call. */
export async function executeStorageTool(
	call: StorageToolCallRequest,
	engine: AgentStorageEngine,
	ctx?: StorageToolContext,
): Promise<ToolCallResult> {
	try {
		switch (call.name) {
			case "search_knowledge": {
				const query = call.input.query as string;
				if (!query) return fail(call.name, "query required");
				const topK = Math.min(Number(call.input.top_k) || 5, 20);
				const sourceType = call.input.source_type as string | undefined;
				const results = await engine.vectorSearch(query, topK, {
					sourceType: sourceType as "knowledge" | "message" | "file" | "collection" | undefined,
				});
				if (results.length === 0) {
					return ok(call.name, "No relevant results found. The knowledge base may be empty or the query didn't match any stored content.");
				}
				return ok(call.name, JSON.stringify(results, null, 2));
			}

			case "upload_file": {
				const name = call.input.name as string;
				const content = call.input.content as string;
				if (!name || !content) return fail(call.name, "name and content required");
				const meta = await engine.fileUpload({
					name,
					path: (call.input.path as string) || `/${name}`,
					mimeType: (call.input.mime_type as string) || guessMimeType(name),
					data: content,
					tags: (call.input.tags as string)?.split(",").map((t) => t.trim()).filter(Boolean) || [],
				});
				return ok(call.name, `File stored: ${meta.name} (${meta.id}, ${meta.size} bytes)`);
			}

			case "list_files": {
				const tags = (call.input.tags as string)?.split(",").map((t) => t.trim()).filter(Boolean);
				const files = await engine.fileList({
					tags,
					mimeType: call.input.mime_type as string | undefined,
				});
				if (files.length === 0) return ok(call.name, "No files in storage.");
				const summary = files.map((f) => `- ${f.name} (${f.id}) ${f.size}b [${f.tags.join(",")}] ${f.createdAt.split("T")[0]}`).join("\n");
				return ok(call.name, `${files.length} files:\n${summary}`);
			}

			case "read_file": {
				const id = call.input.id as string;
				if (!id) return fail(call.name, "id required");
				const file = await engine.fileGet(id);
				if (!file) return fail(call.name, `File not found: ${id}`);
				const reader = file.body.getReader();
				const chunks: Uint8Array[] = [];
				for (;;) {
					const { value, done } = await reader.read();
					if (value) chunks.push(value);
					if (done) break;
				}
				const text = new TextDecoder().decode(
					chunks.length > 0 ? concatUint8Arrays(chunks) : new Uint8Array(0),
				);
				const truncated = text.length > 4000 ? `${text.slice(0, 4000)}...[truncated]` : text;
				return ok(call.name, `File: ${file.meta.name}\n\n${truncated}`);
			}

			case "delete_file": {
				const id = call.input.id as string;
				if (!id) return fail(call.name, "id required");
				const deleted = await engine.fileDelete(id);
				return deleted ? ok(call.name, `File deleted: ${id}`) : fail(call.name, `File not found: ${id}`);
			}

			case "create_collection": {
				const name = call.input.name as string;
				const fieldsJson = call.input.fields as string;
				if (!name || !fieldsJson) return fail(call.name, "name and fields required");
				if (!/^[a-z][a-z0-9_]{0,49}$/.test(name)) {
					return fail(call.name, "Collection name must be lowercase alphanumeric (a-z, 0-9, _), start with a letter, max 50 chars");
				}
				let fields: CollectionField[];
				try {
					fields = JSON.parse(fieldsJson);
					if (!Array.isArray(fields)) throw new Error("fields must be an array");
				} catch (e) {
					return fail(call.name, `Invalid fields JSON: ${e instanceof Error ? e.message : String(e)}`);
				}
				const schema = await engine.collectionCreate(name, fields);
				return ok(call.name, `Collection "${schema.name}" created with ${schema.fields.length} fields`);
			}

			case "list_collections": {
				const collections = await engine.collectionList();
				if (collections.length === 0) return ok(call.name, "No collections defined.");
				const summary = collections.map((c) =>
					`- ${c.name}: ${c.fields.map((f) => `${f.name}:${f.type}${f.indexed ? "*" : ""}`).join(", ")} (${c.recordCount} records)`,
				).join("\n");
				return ok(call.name, `${collections.length} collections:\n${summary}`);
			}

			case "insert_record": {
				const collection = call.input.collection as string;
				const dataJson = call.input.data as string;
				if (!collection || !dataJson) return fail(call.name, "collection and data required");
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(dataJson);
				} catch {
					return fail(call.name, "Invalid data JSON");
				}
				const record = await engine.recordInsert(collection, data);
				return ok(call.name, `Record inserted: ${record.id} in ${collection}`);
			}

			case "query_records": {
				const collection = call.input.collection as string;
				if (!collection) return fail(call.name, "collection required");
				let where: Record<string, unknown> | undefined;
				if (call.input.where) {
					try {
						where = JSON.parse(call.input.where as string);
					} catch {
						return fail(call.name, "Invalid where JSON");
					}
				}
				const result = await engine.recordQuery(collection, {
					where,
					orderBy: call.input.order_by as string | undefined,
					orderDir: call.input.order_dir as "asc" | "desc" | undefined,
					limit: Number(call.input.limit) || 50,
				});
				return ok(call.name, JSON.stringify({ total: result.total, records: result.records }, null, 2));
			}

			case "update_record": {
				const collection = call.input.collection as string;
				const id = call.input.id as string;
				const dataJson = call.input.data as string;
				if (!collection || !id || !dataJson) return fail(call.name, "collection, id, and data required");
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(dataJson);
				} catch {
					return fail(call.name, "Invalid data JSON");
				}
				const updated = await engine.recordUpdate(collection, id, data);
				return updated
					? ok(call.name, `Record ${id} updated in ${collection}`)
					: fail(call.name, `Record not found: ${id}`);
			}

			case "delete_record": {
				const collection = call.input.collection as string;
				const id = call.input.id as string;
				if (!collection || !id) return fail(call.name, "collection and id required");
				const deleted = await engine.recordDelete(collection, id);
				return deleted
					? ok(call.name, `Record ${id} deleted from ${collection}`)
					: fail(call.name, `Record not found: ${id}`);
			}

			case "get_activity": {
				const events = await engine.getEvents({
					limit: Number(call.input.limit) || 20,
					type: call.input.type as ActivityEvent["type"] | undefined,
				});
				if (events.length === 0) return ok(call.name, "No recent activity.");
				const summary = events.map((e) =>
					`[${e.createdAt}] ${e.type}${e.userId ? ` (user: ${e.userId})` : ""} ${e.data ? JSON.stringify(e.data) : ""}`,
				).join("\n");
				return ok(call.name, summary);
			}

			case "get_user_context": {
				const userId = call.input.user_id as string;
				if (!userId) return fail(call.name, "user_id required");
				const ctx = await engine.getUserContext(userId);
				return ok(call.name, JSON.stringify(ctx, null, 2));
			}

			case "set_user_preference": {
				const userId = call.input.user_id as string;
				const key = call.input.key as string;
				const value = call.input.value as string;
				if (!userId || !key || !value) return fail(call.name, "user_id, key, and value required");
				await engine.setUserPreference(userId, key, value);
				return ok(call.name, `Stored preference for user ${userId}: ${key} = ${value}`);
			}

			case "submit_job_application": {
				if (!ctx?.env || !ctx.agentId || !ctx.userId) {
					return fail(call.name, "Runtime context not available");
				}
				const url = stringInput(call.input.url);
				if (!url) return fail(call.name, "url required");
				const resumePath = stringInput(call.input.resume_path) || stringInput(call.input.resumePath);
				if (!resumePath) {
					return fail(call.name, "resume_path required: provide an absolute local file path on the connected runner machine.");
				}
				const candidateInput = isPlainRecord(call.input.candidate) ? call.input.candidate : {};
				const fullName = stringInput(candidateInput.fullName) || stringInput(candidateInput.full_name) || stringInput(call.input.full_name) || stringInput(call.input.fullName);
				const email = stringInput(candidateInput.email) || stringInput(call.input.email);
				if (!fullName) return fail(call.name, "full_name required");
				if (!email) return fail(call.name, "email required");

				// Look up the connected runtime
				const runtime = await ctx.env.DB.prepare(
					"SELECT endpoint_url, token_plaintext, token_ciphertext, token_dek_wrapped, token_iv FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2 AND status != 'offline'",
				).bind(ctx.agentId, ctx.userId).first<{ endpoint_url: string; token_plaintext: string | null; token_ciphertext: ArrayBuffer | null; token_dek_wrapped: ArrayBuffer | null; token_iv: ArrayBuffer | null }>();

				if (!runtime?.endpoint_url) {
					return fail(call.name, "No browser runner connected. Start the runner with: pags up");
				}

				// Decrypt runner token
				let runnerToken = runtime.token_plaintext || "";
				if (!runnerToken && runtime.token_ciphertext && ctx.env.KEY_ENCRYPTION_KEY) {
					try {
						const { decryptKey } = await import("./crypto.js");
						runnerToken = await decryptKey(
							new Uint8Array(runtime.token_ciphertext as ArrayBuffer),
							new Uint8Array(runtime.token_dek_wrapped as ArrayBuffer),
							new Uint8Array(runtime.token_iv as ArrayBuffer),
							ctx.env.KEY_ENCRYPTION_KEY,
						);
					} catch { /* use empty */ }
				}

				// Create task on the runner
				const authenticated = call.input.authenticated !== false;
				const taskBody = {
					type: authenticated ? "job.apply_authenticated" : "job.apply_basic",
					input: {
						url,
						resumePath,
						candidate: {
							fullName,
							email,
							phone: optionalInput(candidateInput.phone) || optionalInput(call.input.phone),
							location: optionalInput(candidateInput.location) || optionalInput(call.input.location),
							linkedin: optionalInput(candidateInput.linkedin) || optionalInput(call.input.linkedin),
							portfolio: optionalInput(candidateInput.portfolio) || optionalInput(call.input.portfolio),
							workAuthorization:
								optionalInput(candidateInput.workAuthorization) ||
								optionalInput(candidateInput.work_authorization) ||
								optionalInput(call.input.work_authorization) ||
								optionalInput(call.input.workAuthorization),
						},
						coverNote: optionalInput(call.input.cover_note) || optionalInput(call.input.coverNote) || "",
					},
				};

				const headers: Record<string, string> = { "Content-Type": "application/json" };
				if (runnerToken) headers.Authorization = `Bearer ${runnerToken}`;
				headers["X-PAGS-Instance-Id"] = ctx.agentId;

				const taskRes = await fetch(`${runtime.endpoint_url}/tasks`, {
					method: "POST",
					headers,
					body: JSON.stringify(taskBody),
				});

				if (!taskRes.ok) {
					const err = await taskRes.text().catch(() => "unknown error");
					return fail(call.name, `Runner rejected task: ${err.slice(0, 200)}`);
				}

				const task = await taskRes.json() as { id?: string; status?: string };

				const approval = task.status === "needs_approval" && task.id
					? ` Approve it in the console or run: pags runner approve-task ${ctx.agentId} ${task.id}`
					: "";
				return ok(
					call.name,
					`Browser task created: ${task.id ?? "unknown"} (status: ${task.status ?? "unknown"}). This has not submitted the application yet. Do not mark the application record submitted until this runner task completes successfully.${approval}`,
				);
			}

			default:
				return fail(call.name, `Unknown storage tool: ${call.name}`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return fail(call.name, `Tool error: ${msg}`);
	}
}

// Import needed for type in get_activity
import type { ActivityEvent } from "../agent-storage-types.js";

function ok(name: string, content: string): ToolCallResult {
	return { name, content, success: true };
}

function fail(name: string, content: string): ToolCallResult {
	return { name, content, success: false };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringInput(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function optionalInput(value: unknown): string | undefined {
	const text = stringInput(value);
	return text || undefined;
}

function guessMimeType(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() || "";
	const map: Record<string, string> = {
		txt: "text/plain",
		md: "text/markdown",
		json: "application/json",
		csv: "text/csv",
		html: "text/html",
		xml: "application/xml",
		pdf: "application/pdf",
		doc: "application/msword",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		svg: "image/svg+xml",
		mp3: "audio/mpeg",
		mp4: "video/mp4",
		zip: "application/zip",
	};
	return map[ext] || "application/octet-stream";
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((sum, a) => sum + a.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}
