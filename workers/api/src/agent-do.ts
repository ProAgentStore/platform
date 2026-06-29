/**
 * AgentDO — one Durable Object per agent.
 *
 * Holds conversation history, memory, tasks, and runs the agent loop.
 * Inspired by archagent's bridge/agent-loop pattern, rebuilt on CF Durable Objects.
 *
 * Storage layers:
 * - DO storage: conversation, memory, tasks, collections, activity log
 * - R2: binary file storage (resumes, documents, media)
 * - Vectorize: semantic embeddings for RAG retrieval
 * - Collections: agent-defined structured storage (like tables)
 */
import { DurableObject } from "cloudflare:workers";
import { AgentStorageEngine } from "./agent-storage.js";
import { bytesFromBase64, deleteKeysBatched } from "./agent-storage-utils.js";
import type {
	AgentMessage,
	AgentState,
	AgentTask,
	Guardrails,
	KnowledgeDoc,
	MemoryEntry,
} from "./agent-types.js";
import {
	buildSystemPrompt,
	defaultGuardrails,
	DEFAULT_MODEL,
	ensureStateDefaults,
} from "./agent-do-prompt.js";
import { runAgentThink } from "./agent-think.js";
import {
	buildRepoOverview,
	extractTextFiles,
	fetchRepoMeta,
	fetchRepoTarball,
	findReadme,
	parseGithubUrl,
} from "./lib/repo-ingest.js";
import {
	UserAiCredentialsError,
	UserAiProviderError,
} from "./lib/user-ai.js";
import type { Env } from "./types.js";

export type {
	AgentMessage,
	AgentState,
	AgentTask,
	Guardrails,
	KnowledgeDoc,
	MemoryEntry,
	ToolCall,
	ToolResult,
} from "./agent-types.js";

const MAX_CONTEXT_MESSAGES = 10;

// ── Repo ingestion tuning ─────────────────────────────────────────────────────
const REPO_MAX_FILES = 300;
const REPO_MAX_FILE_BYTES = 32_000;
const REPO_MAX_TOTAL_BYTES = 4_000_000;
// Bound each indexing alarm by embeddings done (not file count): a few big files
// shouldn't push one tick past the Worker time/subrequest budget. Always processes
// at least one file so progress is guaranteed even if a single file is huge.
const REPO_CHUNK_BUDGET = 60; // ~60 embed calls per alarm tick
const REPO_MAX_REPOS = 20; // indexed repos per instance

/**
 * Background job that pulls one GitHub repo into the agent's vector store. An
 * instance can index many repos; each has its own job at `repoJob:{key}` (key =
 * `owner/repo`), and `repoIndex` holds the list of keys.
 */
interface RepoIngestJob {
	key: string; // `${owner}/${repo}` — namespaces vectors + staged files
	repoUrl: string;
	owner: string;
	repo: string;
	branch?: string;
	token?: string;
	status: "fetching" | "indexing" | "summarizing" | "done" | "error";
	total: number;
	done: number;
	failed: number; // files whose embedding threw — surfaced, not silently dropped
	skipped: number;
	queue: number[];
	paths: string[];
	description?: string | null;
	language?: string | null;
	readme?: string | null;
	error?: string;
	startedAt: string;
	finishedAt?: string;
}

export class AgentDO extends DurableObject<Env> {
	private getStorageEngine(agentId: string): AgentStorageEngine {
		// Platform-paid internal AI (embeddings + summary) is gated behind one master
		// switch. Off (default) → pass null AI, so embed/summary no-op and the platform
		// never spends tokens (BYOK-only). LLM chat is BYOK regardless of this flag.
		const platformAi = this.env.PLATFORM_AI_ENABLED === "true" ? this.env.AI || null : null;
		return new AgentStorageEngine(
			this.ctx.storage,
			this.env.STORAGE || null,
			this.env.VECTORIZE || null,
			platformAi,
			agentId,
		);
	}

	/**
	 * Initialize agent state. Called once when the agent is first created.
	 */
	async init(config: {
		agentId: string;
		name: string;
		personality?: string;
		goal?: string;
		model?: string;
		guardrails?: Partial<Guardrails>;
		welcomeMessage?: string;
	}): Promise<void> {
		const guardrails = defaultGuardrails(config.guardrails);
		const state: AgentState = {
			agentId: config.agentId,
			name: config.name,
			personality: config.personality || "",
			goal: config.goal || "",
			model: config.model || DEFAULT_MODEL,
			status: "idle",
			systemPrompt: buildSystemPrompt(
				config.name,
				config.personality,
				config.goal,
				guardrails,
			),
			guardrails,
			welcomeMessage: config.welcomeMessage || "",
			isPublished: false,
		};
		await this.ctx.storage.put("state", state);

		// Seed identity memory
		if (config.personality) {
			await this.setMemory("personality", "identity", config.personality);
		}
		if (config.goal) {
			await this.setMemory("goal", "identity", config.goal);
		}
	}

	/**
	 * Handle HTTP requests to this agent.
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// WebSocket upgrade for real-time chat
		if (request.headers.get("Upgrade") === "websocket") {
			return this.handleWebSocket();
		}

		try {
			// Chat (HTTP)
			if (path === "/chat" && request.method === "POST")
				return this.handleChat(request);

			// Memory CRUD
			if (path === "/memory" && request.method === "GET")
				return this.handleGetMemory();
			if (path === "/memory" && request.method === "PUT")
				return this.handleSetMemory(request);
			if (path.startsWith("/memory/") && request.method === "DELETE") {
				return this.handleDeleteMemory(path.slice("/memory/".length));
			}

			// Tasks CRUD
			if (path === "/tasks" && request.method === "GET")
				return this.handleGetTasks();
			if (path === "/tasks" && request.method === "POST")
				return this.handleCreateTask(request);
			if (path.startsWith("/tasks/") && request.method === "PUT") {
				return this.handleUpdateTask(path.slice("/tasks/".length), request);
			}
			if (path.startsWith("/tasks/") && request.method === "DELETE") {
				return this.handleDeleteTask(path.slice("/tasks/".length));
			}

			// Messages history
			if (path === "/messages" && request.method === "GET")
				return this.handleGetMessages(url);
			if (path === "/messages" && request.method === "DELETE")
				return this.handleClearMessages();
			if (path === "/system-message" && request.method === "POST") {
				const { content } = await request.json<{ content: string }>();
				if (content) {
					await this.appendMessage({
						id: crypto.randomUUID(),
						role: "system",
						content: String(content).slice(0, 2000),
						channel: "chat",
						createdAt: new Date().toISOString(),
					});
				}
				return json({ ok: true });
			}

			// Knowledge base
			if (path === "/knowledge" && request.method === "GET")
				return this.handleGetKnowledge();
			if (path === "/knowledge" && request.method === "POST")
				return this.handleAddKnowledge(request);
			if (path.startsWith("/knowledge/") && request.method === "DELETE") {
				return this.handleDeleteKnowledge(path.slice("/knowledge/".length));
			}
			if (path === "/knowledge/ingest-url" && request.method === "POST")
				return this.handleIngestUrl(request);

			// Repo ingestion (read-only "chat with a repository" agent)
			if (path === "/ingest-repo" && request.method === "POST")
				return this.handleIngestRepo(request);
			if (path === "/ingest-repo/status" && request.method === "GET")
				return this.handleIngestRepoStatus();
			if (path === "/ingest-repo/clear" && request.method === "POST")
				return this.handleClearRepo(request);

			// State
			if (path === "/init-collections" && request.method === "POST")
				return this.handleInitCollections(request);
			if (path === "/init" && request.method === "POST")
				return this.handleInit(request);
			if (path === "/state" && request.method === "GET")
				return this.handleGetState();
			if (path === "/state" && request.method === "PUT")
				return this.handleUpdateState(request);

			// Collections (structured storage)
			if (path === "/collections" && request.method === "GET")
				return this.handleListCollections();
			if (path === "/collections" && request.method === "POST")
				return this.handleCreateCollection(request);
			if (path.match(/^\/collections\/[^/]+$/) && request.method === "GET")
				return this.handleGetCollection(path.slice("/collections/".length));
			if (path.match(/^\/collections\/[^/]+$/) && request.method === "DELETE")
				return this.handleDeleteCollection(path.slice("/collections/".length));
			if (path.match(/^\/collections\/[^/]+\/records$/) && request.method === "GET")
				return this.handleQueryRecords(path.split("/")[2], url);
			if (path.match(/^\/collections\/[^/]+\/records$/) && request.method === "POST")
				return this.handleInsertRecord(path.split("/")[2], request);
			if (path.match(/^\/collections\/[^/]+\/records\/[^/]+$/) && request.method === "GET")
				return this.handleGetRecord(path.split("/")[2], path.split("/")[4]);
			if (path.match(/^\/collections\/[^/]+\/records\/[^/]+$/) && request.method === "PUT")
				return this.handleUpdateRecord(path.split("/")[2], path.split("/")[4], request);
			if (path.match(/^\/collections\/[^/]+\/records\/[^/]+$/) && request.method === "DELETE")
				return this.handleDeleteRecord(path.split("/")[2], path.split("/")[4]);

			// Files
			if (path === "/files" && request.method === "GET")
				return this.handleListFiles(url);
			if (path === "/files" && request.method === "POST")
				return this.handleUploadFile(request);
			if (path.match(/^\/files\/[^/]+$/) && request.method === "GET")
				return this.handleGetFile(path.slice("/files/".length));
			if (path.match(/^\/files\/[^/]+$/) && request.method === "DELETE")
				return this.handleDeleteFile(path.slice("/files/".length));

			// Vector search
			if (path === "/search" && request.method === "POST")
				return this.handleVectorSearch(request);

			// Activity log
			if (path === "/activity" && request.method === "GET")
				return this.handleGetActivity(url);

			// Summaries
			if (path === "/summaries" && request.method === "GET")
				return this.handleGetSummaries(url);
			if (path === "/summarize" && request.method === "POST")
				return this.handleForceSummarize();

			// User context
			if (path.match(/^\/users\/[^/]+\/context$/) && request.method === "GET")
				return this.handleGetUserContext(path.split("/")[2]);

			return json({ error: "Not found" }, 404);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("AgentDO error:", message);
			return json({ error: message }, 500);
		}
	}

	// ── Chat ───────────────────────────────────────────────────────────────────

	private async handleChat(request: Request): Promise<Response> {
		const body = await request.json<{
			message: string;
			channel?: string;
			userId?: string;
			agentId?: string;
			agentName?: string;
		}>();
		const { message, channel, userId } = body;
		if (!message) return json({ error: "message required" }, 400);

		let state = await this.getState();

		// Auto-initialize if DO has no state (agent created via D1 but DO never init'd)
		if (!state) {
			const url = new URL(request.url);
			const agentId =
				body.agentId || url.searchParams.get("agentId") || "unknown";
			const agentName =
				body.agentName || url.searchParams.get("agentName") || "Agent";
			await this.init({ agentId, name: agentName });
			state = await this.getState();
			if (!state) return json({ error: "Failed to initialize agent" }, 500);
		}

		ensureStateDefaults(state);
		await this.ctx.storage.put("state", state);

		// Save user message
		const userMsg: AgentMessage = {
			id: crypto.randomUUID(),
			role: "user",
			content: message,
			channel: channel || "chat",
			userId,
			createdAt: new Date().toISOString(),
		};
		await this.appendMessage(userMsg);
		this.broadcast({ type: "message", message: userMsg });

		const engine = this.getStorageEngine(state.agentId);
		await engine.logEvent("chat.message", userId, { messageId: userMsg.id });

		// Run agent loop
		await this.ctx.storage.put("state", { ...state, status: "thinking" });
		this.broadcast({ type: "status", status: "thinking" });

		try {
			const { response, toolCalls } = await this.think(state, engine, userId);

			// Save tool calls as a system message (visible in chat)
			let toolMsg: AgentMessage | undefined;
			if (toolCalls.length > 0) {
				toolMsg = {
					id: crypto.randomUUID(),
					role: "system",
					content: toolCalls.join("\n"),
					channel: channel || "chat",
					createdAt: new Date().toISOString(),
				};
				await this.appendMessage(toolMsg);
				this.broadcast({ type: "message", message: toolMsg });
			}

			const assistantMsg: AgentMessage = {
				id: crypto.randomUUID(),
				role: "assistant",
				content: response,
				channel: channel || "chat",
				createdAt: new Date().toISOString(),
			};
			await this.appendMessage(assistantMsg);

			await this.ctx.storage.put("state", { ...state, status: "idle" });
			this.broadcast({ type: "message", message: assistantMsg });
			this.broadcast({ type: "status", status: "idle" });

			await engine.logEvent("chat.response", userId, { messageId: assistantMsg.id });
			engine.maybeSummarize(state.model).catch(() => {});

			return json({ message: assistantMsg, toolMessage: toolMsg });
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			const status =
				err instanceof UserAiCredentialsError || err instanceof UserAiProviderError
					? err.status
					: 500;
			await this.ctx.storage.put("state", { ...state, status: "error" });
			this.broadcast({ type: "status", status: "error", error: errMsg });

			const errorMsg: AgentMessage = {
				id: crypto.randomUUID(),
				role: "system",
				content: `Error: ${errMsg}`,
				channel: channel || "chat",
				createdAt: new Date().toISOString(),
			};
			await this.appendMessage(errorMsg);
			this.broadcast({ type: "message", message: errorMsg });

			return json({ error: errMsg }, status);
		}
	}

	/**
	 * The agent loop — build context, call Workers AI, return response.
	 *
	 * Context: RAG search → memory → tasks → user context.
	 * Knowledge is retrieved via vector search, not dumped wholesale.
	 */
	private async think(
		state: AgentState,
		engine: AgentStorageEngine,
		userId?: string,
	): Promise<{ response: string; toolCalls: string[] }> {
		const messages = await this.getRecentMessages(MAX_CONTEXT_MESSAGES);
		const memory = await this.getAllMemory();
		const tasks = await this.getAllTasks();
		return runAgentThink({
			state,
			engine,
			messages,
			memory,
			tasks,
			userId,
			env: this.env,
			doStorage: this.ctx.storage,
			broadcast: (data) => this.broadcast(data),
		});
	}

	// ── WebSocket ──────────────────────────────────────────────────────────────

	private handleWebSocket(): Response {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);

		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketClose(_ws: WebSocket): void {
		// No-op: sessions are tracked by the runtime via ctx.getWebSockets()
	}

	async webSocketMessage(
		ws: WebSocket,
		data: string | ArrayBuffer,
	): Promise<void> {
		if (typeof data !== "string") return;
		try {
			const parsed = JSON.parse(data);
			if (parsed.type === "chat" && parsed.message) {
				// Handle chat via WebSocket — reuse the same logic
				const request = new Request("https://internal/chat", {
					method: "POST",
					body: JSON.stringify({
						message: parsed.message,
						channel: "chat",
						userId: parsed.userId,
					}),
				});
				await this.handleChat(request);
			}
		} catch {
			ws.send(JSON.stringify({ type: "error", error: "Invalid message" }));
		}
	}

	private broadcast(data: Record<string, unknown>): void {
		const payload = JSON.stringify(data);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				/* closed socket, runtime will clean up */
			}
		}
	}

	// ── Messages ───────────────────────────────────────────────────────────────

	private async appendMessage(msg: AgentMessage): Promise<void> {
		const key = `msg:${msg.createdAt}:${msg.id}`;
		await this.ctx.storage.put(key, msg);
	}

	private async getRecentMessages(limit: number): Promise<AgentMessage[]> {
		const all = await this.ctx.storage.list<AgentMessage>({
			prefix: "msg:",
			reverse: true,
			limit,
		});
		const messages = [...all.values()].reverse();
		return messages;
	}

	private async handleGetMessages(url: URL): Promise<Response> {
		// Cap at 2000 so "copy the full conversation" can export everything; normal
		// chat loads pass a small limit (50) and are unaffected.
		const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 2000);
		const messages = await this.getRecentMessages(limit);
		return json({ messages });
	}

	private async handleClearMessages(): Promise<Response> {
		const all = await this.ctx.storage.list({ prefix: "msg:" });
		const keys = [...all.keys()];
		for (let i = 0; i < keys.length; i += 128) {
			await this.ctx.storage.delete(keys.slice(i, i + 128));
		}
		return json({ deleted: keys.length });
	}

	// ── Memory ─────────────────────────────────────────────────────────────────

	private async setMemory(
		key: string,
		type: string,
		content: string,
	): Promise<void> {
		const entry: MemoryEntry = {
			key,
			type: type as MemoryEntry["type"],
			content,
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(`mem:${key}`, entry);
	}

	private async getAllMemory(): Promise<MemoryEntry[]> {
		const all = await this.ctx.storage.list<MemoryEntry>({ prefix: "mem:" });
		return [...all.values()];
	}

	private async handleGetMemory(): Promise<Response> {
		return json({ memory: await this.getAllMemory() });
	}

	private async handleSetMemory(request: Request): Promise<Response> {
		const { key, type, content } = await request.json<{
			key: string;
			type: string;
			content: string;
		}>();
		if (!key || !type || content === undefined)
			return json({ error: "key, type, content required" }, 400);
		await this.setMemory(key, type, content);
		return json({ success: true });
	}

	private async handleDeleteMemory(key: string): Promise<Response> {
		await this.ctx.storage.delete(`mem:${decodeURIComponent(key)}`);
		return json({ success: true });
	}

	// ── Tasks ──────────────────────────────────────────────────────────────────

	private async getAllTasks(): Promise<AgentTask[]> {
		const all = await this.ctx.storage.list<AgentTask>({ prefix: "task:" });
		return [...all.values()];
	}

	private async handleGetTasks(): Promise<Response> {
		return json({ tasks: await this.getAllTasks() });
	}

	private async handleCreateTask(request: Request): Promise<Response> {
		const { title, description } = await request.json<{
			title: string;
			description?: string;
		}>();
		if (!title) return json({ error: "title required" }, 400);
		const task: AgentTask = {
			id: crypto.randomUUID(),
			title,
			description: description || "",
			status: "pending",
			assignedBy: "user",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(`task:${task.id}`, task);
		return json(task, 201);
	}

	private async handleUpdateTask(
		id: string,
		request: Request,
	): Promise<Response> {
		const existing = await this.ctx.storage.get<AgentTask>(`task:${id}`);
		if (!existing) return json({ error: "Task not found" }, 404);
		const updates = await request.json<Partial<AgentTask>>();
		const updated = {
			...existing,
			...updates,
			id: existing.id,
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(`task:${id}`, updated);
		return json(updated);
	}

	private async handleDeleteTask(id: string): Promise<Response> {
		await this.ctx.storage.delete(`task:${id}`);
		return json({ success: true });
	}

	// ── State ──────────────────────────────────────────────────────────────────

	private async handleInit(request: Request): Promise<Response> {
		const config = await request.json<{
			agentId: string;
			name: string;
			personality?: string;
			goal?: string;
			model?: string;
			collections?: Record<string, { fields: import("./agent-storage-types.js").CollectionField[] }>;
		}>();
		if (!config.agentId || !config.name)
			return json({ error: "agentId and name required" }, 400);
		await this.init(config);

		// Auto-create declared collections
		if (config.collections) {
			const engine = this.getStorageEngine(config.agentId);
			for (const [name, schema] of Object.entries(config.collections)) {
				await engine.collectionCreate(name, schema.fields).catch(() => {});
			}
		}

		return json({ success: true }, 201);
	}

	private async handleInitCollections(request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const { collections } = await request.json<{
			collections: Record<string, { fields: import("./agent-storage-types.js").CollectionField[] }>;
		}>();
		if (!collections) return json({ error: "collections required" }, 400);

		const engine = this.getStorageEngine(state.agentId);
		const created: string[] = [];
		const skipped: string[] = [];
		for (const [name, schema] of Object.entries(collections)) {
			try {
				await engine.collectionCreate(name, schema.fields);
				created.push(name);
			} catch {
				skipped.push(name);
			}
		}
		return json({ created, skipped });
	}

	private async getState(): Promise<AgentState | null> {
		return (await this.ctx.storage.get<AgentState>("state")) ?? null;
	}

	private async handleGetState(): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		// Auto-migrate old state missing new fields
		if (!state.guardrails) {
			ensureStateDefaults(state);
			await this.ctx.storage.put("state", state);
		}
		const { systemPrompt: _, ...public_ } = state;
		return json(public_);
	}

	private async handleUpdateState(request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const updates = await request.json<
			Partial<AgentState> & { guardrails?: Partial<Guardrails> }
		>();

		if (updates.name !== undefined) state.name = updates.name;
		if (updates.personality !== undefined)
			state.personality = updates.personality;
		if (updates.goal !== undefined) state.goal = updates.goal;
		if (updates.model !== undefined) state.model = updates.model;
		// Allow resetting stuck status (e.g., "thinking" after a timeout)
		if (updates.status !== undefined) state.status = updates.status;
		if (updates.welcomeMessage !== undefined)
			state.welcomeMessage = updates.welcomeMessage;
		if (updates.isPublished !== undefined)
			state.isPublished = updates.isPublished;
		if (updates.guardrails) {
			state.guardrails = { ...state.guardrails, ...updates.guardrails };
		}
		if (updates.permissions) {
			state.permissions = { ...state.permissions, ...updates.permissions };
		}
		state.systemPrompt = buildSystemPrompt(
			state.name,
			state.personality,
			state.goal,
			state.guardrails,
		);
		await this.ctx.storage.put("state", state);
		return json({ success: true });
	}

	// ── Knowledge Base ─────────────────────────────────────────────────────────

	private async getAllKnowledge(): Promise<KnowledgeDoc[]> {
		const all = await this.ctx.storage.list<KnowledgeDoc>({ prefix: "kb:" });
		return [...all.values()];
	}

	private async handleGetKnowledge(): Promise<Response> {
		return json({ documents: await this.getAllKnowledge() });
	}

	private async handleAddKnowledge(request: Request): Promise<Response> {
		const body = await request.json<{
			title: string;
			content: string;
			source?: KnowledgeDoc["source"];
			sourceUrl?: string;
		}>();
		if (!body.title || !body.content)
			return json({ error: "title and content required" }, 400);
		if (body.content.length > 100_000)
			return json({ error: "Document too large (max 100KB)" }, 400);

		// Limit total knowledge base size (max 20 docs)
		const existing = await this.ctx.storage.list({ prefix: "kb:" });
		if (existing.size >= 20)
			return json({ error: "Knowledge base full (max 20 documents)" }, 400);

		const doc: KnowledgeDoc = {
			id: crypto.randomUUID(),
			title: body.title,
			content: body.content,
			source: body.source || "paste",
			sourceUrl: body.sourceUrl,
			addedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(`kb:${doc.id}`, doc);

		// Vectorize the document for semantic retrieval (best-effort — don't fail the add)
		const state = await this.getState();
		if (state) {
			const engine = this.getStorageEngine(state.agentId);
			await engine.vectorizeStore("knowledge", doc.id, `${doc.title}\n\n${doc.content}`).catch(() => {});
			await engine.logEvent("knowledge.added", undefined, {
				docId: doc.id,
				title: doc.title,
				size: doc.content.length,
			}).catch(() => {});
		}

		return json(doc, 201);
	}

	private async handleDeleteKnowledge(id: string): Promise<Response> {
		const decodedId = decodeURIComponent(id);
		await this.ctx.storage.delete(`kb:${decodedId}`);

		// Remove vectors
		const state = await this.getState();
		if (state) {
			const engine = this.getStorageEngine(state.agentId);
			await engine.vectorDelete("knowledge", decodedId);
			await engine.logEvent("knowledge.removed", undefined, { docId: decodedId });
		}

		return json({ success: true });
	}

	private async handleIngestUrl(request: Request): Promise<Response> {
		const { url, title } = await request.json<{
			url: string;
			title?: string;
		}>();
		if (!url) return json({ error: "url required" }, 400);

		// SSRF protection
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "https:") return json({ error: "Only https URLs allowed" }, 400);
			const host = parsed.hostname.toLowerCase();
			if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]" || host.endsWith(".internal") || host.endsWith(".local") || /^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))
				return json({ error: "Cannot fetch internal/private URLs" }, 400);
		} catch { return json({ error: "Invalid URL" }, 400); }

		try {
			const res = await fetch(url, {
				headers: { "User-Agent": "ProAgentStore-Ingest" },
			});
			if (!res.ok)
				return json({ error: `Failed to fetch: ${res.status}` }, 400);

			const contentType = res.headers.get("content-type") || "";
			let text = await res.text();

			// Strip HTML tags for web pages
			if (contentType.includes("html")) {
				text = text
					.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
					.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim();
			}

			// Truncate to 50KB per doc
			if (text.length > 50_000)
				text = `${text.slice(0, 50_000)}\n...[truncated]`;

			const doc: KnowledgeDoc = {
				id: crypto.randomUUID(),
				title: title || new URL(url).hostname,
				content: text,
				source: "url",
				sourceUrl: url,
				addedAt: new Date().toISOString(),
			};
			await this.ctx.storage.put(`kb:${doc.id}`, doc);
			return json(doc, 201);
		} catch (err) {
			return json(
				{
					error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
				},
				400,
			);
		}
	}

	// ── Repo ingestion (multi-repo) ──────────────────────────────────────────────
	//
	// Each repo has a job at `repoJob:{key}` (key = `owner/repo`). Membership is one
	// marker key per repo (`repoMember:{key}`) rather than a single array, so two
	// concurrent adds can't lose-update each other. `alarm()` advances ONE active
	// repo per tick and guards every write with saveJob() so a re-index or remove
	// landing mid-tick can't resurrect or clobber a job (the DO lets fetch handlers
	// interleave with the alarm at network awaits).

	private async getRepoIndex(): Promise<string[]> {
		const all = await this.ctx.storage.list({ prefix: "repoMember:" });
		return [...all.keys()].map((k) => k.slice("repoMember:".length));
	}

	private async getRepoJob(key: string): Promise<RepoIngestJob | null> {
		return (await this.ctx.storage.get<RepoIngestJob>(`repoJob:${key}`)) ?? null;
	}

	/**
	 * Persist a job ONLY if it's still the current one (same key present, same
	 * startedAt). Returns false when a concurrent remove/re-index has superseded it
	 * — the caller then drops its stale write instead of resurrecting the job.
	 */
	private async saveJob(prev: RepoIngestJob, patch: Partial<RepoIngestJob>): Promise<boolean> {
		const current = await this.getRepoJob(prev.key);
		if (!current || current.startedAt !== prev.startedAt) return false;
		await this.ctx.storage.put(`repoJob:${prev.key}`, { ...prev, ...patch });
		return true;
	}

	/** Rebuild the combined "which repos are indexed" memory entry from all jobs. */
	private async refreshRepoMemory(): Promise<void> {
		const keys = await this.getRepoIndex();
		const done: string[] = [];
		for (const key of keys) {
			const job = await this.getRepoJob(key);
			if (job?.status === "done") done.push(`${job.key} (${job.total} files${job.language ? `, ${job.language}` : ""})`);
		}
		if (done.length === 0) {
			await this.ctx.storage.delete("mem:repository");
			return;
		}
		await this.setMemory(
			"repository",
			"context",
			`Indexed repositories: ${done.join("; ")}. You can explain any file, function, or how the code fits together in any of them; cite the repo when files share names. You are READ-ONLY — you never modify these repositories.`,
		);
	}

	/** Remove one repo's data (vectors incl. overview, staged files, job, index entry). */
	private async clearRepo(key: string): Promise<void> {
		const state = await this.getState();
		const engine = state ? this.getStorageEngine(state.agentId) : null;
		// The overview is a repo vector (sourceId `${key}::OVERVIEW`), so clearing
		// the repo's vectors removes it too — no separate KB-doc cleanup needed.
		if (engine) await engine.clearRepoVectors(key).catch(() => undefined);
		const staged = await this.ctx.storage.list({ prefix: `rifile:${key}:` });
		await deleteKeysBatched(this.ctx.storage, [...staged.keys()]);
		// Drop membership first so a mid-flight alarm's saveJob() guard bails before
		// it can resurrect this repo, then delete the job itself.
		await this.ctx.storage.delete(`repoMember:${key}`);
		await this.ctx.storage.delete(`repoJob:${key}`);
	}

	private async handleIngestRepo(request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const { repoUrl, branch, token } = await request.json<{ repoUrl: string; branch?: string; token?: string }>();
		if (!repoUrl) return json({ error: "repoUrl required" }, 400);
		const ref = parseGithubUrl(repoUrl);
		if (!ref) return json({ error: "Not a recognizable GitHub repository URL" }, 400);

		const key = `${ref.owner}/${ref.repo}`;
		const existing = await this.getRepoIndex();
		if (!existing.includes(key) && existing.length >= REPO_MAX_REPOS) {
			return json({ error: `Repo limit reached (max ${REPO_MAX_REPOS}). Remove one before adding another.` }, 400);
		}
		// Re-indexing an existing repo: clear just that one, keep the rest.
		await this.clearRepo(key);

		const job: RepoIngestJob = {
			key,
			repoUrl,
			owner: ref.owner,
			repo: ref.repo,
			branch: branch || undefined,
			token: token || undefined,
			status: "fetching",
			total: 0,
			done: 0,
			failed: 0,
			skipped: 0,
			queue: [],
			paths: [],
			startedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(`repoJob:${key}`, job);
		await this.ctx.storage.put(`repoMember:${key}`, 1);
		await this.ctx.storage.setAlarm(Date.now());
		return json({ status: job.status, repo: key }, 202);
	}

	private async handleIngestRepoStatus(): Promise<Response> {
		const keys = await this.getRepoIndex();
		const repos: unknown[] = [];
		for (const key of keys) {
			const job = await this.getRepoJob(key);
			if (!job) continue;
			const { token: _t, queue: _q, readme: _r, ...pub } = job;
			repos.push(pub);
		}
		// Self-heal: with no repos indexed, drop any stale "indexed repository"
		// memory (e.g. left by the pre-multi-repo scheme) so the agent doesn't
		// claim to know a repo that isn't actually indexed. Also retire the legacy
		// single-repo job key if present.
		if (repos.length === 0) {
			await this.ctx.storage.delete("mem:repository");
			await this.ctx.storage.delete("repoIngest");
		}
		return json({ repos });
	}

	/** Remove one repo (body { repoUrl } or { key }), or all when neither given. */
	private async handleClearRepo(request: Request): Promise<Response> {
		const body = await request.json<{ repoUrl?: string; key?: string }>().catch(() => ({}) as { repoUrl?: string; key?: string });
		let key = body.key;
		if (!key && body.repoUrl) {
			const ref = parseGithubUrl(body.repoUrl);
			if (ref) key = `${ref.owner}/${ref.repo}`;
		}
		if (key) {
			await this.clearRepo(key);
		} else {
			for (const k of await this.getRepoIndex()) await this.clearRepo(k);
		}
		await this.refreshRepoMemory();
		return json({ status: "cleared" });
	}

	/**
	 * Alarm-driven repo ingestion: advances ONE active repo job per tick, then
	 * reschedules so the next pending repo (or the next phase) runs. Every write
	 * goes through saveJob(), which drops the write if the job was removed or
	 * re-indexed mid-tick — so a concurrent remove/re-index can never be clobbered
	 * or resurrected. The tick always reschedules; an idle tick (no active repo)
	 * simply returns without rescheduling.
	 */
	async alarm(): Promise<void> {
		const state = await this.getState();
		if (!state) return;
		const engine = this.getStorageEngine(state.agentId);

		// Find the first repo that still needs work.
		let job: RepoIngestJob | null = null;
		for (const key of await this.getRepoIndex()) {
			const j = await this.getRepoJob(key);
			if (j && j.status !== "done" && j.status !== "error") {
				job = j;
				break;
			}
		}
		if (!job) return; // nothing pending — stop the chain
		const ref = { owner: job.owner, repo: job.repo };

		try {
			if (job.status === "fetching") {
				const meta = await fetchRepoMeta(ref, job.token);
				const tar = await fetchRepoTarball(ref, job.branch || meta?.defaultBranch || undefined, job.token);
				const { files, skipped } = extractTextFiles(tar, {
					maxFiles: REPO_MAX_FILES,
					maxFileBytes: REPO_MAX_FILE_BYTES,
					maxTotalBytes: REPO_MAX_TOTAL_BYTES,
				});
				if (files.length === 0) {
					await this.saveJob(job, { status: "error", error: "No indexable text files found in this repository.", finishedAt: new Date().toISOString() });
				} else if (await this.getRepoJob(job.key).then((c) => c?.startedAt === job?.startedAt)) {
					// Only stage + advance if this job is still current (not removed/re-indexed mid-fetch).
					for (let i = 0; i < files.length; i++) await this.ctx.storage.put(`rifile:${job.key}:${i}`, files[i]);
					const advanced = await this.saveJob(job, {
						status: "indexing",
						total: files.length,
						done: 0,
						queue: files.map((_, i) => i),
						paths: files.map((f) => f.path),
						skipped,
						description: meta?.description ?? null,
						language: meta?.language ?? null,
						readme: findReadme(files),
					});
					// Superseded after staging → don't leave orphan staged files behind.
					if (!advanced) {
						const staged = await this.ctx.storage.list({ prefix: `rifile:${job.key}:` });
						await deleteKeysBatched(this.ctx.storage, [...staged.keys()]);
					}
				}
			} else if (job.status === "indexing") {
				const queue = [...job.queue];
				let processed = 0;
				let failed = 0;
				let chunks = 0;
				// Process files until the chunk budget is hit (but always ≥1 file).
				while (queue.length > 0 && (processed === 0 || chunks < REPO_CHUNK_BUDGET)) {
					const idx = queue.shift() as number;
					const file = await this.ctx.storage.get<{ path: string; content: string }>(`rifile:${job.key}:${idx}`);
					if (file) {
						const n = await engine.vectorizeRepoFile(job.key, file.path, file.content).then((v) => v, () => -1);
						if (n < 0) failed++;
						await this.ctx.storage.delete(`rifile:${job.key}:${idx}`);
						if (n > 0) chunks += n;
					}
					processed++;
				}
				await this.saveJob(job, {
					done: job.done + processed,
					failed: (job.failed ?? 0) + failed,
					queue,
					status: queue.length === 0 ? "summarizing" : "indexing",
				});
			} else if (job.status === "summarizing") {
				const overview = buildRepoOverview(ref, {
					description: job.description,
					language: job.language,
					paths: job.paths,
					readme: job.readme,
				});
				// Store the overview as a repo vector (sourceId `${key}::OVERVIEW`), not a
				// KB doc — keeps it out of the 20-doc KB cap and auto-cleared with the repo.
				await engine.vectorizeRepoFile(job.key, "OVERVIEW", overview).catch(() => 0);
				await engine.logEvent("repo.indexed", undefined, { repo: job.key, files: job.total }).catch(() => undefined);
				if (await this.saveJob(job, { status: "done", finishedAt: new Date().toISOString() })) {
					await this.refreshRepoMemory();
				} else {
					// Job was removed/re-indexed while summarizing — drop the overview vector we just wrote.
					await engine.clearRepoVectors(job.key).catch(() => undefined);
				}
			}
		} catch (err) {
			await this.saveJob(job, {
				status: "error",
				error: err instanceof Error ? err.message : String(err),
				finishedAt: new Date().toISOString(),
			});
		}
		// Keep the chain alive for the next phase / next pending repo.
		await this.ctx.storage.setAlarm(Date.now() + 50);
	}

	// ── Collections ───────────────────────────────────────────────────────────

	private async handleListCollections(): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const collections = await engine.collectionList();
		return json({ collections });
	}

	private async handleCreateCollection(request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const { name, fields } = await request.json<{ name: string; fields: unknown[] }>();
		if (!name || !fields) return json({ error: "name and fields required" }, 400);
		const schema = await engine.collectionCreate(name, fields as import("./agent-storage-types.js").CollectionField[]);
		return json(schema, 201);
	}

	private async handleGetCollection(name: string): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const schema = await engine.collectionGet(decodeURIComponent(name));
		return schema ? json(schema) : json({ error: "Not found" }, 404);
	}

	private async handleDeleteCollection(name: string): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		await engine.collectionDelete(decodeURIComponent(name));
		return json({ success: true });
	}

	private async handleQueryRecords(collection: string, url: URL): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const where = url.searchParams.get("where");
		const result = await engine.recordQuery(decodeURIComponent(collection), {
			where: where ? JSON.parse(where) : undefined,
			orderBy: url.searchParams.get("order_by") || undefined,
			orderDir: (url.searchParams.get("order_dir") as "asc" | "desc") || undefined,
			limit: Number(url.searchParams.get("limit")) || 50,
			offset: Number(url.searchParams.get("offset")) || 0,
		});
		return json(result);
	}

	private async handleInsertRecord(collection: string, request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const { data } = await request.json<{ data: Record<string, unknown> }>();
		if (!data) return json({ error: "data required" }, 400);
		const record = await engine.recordInsert(decodeURIComponent(collection), data);
		return json(record, 201);
	}

	private async handleGetRecord(collection: string, id: string): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const record = await engine.recordGet(decodeURIComponent(collection), decodeURIComponent(id));
		return record ? json(record) : json({ error: "Not found" }, 404);
	}

	private async handleUpdateRecord(collection: string, id: string, request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const { data } = await request.json<{ data: Record<string, unknown> }>();
		if (!data) return json({ error: "data required" }, 400);
		const record = await engine.recordUpdate(
			decodeURIComponent(collection),
			decodeURIComponent(id),
			data,
		);
		return record ? json(record) : json({ error: "Not found" }, 404);
	}

	private async handleDeleteRecord(collection: string, id: string): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const deleted = await engine.recordDelete(
			decodeURIComponent(collection),
			decodeURIComponent(id),
		);
		return deleted ? json({ success: true }) : json({ error: "Not found" }, 404);
	}

	// ── Files ─────────────────────────────────────────────────────────────────

	private async handleListFiles(url: URL): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const tags = url.searchParams.get("tags")?.split(",").filter(Boolean);
		const files = await engine.fileList({
			userId: url.searchParams.get("user_id") || undefined,
			tags: tags?.length ? tags : undefined,
			mimeType: url.searchParams.get("mime_type") || undefined,
		});
		return json({ files });
	}

	private async handleUploadFile(request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const body = await request.json<{
			name: string;
			content: string;
			contentBase64?: string;
			mime_type?: string;
			path?: string;
			tags?: string[];
			user_id?: string;
			extract_text?: boolean;
		}>();
		if (!body.name || (!body.content && !body.contentBase64))
			return json({ error: "name and content or contentBase64 required" }, 400);
		const data = body.contentBase64
			? bytesFromBase64(body.contentBase64).slice().buffer
			: body.content;
		const meta = await engine.fileUpload({
			name: body.name,
			path: body.path,
			mimeType: body.mime_type || "text/plain",
			data,
			userId: body.user_id,
			tags: body.tags,
			extractText: body.extract_text !== false,
		});
		return json(meta, 201);
	}

	private async handleGetFile(id: string): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const file = await engine.fileGet(decodeURIComponent(id));
		if (!file) return json({ error: "Not found" }, 404);
		return new Response(file.body, {
			headers: {
				"Content-Type": file.meta.mimeType,
				"Content-Disposition": `inline; filename="${file.meta.name}"`,
				"X-File-Meta": JSON.stringify({
					id: file.meta.id,
					name: file.meta.name,
					size: file.meta.size,
					tags: file.meta.tags,
				}),
			},
		});
	}

	private async handleDeleteFile(id: string): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const deleted = await engine.fileDelete(decodeURIComponent(id));
		return deleted ? json({ success: true }) : json({ error: "Not found" }, 404);
	}

	// ── Vector Search ─────────────────────────────────────────────────────────

	private async handleVectorSearch(request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const { query, top_k, source_type } = await request.json<{
			query: string;
			top_k?: number;
			source_type?: string;
		}>();
		if (!query) return json({ error: "query required" }, 400);
		const results = await engine.vectorSearch(query, top_k || 5, {
			sourceType: source_type as "knowledge" | "message" | "file" | "collection" | undefined,
		});
		return json({ results });
	}

	// ── Activity Log ──────────────────────────────────────────────────────────

	private async handleGetActivity(url: URL): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const events = await engine.getEvents({
			limit: Number(url.searchParams.get("limit")) || 50,
			type: url.searchParams.get("type") as import("./agent-storage-types.js").ActivityEvent["type"] | undefined,
			userId: url.searchParams.get("user_id") || undefined,
		});
		return json({ events });
	}

	// ── Summaries ─────────────────────────────────────────────────────────────

	private async handleGetSummaries(url: URL): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const limit = Number(url.searchParams.get("limit")) || 20;
		const summaries = await engine.getSummaries(limit);
		return json({ summaries });
	}

	private async handleForceSummarize(): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const summary = await engine.maybeSummarize(state.model);
		return summary
			? json({ summary })
			: json({ message: "Not enough messages to summarize" });
	}

	// ── User Context ──────────────────────────────────────────────────────────

	private async handleGetUserContext(userId: string): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const ctx = await engine.getUserContext(decodeURIComponent(userId));
		return json(ctx);
	}
}

/**
 * Parse tool calls from response text when the model embeds them as JSON
 * instead of using the structured tool_calls field.
 * Handles single or multiple: {"name":"...",...}; {"name":"...",...}
 */
function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
