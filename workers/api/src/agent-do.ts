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
import { bytesFromBase64 } from "./agent-storage-utils.js";
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
	addRepo,
	removeRepo,
	repoAlarmTick,
	statusList,
	type RepoFetchers,
} from "./lib/repo-ingest-runner.js";
import {
	UserAiCredentialsError,
	UserAiProviderError,
} from "./lib/user-ai.js";
import { safeFetch, SsrfError } from "./lib/ssrf.js";
import { logError } from "./lib/error-log.js";
import { isTransientInfraError } from "./lib/on-error.js";
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

export class AgentDO extends DurableObject<Env> {
	/** In-flight guard for fire-and-forget summarization. The DO input gate lets two
	 *  turns (e.g. concurrent WS + HTTP) interleave at await points; without this both
	 *  can cross the threshold and write overlapping summaries. Lives on the DO instance
	 *  (persistent) — the per-call storage engine can't hold cross-request state. */
	private summarizing = false;

	private getStorageEngine(agentId: string, userId?: string): AgentStorageEngine {
		// Platform-paid internal AI (embeddings + summary) is gated behind one master
		// switch. Off (default) → pass null AI, so embed/summary no-op and the platform
		// never spends tokens (BYOK-only). LLM chat is BYOK regardless of this flag.
		const platformAi = this.env.PLATFORM_AI_ENABLED === "true" ? this.env.AI || null : null;
		// When the acting user is known, meter platform-paid embeds/summaries into the
		// ai_usage ledger (provider="platform") so operator spend is visible (issue #44).
		const meter = platformAi && userId
			? { db: this.env.DB, userId, agentId }
			: null;
		return new AgentStorageEngine(
			this.ctx.storage,
			this.env.STORAGE || null,
			this.env.VECTORIZE || null,
			platformAi,
			agentId,
			meter,
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
			return this.handleWebSocket(request);
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
			if (path.startsWith("/knowledge/") && request.method === "GET")
				return this.handleReadKnowledge(path.slice("/knowledge/".length));
			if (path.startsWith("/knowledge/") && request.method === "PUT")
				return this.handleUpdateKnowledge(path.slice("/knowledge/".length), request);

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
			if (path === "/files/register" && request.method === "POST")
				return this.handleRegisterFile(request);
			if (path.match(/^\/files\/[^/]+$/) && request.method === "GET")
				return this.handleGetFile(path.slice("/files/".length));
			if (path.match(/^\/files\/[^/]+$/) && request.method === "DELETE")
				return this.handleDeleteFile(path.slice("/files/".length));

			// Vector search
			if (path === "/search" && request.method === "POST")
				return this.handleVectorSearch(request);
			if (path === "/vectors" && request.method === "GET")
				return this.handleVectorStats();

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
			// Last-resort persistence for any DO endpoint that isn't chat (chat logs in its
			// own catch): the route returns this 500 without throwing, so app.onError never
			// sees it. Skip transient infra (DO reset on deploy — self-heals, not a bug).
			if (!isTransientInfraError(err)) {
				await logError(this.env, {
					source: "agent-do",
					status: 500,
					message: message.slice(0, 500),
					context: {
						path,
						stack: err instanceof Error ? String(err.stack || "").slice(0, 1800) : undefined,
					},
				}).catch(() => undefined);
			}
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
			audioKey?: string;
			/** Set when a supervisor's durable loop is driving this turn (#183/#184/#185). */
			budgetId?: string | null;
			onBehalfOf?: string | null;
			traceId?: string | null;
		}>();
		const { message, channel, userId } = body;
		const delegation = body.budgetId || body.onBehalfOf || body.traceId
			? { budgetId: body.budgetId ?? null, onBehalfOf: body.onBehalfOf ?? null, traceId: body.traceId ?? null }
			: undefined;
		if (!message) return json({ error: "message required" }, 400);

		let state = await this.getState();

		// Auto-initialize if DO has no state (agent created via D1 but DO never init'd)
		if (!state) {
			const url = new URL(request.url);
			const agentId = body.agentId || url.searchParams.get("agentId");
			// NEVER auto-init with a placeholder. The old `|| "unknown"` fallback persisted that
			// literal as `state.agentId`, which is the Vectorize partition key AND the only filter
			// `vectorSearch` applies — so every DO that reached this path wrote and read vectors in
			// one shared `"unknown"` namespace, bleeding RAG between logically separate agents (and
			// between their owners). Its R2 file keys collapsed to `agents/unknown/files/…` too.
			// Refusing is safe: every real caller passes an agentId.
			if (!agentId) return json({ error: "agentId required to initialize this agent" }, 400);
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
			// Voice turns carry a per-turn audio id; the saved recording is replayed on
			// double-tap. Sanitized (it becomes an R2 key path segment).
			...(typeof body.audioKey === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.audioKey) ? { audioKey: body.audioKey } : {}),
			createdAt: new Date().toISOString(),
		};
		await this.appendMessage(userMsg);
		this.broadcast({ type: "message", message: userMsg });

		const engine = this.getStorageEngine(state.agentId, userId);
		await engine.logEvent("chat.message", userId, { messageId: userMsg.id });

		// Run agent loop
		await this.ctx.storage.put("state", { ...state, status: "thinking" });
		this.broadcast({ type: "status", status: "thinking" });

		try {
			const { response, toolCalls } = await this.think(state, engine, userId, delegation);

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
			// Single-flight: skip if a summarization is already running for this DO.
			if (!this.summarizing) {
				this.summarizing = true;
				engine
					.maybeSummarize(state.model)
					.catch(() => {})
					.finally(() => {
						this.summarizing = false;
					});
			}

			return json({ message: assistantMsg, toolMessage: toolMsg });
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			const status =
				err instanceof UserAiCredentialsError || err instanceof UserAiProviderError
					? err.status
					: 500;
			await this.ctx.storage.put("state", { ...state, status: "error" });
			this.broadcast({ type: "status", status: "error", error: errMsg });

			// Persist genuine chat failures so they surface in the owner's /v1/errors and
			// agent_trace — not only as an in-conversation "Error:" line. The route returns
			// this 500 without throwing, so app.onError never sees it; log it here or it's
			// invisible. Skip transient infra (DO reset on deploy — self-heals, not a bug).
			if (!isTransientInfraError(err)) {
				await logError(this.env, {
					source: "chat",
					status,
					message: errMsg.slice(0, 500),
					userId: userId ?? null,
					context: {
						instanceId: state.agentId,
						stack: err instanceof Error ? String(err.stack || "").slice(0, 1800) : undefined,
					},
				}).catch(() => undefined);
			}

			// #24: a late-round failure can leave earlier side effects already committed
			// (memory writes, created tasks, inserted records). Surface that completed work
			// as a tool message BEFORE the error, so it isn't hidden behind "Error:…".
			const partialToolLog =
				err && typeof err === "object"
					? (err as { partialToolLog?: string[] }).partialToolLog
					: undefined;
			if (partialToolLog && partialToolLog.length > 0) {
				const partialMsg: AgentMessage = {
					id: crypto.randomUUID(),
					role: "system",
					content: partialToolLog.join("\n"),
					channel: channel || "chat",
					createdAt: new Date().toISOString(),
				};
				await this.appendMessage(partialMsg);
				this.broadcast({ type: "message", message: partialMsg });
			}

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
		delegation?: { budgetId?: string | null; onBehalfOf?: string | null; traceId?: string | null },
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
			delegation,
		});
	}

	// ── WebSocket ──────────────────────────────────────────────────────────────

	private handleWebSocket(request: Request): Response {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		// Pin the server-verified user id (set by the authenticated /ws route) to
		// this socket. webSocketMessage reads it back instead of trusting any
		// client-supplied userId — which is what stops cross-user key abuse.
		const url = new URL(request.url);
		const userId = url.searchParams.get("user_id") || undefined;
		// The agent id is pinned too. Without it `webSocketMessage` synthesized a /chat request
		// carrying no agentId, so on a DO with no state the auto-init fell back to the literal
		// string "unknown" and PERSISTED it — and that value is the Vectorize partition key and
		// the only filter `vectorSearch` applies. Two seeded agents first touched over WS would
		// both write vectors tagged `agentId:"unknown"` and then read each other's chunks.
		const agentId = url.searchParams.get("agentId") || url.searchParams.get("agent_id") || undefined;

		this.ctx.acceptWebSocket(server);
		if (userId || agentId) server.serializeAttachment({ userId, agentId });

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
				// Use the server-verified uid pinned to the socket at accept time —
				// NEVER parsed.userId (a client could otherwise name any victim's uid
				// and run inference on their stored API key).
				const attach = ws.deserializeAttachment() as { userId?: string; agentId?: string } | null;
				const userId = attach?.userId;
				const request = new Request("https://internal/chat", {
					method: "POST",
					body: JSON.stringify({
						message: parsed.message,
						channel: "chat",
						userId,
						agentId: attach?.agentId,
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
		const all = await this.ctx.storage.list<AgentMessage>({ prefix: "msg:" });
		const keys = [...all.keys()];
		// The audio ids of the messages being cleared, returned so the route deletes EXACTLY those
		// R2 objects. A prefix delete would take the Coder Co-pilot's recordings with them —
		// coding_timeline audio lives under the same `voice-audio/{uid}/{instanceId}/` prefix — so
		// clearing the Assistant chat would silently destroy every Co-pilot recording for that
		// instance while its timeline rows (and their audio_key) survived, leaving replay 404ing
		// forever.
		const audioKeys = [...all.values()]
			.map((m) => (m as { audioKey?: unknown })?.audioKey)
			.filter((k): k is string => typeof k === "string" && !!k);
		for (let i = 0; i < keys.length; i += 128) {
			await this.ctx.storage.delete(keys.slice(i, i + 128));
		}
		// Also drop everything derived from those messages (summaries, extracted facts,
		// message vectors) so cleared content can't leak back through RAG. Best-effort —
		// the messages themselves are already gone.
		const state = await this.getState().catch(() => null);
		if (state?.agentId) {
			await this.getStorageEngine(state.agentId).clearConversationDerived().catch(() => undefined);
		}
		return json({ deleted: keys.length, audioKeys });
	}

	// ── Memory ─────────────────────────────────────────────────────────────────

	private async setMemory(
		key: string,
		type: string,
		content: string,
		source?: MemoryEntry["source"],
	): Promise<void> {
		const entry: MemoryEntry = {
			key,
			type: type as MemoryEntry["type"],
			content,
			updatedAt: new Date().toISOString(),
			...(source ? { source } : {}),
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
		const { key, type, content, source } = await request.json<{
			key: string;
			type: string;
			content: string;
			source?: MemoryEntry["source"];
		}>();
		if (!key || !type || content === undefined)
			return json({ error: "key, type, content required" }, 400);
		await this.setMemory(key, type, content, source);
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
		// Content may be empty — a document can be created title-first and filled in
		// later (in the editor or by the agent via update_knowledge).
		const content = typeof body.content === "string" ? body.content : "";
		if (!body.title)
			return json({ error: "title required" }, 400);
		if (content.length > 100_000)
			return json({ error: "Document too large (max 100KB)" }, 400);

		// Limit total knowledge base size (max 20 docs)
		const existing = await this.ctx.storage.list({ prefix: "kb:" });
		if (existing.size >= 20)
			return json({ error: "Knowledge base full (max 20 documents)" }, 400);

		const doc: KnowledgeDoc = {
			id: crypto.randomUUID(),
			title: body.title.slice(0, 500),
			content,
			source: body.source || "paste",
			sourceUrl: body.sourceUrl,
			addedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(`kb:${doc.id}`, doc);

		// Vectorize the document for semantic retrieval. The doc is saved either way, but we
		// must NOT report an unqualified success if it isn't searchable — surface it via a
		// `vectorized` flag + the error log so callers (résumé parse, MCP) can tell the user.
		let vectorized = true;
		const state = await this.getState();
		if (state) {
			const engine = this.getStorageEngine(state.agentId);
			// Indexing off (no Vectorize/AI binding, e.g. PLATFORM_AI_ENABLED=false): vectorizeStore
			// no-ops WITHOUT throwing, so report vectorized:false rather than a false green (#22).
			if (!engine.indexingEnabled) {
				vectorized = false;
			} else {
				try {
					await engine.vectorizeStore("knowledge", doc.id, `${doc.title}\n\n${doc.content}`);
				} catch (err) {
					vectorized = false;
					await logError(this.env, {
						source: "knowledge-vectorize",
						message: `knowledge doc saved but not searchable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
						context: { agentId: state.agentId, docId: doc.id },
					}).catch(() => undefined);
				}
			}
			await engine.logEvent("knowledge.added", undefined, {
				docId: doc.id,
				title: doc.title,
				size: doc.content.length,
				vectorized,
			}).catch(() => {});
		}

		return json({ ...doc, vectorized }, 201);
	}

	/** Read one document's full content (for the console viewer/editor). */
	private async handleReadKnowledge(id: string): Promise<Response> {
		const doc = await this.ctx.storage.get<KnowledgeDoc>(`kb:${decodeURIComponent(id)}`);
		if (!doc) return json({ error: "not found" }, 404);
		return json({ document: doc });
	}

	/** Amend a document's title/content from the console editor, re-vectorizing it. */
	private async handleUpdateKnowledge(id: string, request: Request): Promise<Response> {
		const decodedId = decodeURIComponent(id);
		const existing = await this.ctx.storage.get<KnowledgeDoc>(`kb:${decodedId}`);
		if (!existing) return json({ error: "not found" }, 404);
		const body = await request.json<{ title?: string; content?: string }>();
		if (typeof body.content === "string" && body.content.length > 100_000)
			return json({ error: "Document too large (max 100KB)" }, 400);
		const updated: KnowledgeDoc = {
			...existing,
			title: (typeof body.title === "string" && body.title.trim() ? body.title.trim() : existing.title).slice(0, 500),
			content: typeof body.content === "string" ? body.content : existing.content,
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(`kb:${decodedId}`, updated);

		let vectorized = true;
		const state = await this.getState();
		if (state) {
			const engine = this.getStorageEngine(state.agentId);
			if (!engine.indexingEnabled) {
				vectorized = false; // indexing off (#22) — don't claim a searchable update
			} else try {
				await engine.vectorDelete("knowledge", decodedId).catch(() => undefined);
				await engine.vectorizeStore("knowledge", decodedId, `${updated.title}\n\n${updated.content}`);
			} catch (err) {
				vectorized = false;
				await logError(this.env, {
					source: "knowledge-vectorize",
					message: `knowledge doc updated but not searchable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
					context: { agentId: state.agentId, docId: decodedId },
				}).catch(() => undefined);
			}
			await engine.logEvent("knowledge.updated", undefined, { docId: decodedId, title: updated.title, vectorized }).catch(() => undefined);
		}
		return json({ ...updated, vectorized });
	}

	private async handleDeleteKnowledge(id: string): Promise<Response> {
		const decodedId = decodeURIComponent(id);

		// Vectors FIRST, then the record (#242). The other order deletes the doc from the console
		// and, if Vectorize then errors, strands its chunks in the index with nothing left to
		// retry against — RAG keeps citing a document the user deleted, permanently. Failing here
		// leaves the document listed, so the user can simply delete it again.
		const state = await this.getState();
		if (state) {
			const engine = this.getStorageEngine(state.agentId);
			try {
				await engine.vectorDelete("knowledge", decodedId);
			} catch (err) {
				await logError(this.env, {
					source: "knowledge-vectorize",
					message: `knowledge doc NOT deleted — its indexed content could not be removed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
					context: { agentId: state.agentId, docId: decodedId },
				}).catch(() => undefined);
				return json({ error: "Couldn't remove this document's indexed content, so it was not deleted — it would keep answering searches. Try again." }, 503);
			}
			await this.ctx.storage.delete(`kb:${decodedId}`);
			await engine.logEvent("knowledge.removed", undefined, { docId: decodedId });
			return json({ success: true });
		}

		// No state (an uninitialised DO) — there is no vector index to reconcile against.
		await this.ctx.storage.delete(`kb:${decodedId}`);
		return json({ success: true });
	}

	private async handleIngestUrl(request: Request): Promise<Response> {
		const { url, title } = await request.json<{
			url: string;
			title?: string;
		}>();
		if (!url) return json({ error: "url required" }, 400);

		// Same 20-doc ceiling as handleAddKnowledge — Import URL must not be a backdoor
		// past the cap (a prompt-injected agent could otherwise ingest-url in a loop).
		const existingUrlDocs = await this.ctx.storage.list({ prefix: "kb:" });
		if (existingUrlDocs.size >= 20)
			return json({ error: "Knowledge base full (max 20 documents)" }, 400);

		try {
			// SSRF protection: https-only + reject non-public hosts, re-validated on EVERY
			// redirect hop (default follow would let a public host 302 us to a private one).
			let res: Response;
			try {
				res = await safeFetch(url, { headers: { "User-Agent": "ProAgentStore-Ingest" } });
			} catch (e) {
				return json({ error: e instanceof SsrfError ? e.message : `Failed to fetch: ${e instanceof Error ? e.message : String(e)}` }, 400);
			}
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

			// Vectorize so the imported page is actually RETRIEVABLE. The agent only surfaces
			// knowledge via RAG (buildRAGContext → vectorSearch) — a doc with no vectors is
			// invisible forever. handleAddKnowledge/handleUpdateKnowledge already do this; without
			// it, Import URL silently succeeded but the agent could never answer about the page.
			let vectorized = true;
			const state = await this.getState();
			if (state) {
				const engine = this.getStorageEngine(state.agentId);
				try {
					await engine.vectorizeStore("knowledge", doc.id, `${doc.title}\n\n${text}`);
				} catch (e) {
					vectorized = false;
					await logError(this.env, {
						source: "knowledge-vectorize",
						message: `ingested URL saved but not searchable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
						context: { agentId: state.agentId, docId: doc.id, url },
					}).catch(() => undefined);
				}
				await engine.logEvent("knowledge.added", undefined, { docId: doc.id, title: doc.title, size: text.length, source: "url", vectorized }).catch(() => {});
			}
			return json({ ...doc, vectorized }, 201);
		} catch (err) {
			return json(
				{
					error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
				},
				400,
			);
		}
	}

	// ── Repo ingestion (multi-repo) — logic lives in lib/repo-ingest-runner.ts ───

	/** GitHub + parsing deps injected into the runner. */
	private repoFetchers(): RepoFetchers {
		return { fetchRepoMeta, fetchRepoTarball, extractTextFiles, buildRepoOverview, findReadme, now: () => new Date().toISOString() };
	}

	private async handleIngestRepo(request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const { repoUrl, branch, token } = await request.json<{ repoUrl: string; branch?: string; token?: string }>();
		if (!repoUrl) return json({ error: "repoUrl required" }, 400);
		const ref = parseGithubUrl(repoUrl);
		if (!ref) return json({ error: "Not a recognizable GitHub repository URL" }, 400);
		const engine = this.getStorageEngine(state.agentId);
		const { job, error } = await addRepo(this.ctx.storage, engine, { ref, repoUrl, branch, token, now: new Date().toISOString() });
		if (error || !job) return json({ error: error || "Failed to add repository" }, 400);
		await this.ctx.storage.setAlarm(Date.now());
		return json({ status: job.status, repo: job.key }, 202);
	}

	private async handleIngestRepoStatus(): Promise<Response> {
		return json({ repos: await statusList(this.ctx.storage) });
	}

	private async handleClearRepo(request: Request): Promise<Response> {
		const state = await this.getState();
		const engine = state ? this.getStorageEngine(state.agentId) : null;
		const body = await request.json<{ repoUrl?: string; key?: string }>().catch(() => ({}) as { repoUrl?: string; key?: string });
		let key = body.key;
		if (!key && body.repoUrl) {
			const ref = parseGithubUrl(body.repoUrl);
			if (ref) key = `${ref.owner}/${ref.repo}`;
		}
		await removeRepo(this.ctx.storage, engine, key);
		return json({ status: "cleared" });
	}

	/** Alarm: advance one repo-ingestion tick, reschedule while work remains. */
	async alarm(): Promise<void> {
		// The DO alarm (repo-ingest state machine) doesn't go through app.onError, so a
		// crash would only hit the ephemeral console + a silent CF retry. Persist it with
		// a stack, then rethrow so CF still retries the alarm.
		try {
			const state = await this.getState();
			if (!state) return;
			const engine = this.getStorageEngine(state.agentId);
			const tick = await repoAlarmTick(this.ctx.storage, engine, this.repoFetchers());
			// A tick may ask for a real PAUSE. Rescheduling at +50ms after a tick that indexed
			// nothing turned "retry once on a later tick" into "retry 50ms later", so a transient
			// Workers-AI outage burned the single retry instantly and the repo finished "done"
			// with an empty index about 100ms after the outage started.
			const didWork = typeof tick === "boolean" ? tick : tick.didWork;
			const delayMs = typeof tick === "boolean" ? 50 : tick.delayMs;
			if (didWork) await this.ctx.storage.setAlarm(Date.now() + delayMs);
		} catch (err) {
			await logError(this.env, {
				source: "alarm",
				message: `DO alarm crashed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
				context: { stack: err instanceof Error ? String(err.stack || "").slice(0, 1500) : undefined },
			}).catch(() => undefined);
			throw err;
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

	/** Register an object the multipart upload already placed in R2 (see fileRegister). */
	private async handleRegisterFile(request: Request): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		const body = await request.json<{
			id: string;
			name: string;
			r2_key: string;
			mime_type?: string;
			user_id?: string;
		}>();
		if (!body.id || !body.name || !body.r2_key)
			return json({ error: "id, name, r2_key required" }, 400);
		const meta = await engine.fileRegister({
			id: body.id,
			name: body.name,
			r2Key: body.r2_key,
			mimeType: body.mime_type || "application/octet-stream",
			userId: body.user_id,
		});
		if (!meta) return json({ error: "Object not found in storage" }, 404);
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

	/** What's in the vector store, grouped by source — the Knowledge → Index panel. */
	private async handleVectorStats(): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		const engine = this.getStorageEngine(state.agentId);
		return json(await engine.vectorStats());
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
