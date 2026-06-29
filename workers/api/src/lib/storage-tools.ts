/**
 * Storage tools — capabilities agents can invoke for files, collections, and vector search.
 * Extends the base AGENT_TOOLS with the new storage engine.
 */
import { AgentStorageEngine } from "../agent-storage.js";
import type { CollectionField } from "../agent-storage-types.js";
import type { ToolCallResult, ToolDef } from "./tools.js";
import { listRepos, listSessions, getActiveSessionForRepo } from "./coding-store.js";
import type { Env } from "../types.js";

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
			"Semantic search across your knowledge base, indexed repository code, conversation history, and files. Returns the most relevant chunks. Leave source_type unset to search everything (including indexed repo code).",
		parameters: {
			query: { type: "string", description: "Natural language search query", required: true },
			top_k: { type: "number", description: "Number of results (default 5, max 20)" },
			source_type: { type: "string", description: "Optional filter by source: knowledge, repo, message, file, collection" },
		},
	},

	// ── Knowledge base management (editable via chat) ───────────────────────────
	{
		name: "list_knowledge",
		description:
			"List the documents in the knowledge base with their id, title and size. Use this first to find which document to read, amend, or delete.",
		parameters: {},
	},
	{
		name: "read_knowledge",
		description: "Read the full text of one knowledge-base document by id (e.g. before amending it).",
		parameters: {
			id: { type: "string", description: "Document id from list_knowledge", required: true },
		},
	},
	{
		name: "update_knowledge",
		description:
			"Amend a knowledge-base document — replace its content and/or title. To make a small edit, read_knowledge first, change the text, then pass the FULL new content here.",
		parameters: {
			id: { type: "string", description: "Document id from list_knowledge", required: true },
			content: { type: "string", description: "The full new content of the document" },
			title: { type: "string", description: "New title (optional)" },
		},
	},
	{
		name: "delete_knowledge",
		description: "Permanently delete a knowledge-base document by id. Confirm with the user first.",
		parameters: {
			id: { type: "string", description: "Document id from list_knowledge", required: true },
		},
	},
	{
		name: "add_knowledge",
		description: "Add a new document to the knowledge base (max 20 documents).",
		parameters: {
			title: { type: "string", description: "Document title", required: true },
			content: { type: "string", description: "Document content (text)", required: true },
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
		description: "Start the LLM-driven job application: an agent drives a real browser to fill and submit the form, using the user's saved candidate Profile. Call it ONCE per job. It does not finish instantly — it runs in the background and pauses in the console Board only for a captcha, a stuck widget, or a missing value. Do not call it again for the same job, and do not claim the application is submitted from this tool result. Requires a connected runner (pags up). HONESTY: only report an application as started if THIS tool returns success with a real task id — if it returns an error, tell the user that exact error and that nothing started. Never invent a task or workflow id. ORDER: call THIS tool first; only AFTER it returns success should you insert_record the application into the 'applications' collection — never log an application that did not actually start, or the Board shows phantom applications.",
		parameters: {
			url: { type: "string", description: "Job posting URL", required: true },
			resume_path: { type: "string", description: "Optional. Leave empty — the apply uses the résumé the user uploaded in the console; the runner downloads it." },
			full_name: { type: "string", description: "Candidate full name (optional — falls back to the saved Profile)" },
			email: { type: "string", description: "Candidate email (optional — falls back to the saved Profile)" },
			cover_note: { type: "string", description: "Cover note text for the application form" },
		},
	},
	{
		name: "find_confirmation_link",
		description: "Search the user's connected Gmail (read-only) for a recent confirmation/verification email and return the action link to open — e.g. to confirm a newly registered account. Only available when the user has connected Gmail and granted this agent email permission.",
		parameters: {
			from: { type: "string", description: "Sender to filter by, e.g. a domain like 'coles' or 'noreply@coles.com.au'" },
			subject: { type: "string", description: "Words expected in the subject, e.g. 'confirm your account'" },
			within_days: { type: "number", description: "How many days back to search (1-7, default 1)" },
		},
	},

	// ── Coding tools (Coder agent) ────────────────────────────────────────────
	{
		name: "list_coding_repos",
		description: "List the coding repositories attached to this instance, with their status and active sessions.",
		parameters: {},
	},
	{
		name: "read_terminal",
		description: "Read the current terminal output from an active coding session. Shows what the Engine (Claude Code / Codex / etc.) is doing right now.",
		parameters: {
			repo_name: { type: "string", description: "Repository name (from list_coding_repos)", required: true },
		},
	},
	{
		name: "send_to_cli",
		description: "Send an instruction to the coding Engine (CLI running in tmux) for a specific repo. The Engine will execute it.",
		parameters: {
			repo_name: { type: "string", description: "Repository name", required: true },
			message: { type: "string", description: "Instruction to send to the CLI", required: true },
		},
	},
];

export interface StorageToolContext {
	env?: Env;
	agentId?: string;
	userId?: string;
	/** Runtime permission: email access granted on the agent state. */
	emailPermitted?: boolean;
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
					sourceType: sourceType as "knowledge" | "repo" | "message" | "file" | "collection" | undefined,
				});
				if (results.length === 0) {
					return ok(call.name, "No relevant results found. The knowledge base may be empty or the query didn't match any stored content.");
				}
				return ok(call.name, JSON.stringify(results, null, 2));
			}

			case "list_knowledge": {
				const docs = await engine.listKnowledge();
				if (docs.length === 0) return ok(call.name, "The knowledge base is empty.");
				return ok(call.name, JSON.stringify(docs, null, 2));
			}

			case "read_knowledge": {
				const id = call.input.id as string;
				if (!id) return fail(call.name, "id required");
				const doc = await engine.readKnowledge(id);
				if (!doc) return fail(call.name, `No knowledge document with id ${id}. Use list_knowledge to get valid ids.`);
				return ok(call.name, JSON.stringify({ id: doc.id, title: doc.title, content: doc.content }, null, 2));
			}

			case "update_knowledge": {
				const id = call.input.id as string;
				if (!id) return fail(call.name, "id required");
				const content = call.input.content as string | undefined;
				const title = call.input.title as string | undefined;
				if (!content && !title) return fail(call.name, "provide new content and/or title");
				const updated = await engine.updateKnowledge(id, { content, title });
				if (!updated) return fail(call.name, `No knowledge document with id ${id}.`);
				return ok(call.name, `Updated "${updated.title}" (${updated.content.length} chars).`);
			}

			case "delete_knowledge": {
				const id = call.input.id as string;
				if (!id) return fail(call.name, "id required");
				const deleted = await engine.deleteKnowledge(id);
				if (!deleted) return fail(call.name, `No knowledge document with id ${id}.`);
				return ok(call.name, `Deleted "${deleted.title}".`);
			}

			case "add_knowledge": {
				const title = call.input.title as string;
				const content = call.input.content as string;
				if (!title || !content) return fail(call.name, "title and content required");
				const doc = await engine.addKnowledge(title, content);
				if (!doc) return fail(call.name, "Knowledge base is full (max 20 documents). Delete one first.");
				return ok(call.name, `Added "${doc.title}" (id ${doc.id}).`);
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
				// resume_path is optional — the apply uses the résumé the user uploaded
				// in the console (Knowledge → Résumé), which the runner downloads. A local
				// path is only a legacy fallback for a same-machine runner.
				const resumePath = stringInput(call.input.resume_path) || stringInput(call.input.resumePath) || "";
				const candidateInput = isPlainRecord(call.input.candidate) ? call.input.candidate : {};
				// One apply path: start the LLM-driven JobApplyWorkflow (same as the
				// console /apply). The brain drives the real browser; no selectors, no
				// approval gate. It pauses for the user only on captcha/stuck/needs_input.
				try {
					const { startJobApply } = await import("../routes/instances-apply.js");
					// ctx.env is the full worker Env at runtime (the tool context types it
					// narrowly); startJobApply needs JOB_APPLY + runtime bindings.
					const fullEnv = ctx.env as unknown as Parameters<typeof startJobApply>[0];
					const { workflowId, taskId } = await startJobApply(fullEnv, ctx.agentId, ctx.userId, {
						url,
						resumePath,
						candidate: {
							fullName: stringInput(candidateInput.fullName) || stringInput(candidateInput.full_name) || stringInput(call.input.full_name) || stringInput(call.input.fullName),
							email: stringInput(candidateInput.email) || stringInput(call.input.email),
							phone: optionalInput(candidateInput.phone) || optionalInput(call.input.phone),
							location: optionalInput(candidateInput.location) || optionalInput(call.input.location),
							linkedin: optionalInput(candidateInput.linkedin) || optionalInput(call.input.linkedin),
							workAuthorization: optionalInput(candidateInput.workAuthorization) || optionalInput(candidateInput.work_authorization) || optionalInput(call.input.work_authorization) || optionalInput(call.input.workAuthorization),
						},
						coverNote: optionalInput(call.input.cover_note) || optionalInput(call.input.coverNote),
					});
					return ok(
						call.name,
						`Application started — the agent is now driving the browser (workflow ${workflowId}, task ${taskId}). It fills the form from the candidate Profile and pauses in the console Board only for a captcha, a stuck widget, or a missing value. Do NOT call submit_job_application again for this job, and do NOT say it's submitted — it completes when the workflow finishes.`,
					);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (/runner|runtime|registered|offline/i.test(msg)) return fail(call.name, "No browser runner connected. Start the runner with: pags up");
					return fail(call.name, msg);
				}
			}

			case "find_confirmation_link": {
				if (!ctx?.env || !ctx.userId) {
					return fail(call.name, "Email access requires an authenticated user context.");
				}
				// Runtime enforcement: reject even if the model hallucinated this tool call
				if (!ctx.emailPermitted) {
					return fail(call.name, "Email access is not enabled for this agent.");
				}
				if (!ctx.env.KEY_ENCRYPTION_KEY) {
					return fail(call.name, "Key encryption is not configured on this deployment.");
				}
				// Read the encrypted Gmail refresh token from the user's vault.
				const row = await ctx.env.DB.prepare(
					"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'",
				)
					.bind(ctx.userId)
					.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
				if (!row) {
					return fail(
						call.name,
						"Gmail is not connected. Ask the user to connect Gmail in the agent's settings before retrying.",
					);
				}
				const { decryptKey } = await import("./crypto.js");
				const {
					mintGmailAccessToken,
					findMatchingMessage,
					rankConfirmationLinks,
					buildQuery,
					GmailError,
				} = await import("./gmail.js");
				try {
					const refreshToken = await decryptKey(
						new Uint8Array(row.key_ciphertext),
						new Uint8Array(row.dek_wrapped),
						new Uint8Array(row.iv),
						ctx.env.KEY_ENCRYPTION_KEY,
					);
					const accessToken = await mintGmailAccessToken(ctx.env, refreshToken);
					const query = buildQuery({
						from: typeof call.input.from === "string" ? call.input.from : undefined,
						subject: typeof call.input.subject === "string" ? call.input.subject : undefined,
						withinDays: typeof call.input.within_days === "number" ? call.input.within_days : undefined,
					});
					const match = await findMatchingMessage(accessToken, query);
					if (!match) {
						return ok(
							call.name,
							`No matching email found yet for query: ${query}. The confirmation email may not have arrived — wait a moment and try again.`,
						);
					}
					const ranked = rankConfirmationLinks(match.links, typeof call.input.from === "string" ? call.input.from : undefined);
					if (ranked.length === 0) {
						return ok(
							call.name,
							`Found email "${match.subject}" from ${match.from} but it contained no links.`,
						);
					}
					await engine.logEvent("email.confirmation_link_found", ctx.userId, {
						subject: match.subject,
						from: match.from,
					});
					return ok(
						call.name,
						`Found email "${match.subject}" from ${match.from} (${match.date}).\nMost likely confirmation link: ${ranked[0]}\nOther links: ${ranked.slice(1, 4).join(", ") || "none"}\nOpen the confirmation link with a browser.open runner task to complete verification.`,
					);
				} catch (err) {
					if (err instanceof GmailError) return fail(call.name, err.message);
					throw err;
				}
			}

			// ── Coding tools ──────────────────────────────────────────────────
			case "list_coding_repos": {
				if (!ctx?.env?.DB || !ctx.agentId || !ctx.userId) return fail(call.name, "Not available");
				const repos = await listRepos(ctx.env as Env, ctx.agentId, ctx.userId);
				if (repos.length === 0) return ok(call.name, "No repositories attached.");
				const sessions = await listSessions(ctx.env as Env, ctx.agentId, ctx.userId);
				const lines = repos.map((r) => {
					const active = sessions.find((s) => s.repoId === r.id && s.status === "active");
					return `- ${r.name}${r.githubRepo ? ` (${r.githubRepo})` : ""}${active ? ` [active session: ${active.clientType || "claude"}]` : ""}`;
				});
				return ok(call.name, lines.join("\n"));
			}

			case "read_terminal": {
				if (!ctx?.env || !ctx.agentId || !ctx.userId) return fail(call.name, "Not available");
				const repoName = call.input.repo_name as string;
				if (!repoName) return fail(call.name, "repo_name required");
				const allRepos = await listRepos(ctx.env as Env, ctx.agentId, ctx.userId);
				const repo = allRepos.find((r) => r.name.toLowerCase() === repoName.toLowerCase());
				if (!repo) return fail(call.name, `Repo "${repoName}" not found. Use list_coding_repos.`);
				const session = await getActiveSessionForRepo(ctx.env as Env, ctx.agentId, ctx.userId, repo.id);
				if (!session) return fail(call.name, `No active session for "${repoName}".`);
				try {
					const relay = (ctx.env as Env).RELAY;
					if (!relay) return fail(call.name, "Runner not connected");
					const stub = relay.get(relay.idFromName(ctx.agentId));
					// Runner expects POST /coding/capture with { sessionId } body
					const res = await stub.fetch(new Request("https://relay/command", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ method: "POST", path: "/coding/capture", body: { sessionId: session.id } }),
					}));
					const data = await res.json() as { pane?: string; runState?: string };
					return ok(call.name, `[${data.runState || "unknown"}]\n${(data.pane || "(empty)").slice(-3000)}`);
				} catch {
					return fail(call.name, "Runner offline — terminal not available");
				}
			}

			case "send_to_cli": {
				if (!ctx?.env || !ctx.agentId || !ctx.userId) return fail(call.name, "Not available");
				const rName = call.input.repo_name as string;
				const msg = call.input.message as string;
				if (!rName || !msg) return fail(call.name, "repo_name and message required");
				if (msg.length > 5000) return fail(call.name, "message too long (max 5000 chars)");
				const rRepos = await listRepos(ctx.env as Env, ctx.agentId, ctx.userId);
				const rRepo = rRepos.find((r) => r.name.toLowerCase() === rName.toLowerCase());
				if (!rRepo) return fail(call.name, `Repo "${rName}" not found.`);
				const rSession = await getActiveSessionForRepo(ctx.env as Env, ctx.agentId, ctx.userId, rRepo.id);
				if (!rSession) return fail(call.name, `No active session for "${rName}".`);
				try {
					const relay = (ctx.env as Env).RELAY;
					if (!relay) return fail(call.name, "Runner not connected");
					const stub = relay.get(relay.idFromName(ctx.agentId));
					// Runner expects POST /coding/act with { sessionId, action }
					await stub.fetch(new Request("https://relay/command", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ method: "POST", path: "/coding/act", body: { sessionId: rSession.id, action: { kind: "message", text: msg } } }),
					}));
					return ok(call.name, `Sent to ${rName}: "${msg.slice(0, 100)}"`);
				} catch {
					return fail(call.name, "Runner offline — cannot send");
				}
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
