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
import type {
	AgentMessage,
	AgentState,
	AgentTask,
	Guardrails,
	KnowledgeDoc,
	MemoryEntry,
} from "./agent-types.js";
import { AGENT_TOOLS, executeTool, type ToolCallRequest } from "./lib/tools.js";
import { STORAGE_TOOLS, executeStorageTool } from "./lib/storage-tools.js";
import { normalizeToolCalls, parseToolCallsFromText } from "./lib/parse-tool-calls.js";
import {
	runUserWorkersAi,
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

const DEFAULT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const MAX_CONTEXT_MESSAGES = 10;
const DEPRECATED_MODELS = new Set([
	"@cf/meta/llama-3.1-8b-instruct",
	"@cf/meta/llama-3.1-70b-instruct",
	"@cf/mistral/mistral-7b-instruct-v0.2",
	"@cf/qwen/qwen1.5-14b-chat-awq",
]);

/** Models that support structured function calling (tool_calls in response). */
const TOOL_CAPABLE_MODELS = new Set([
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/meta/llama-4-scout-17b-16e-instruct",
	"@cf/mistralai/mistral-small-3.1-24b-instruct",
	"@cf/qwen/qwen2.5-coder-32b-instruct",
]);

export class AgentDO extends DurableObject<Env> {
	private getStorageEngine(agentId: string): AgentStorageEngine {
		return new AgentStorageEngine(
			this.ctx.storage,
			this.env.STORAGE || null,
			this.env.VECTORIZE || null,
			this.env.AI || null,
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
		const guardrails: Guardrails = {
			topicRestrictions: config.guardrails?.topicRestrictions || "",
			blockedTerms: config.guardrails?.blockedTerms || [],
			responseStyle: config.guardrails?.responseStyle || "",
			maxResponseLength: config.guardrails?.maxResponseLength || 0,
			requireCitations: config.guardrails?.requireCitations || false,
		};
		const state: AgentState = {
			agentId: config.agentId,
			name: config.name,
			personality: config.personality || "",
			goal: config.goal || "",
			model: config.model || DEFAULT_MODEL,
			status: "idle",
			systemPrompt: this.buildSystemPrompt(
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

		// Auto-heal deprecated models
		if (!state.model || DEPRECATED_MODELS.has(state.model)) {
			state.model = DEFAULT_MODEL;
		}
		// Auto-migrate old state missing new fields
		if (!state.guardrails) {
			state.guardrails = {
				topicRestrictions: "",
				blockedTerms: [],
				responseStyle: "",
				maxResponseLength: 0,
				requireCitations: false,
			};
			state.welcomeMessage = state.welcomeMessage || "";
			state.isPublished = state.isPublished || false;
		}
		// Auto-recover stuck status (e.g., DO timed out mid-"thinking")
		if (state.status === "thinking" || state.status === "error") {
			state.status = "idle";
		}
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
			const response = await this.think(state, engine, userId);

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

			return json({ message: assistantMsg });
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
	): Promise<string> {
		const messages = await this.getRecentMessages(MAX_CONTEXT_MESSAGES);
		const memory = await this.getAllMemory();
		const tasks = await this.getAllTasks();

		const lastUserMessage = messages.filter((m) => m.role === "user").pop()?.content || "";

		let systemPrompt = state.systemPrompt;

		const ragContext = await engine.buildRAGContext(lastUserMessage);
		if (ragContext) systemPrompt += `\n\n${ragContext}`;

		if (memory.length > 0) {
			systemPrompt += "\n\n## Your Memory\n";
			for (const m of memory) {
				systemPrompt += `- [${m.type}] ${m.key}: ${m.content}\n`;
			}
		}

		const activeTasks = tasks.filter((t) => t.status !== "complete");
		if (activeTasks.length > 0) {
			systemPrompt += "\n\n## Active Tasks\n";
			for (const t of activeTasks) {
				systemPrompt += `- [${t.status}] ${t.title}: ${t.description}\n`;
			}
		}

		if (userId) {
			const userCtx = await engine.getUserContext(userId);
			await engine.touchUserContext(userId);
			if (Object.keys(userCtx.preferences).length > 0) {
				systemPrompt += "\n\n## User Preferences\n";
				for (const [key, value] of Object.entries(userCtx.preferences)) {
					systemPrompt += `- ${key}: ${value}\n`;
				}
			}
		}

		const useTools = TOOL_CAPABLE_MODELS.has(state.model);
		if (useTools) {
			systemPrompt +=
				"\n\nYou have tools available. Use them to manage your memory, tasks, files, collections (structured data), and search your knowledge.";
		}

		const aiMessages: { role: string; content: string }[] = [
			{ role: "system", content: systemPrompt },
			...messages.map((m) => ({ role: m.role, content: m.content })),
		];

		// Simple path: no tool support — just call the model and return
		if (!useTools) {
			const result = (await runUserWorkersAi(
				this.env,
				userId,
				state.model,
				{ messages: aiMessages },
			)) as { response?: string };
			return result.response || "";
		}

		// Tool-capable model: send the most useful tools (not all 24 — too many overwhelms the model)
		const CORE_TOOLS = new Set([
			"read_memory", "write_memory", "get_tasks", "create_task", "update_task",
			"search_knowledge", "upload_file", "list_files",
			"create_collection", "list_collections", "insert_record", "query_records", "update_record",
			"get_activity", "get_user_context", "set_user_preference",
		]);
		const allTools = [...AGENT_TOOLS, ...STORAGE_TOOLS].filter((t) => CORE_TOOLS.has(t.name));
		const tools = allTools.map((t) => ({
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

		const MAX_TOOL_ROUNDS = 3;
		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			const rawResult = (await runUserWorkersAi(
				this.env,
				userId,
				state.model,
				{ messages: aiMessages, tools },
			)) as Record<string, unknown>;

			let toolCalls = normalizeToolCalls((rawResult.tool_calls as unknown[]) || []);
			if (toolCalls.length === 0 && rawResult.response) {
				toolCalls = parseToolCallsFromText(rawResult.response as string);
			}

			if (toolCalls.length === 0) {
				return (rawResult.response as string) || "";
			}

			const toolResults: string[] = [];
			const storageToolNames = new Set(STORAGE_TOOLS.map((t) => t.name));
			for (const tc of toolCalls) {
				let toolResult;
				if (storageToolNames.has(tc.name)) {
					toolResult = await executeStorageTool(
						{ name: tc.name, input: tc.arguments },
						engine,
					);
				} else {
					const callReq: ToolCallRequest = { name: tc.name, input: tc.arguments };
					toolResult = await executeTool(
						callReq,
						this.ctx.storage,
						this.env.STORAGE,
						state.agentId,
					);
				}
				toolResults.push(`[${tc.name}]: ${toolResult.content}`);
				this.broadcast({
					type: "tool_call",
					tool: tc.name,
					result: toolResult,
				});
				// Log tool call as activity
				await engine.logEvent("tool.called", userId, {
					tool: tc.name,
					success: toolResult.success,
				});
			}

			aiMessages.push({
				role: "assistant",
				content: `I called tools:\n${toolResults.join("\n")}`,
			});
			aiMessages.push({
				role: "user",
				content: "Continue based on the tool results above.",
			});
		}

		const final = (await runUserWorkersAi(
			this.env,
			userId,
			state.model,
			{ messages: aiMessages },
		)) as { response?: string };
		return final.response || "";
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
		const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
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
			state.guardrails = {
				topicRestrictions: "",
				blockedTerms: [],
				responseStyle: "",
				maxResponseLength: 0,
				requireCitations: false,
			};
			state.welcomeMessage = state.welcomeMessage || "";
			state.isPublished = state.isPublished || false;
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
		state.systemPrompt = this.buildSystemPrompt(
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
			mime_type?: string;
			path?: string;
			tags?: string[];
			user_id?: string;
		}>();
		if (!body.name || !body.content)
			return json({ error: "name and content required" }, 400);
		const meta = await engine.fileUpload({
			name: body.name,
			path: body.path,
			mimeType: body.mime_type || "text/plain",
			data: body.content,
			userId: body.user_id,
			tags: body.tags,
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

	// ── Helpers ────────────────────────────────────────────────────────────────

	private buildSystemPrompt(
		name: string,
		personality?: string,
		goal?: string,
		guardrails?: Guardrails,
	): string {
		let prompt = `You are ${name}, a server-powered AI agent on ProAgentStore.`;
		if (personality) prompt += `\n\nPersonality: ${personality}`;
		if (goal) prompt += `\n\nGoal: ${goal}`;

		if (guardrails) {
			if (guardrails.topicRestrictions) {
				prompt += `\n\nTopic restrictions: ${guardrails.topicRestrictions}. If the user asks about anything outside this scope, politely decline and redirect to your area of expertise.`;
			}
			if (guardrails.blockedTerms.length > 0) {
				prompt += `\n\nNever use these words or phrases: ${guardrails.blockedTerms.join(", ")}`;
			}
			if (guardrails.responseStyle) {
				prompt += `\n\nResponse style: ${guardrails.responseStyle}`;
			}
			if (guardrails.maxResponseLength > 0) {
				prompt += `\n\nKeep responses under ${guardrails.maxResponseLength} characters.`;
			}
			if (guardrails.requireCitations) {
				prompt +=
					"\n\nAlways cite which knowledge base document you are drawing from when answering.";
			}
		}

		prompt +=
			"\n\nYou have persistent memory and tasks. Be helpful, concise, and proactive about completing your tasks.";
		return prompt;
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
