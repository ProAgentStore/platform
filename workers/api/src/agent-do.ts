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
 *
 * What stays HERE is what needs the object itself: the routing table, the conversation, the
 * turn lifecycle (#251 — a turn is a promise the DO owns, with an in-flight marker only this
 * instance can vouch for), the WebSockets, memory/tasks/state, and the alarm. What only needs
 * the storage engine or a storage prefix lives beside it and is unit-tested there:
 *   agent-think.ts             the agent loop (context → model → tools)
 *   agent-do-tools.ts          the tool catalog
 *   agent-do-storage-routes.ts collections, records, files, search, activity, summaries
 *   agent-do-knowledge.ts      the `kb:` documents and their vectors
 *   lib/repo-ingest-runner.ts  the repo-ingest state machine the alarm advances
 */
import { DurableObject } from "cloudflare:workers";
import { AgentStorageEngine } from "./agent-storage.js";
import type {
	AgentMessage,
	AgentState,
	AgentTask,
	Guardrails,
	MemoryEntry,
} from "./agent-types.js";
import * as storageRoutes from "./agent-do-storage-routes.js";
import {
	addKnowledge,
	deleteKnowledge,
	getKnowledge,
	ingestUrl,
	readKnowledge,
	updateKnowledge,
	type KnowledgeCtx,
} from "./agent-do-knowledge.js";
import {
	buildSystemPrompt,
	defaultGuardrails,
	DEFAULT_MODEL,
	ensureStateDefaults,
} from "./agent-do-prompt.js";
import { runAgentThink } from "./agent-think.js";
import { isResumableFor, RESUMED_NOTICE, type ResumableRound, resumableRoundOf, thinkWithAutoResume } from "./lib/resumable-round.js";
import { logEvent } from "./lib/events.js";
import type { ConversationTransfer } from "./lib/conversation-transfer.js";
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
import {
	INFLIGHT_PREFIX,
	inflightKey,
	interruptedNotice,
	partitionTurns,
	previewOf,
	type InflightTurn,
} from "./lib/chat-inflight.js";
import { MAX_TASKS, taskListPayload } from "./lib/agent-tasks.js";
import { turnSpanFor } from "./lib/chat-turns.js";
import { ChatTurnGate } from "./lib/chat-turn-gate.js";
import { json } from "./lib/do-json.js";
import {
	assembleMessagePage,
	MESSAGE_KEY_PREFIX,
	messageListOptions,
	messageStorageKey,
	resolveCursor,
} from "./lib/message-page.js";
import { isFabricatedRecord } from "./lib/fabricated-history.js";
import { logError } from "./lib/error-log.js";
import { resolveMeterIds } from "./lib/meter-ids.js";
import { platformAiBinding } from "./lib/platform-settings.js";
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

/**
 * Where a failed turn's completed tool rounds wait for the retry (#442). ONE slot per instance: a
 * stored round is only valid for an immediate retry of the same question, so a second could only be
 * an older ghost, and a per-turn scheme would need a sweeper for rounds nobody came back for.
 */
const RESUMABLE_KEY = "resumableRound";

/**
 * A system line in the transcript. `runTurn` built this five-field literal four times over — the
 * tool-call log, the #24 partial log, the error line, and now #442's resumed notice — and the
 * `channel || "chat"` fallback is part of the shape, so four copies are four places for a system
 * line to land on the wrong channel. Collapsed when the fourth arrived, not before.
 */
function systemMessage(content: string, channel: string | undefined): AgentMessage {
	return { id: crypto.randomUUID(), role: "system", content, channel: channel || "chat", createdAt: new Date().toISOString() };
}

export class AgentDO extends DurableObject<Env> {
	/** In-flight guard for fire-and-forget summarization. The DO input gate lets two
	 *  turns (e.g. concurrent WS + HTTP) interleave at await points; without this both
	 *  can cross the threshold and write overlapping summaries. Lives on the DO instance
	 *  (persistent) — the per-call storage engine can't hold cross-request state. */
	private summarizing = false;

	/** Turn ids this DO instance is running RIGHT NOW (#251). A persisted in-flight marker whose
	 *  id is missing here belongs to a turn that died — the object restarted under it, or the
	 *  work was killed — which is the only way to tell "still thinking" from "silently lost". */
	private liveTurns = new Set<string>();

	/** One chat turn at a time, and everything said DURING one answered together by the next
	 *  (#429). The same instance-level shape as `summarizing` above and for the same reason: the
	 *  input gate opens at every non-storage await, so two turns used to run against one agent,
	 *  sample the same state at different instants, and contradict each other on screen. Rule +
	 *  tests in lib/chat-turn-gate.ts; `fork` clones the Response because a body is read once. */
	private turnGate = new ChatTurnGate<Response>((res) => res.clone());

	/**
	 * Async because the platform-AI switch is now a RUNTIME setting an operator can flip
	 * without a deploy (#46), not just an env var. Resolving it here — once per engine,
	 * i.e. once per unit of work — is what keeps a per-call kill switch cheap: a
	 * repo-ingest tick that embeds 60 chunks reads the setting once, not 60 times. The
	 * `await` is deliberately in the type: a synchronous fallback would be a second,
	 * staler source of truth for the same question.
	 */
	private async getStorageEngine(agentId: string, userId?: string): Promise<AgentStorageEngine> {
		// Platform-paid internal AI (embeddings + summary) is gated behind one master
		// switch. Off → pass null AI, so embed/summary no-op and the platform never spends
		// tokens (BYOK-only). LLM chat is BYOK regardless of this flag.
		const platformAi = await platformAiBinding(this.env);
		// Meter platform-paid embeds/summaries into the ai_usage ledger when the acting user is known (#44).
		// WHICH id this DO's name is — agent or instance — is a lookup, never an assumption: lib/meter-ids.ts.
		const meter =
			platformAi && userId ? { db: this.env.DB, userId, ...(await resolveMeterIds(this.env, agentId)) } : null;
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
	 * Run a storage-only route: resolve this agent's engine, or answer 404 exactly as every
	 * one of those handlers used to do inline. The 404 is decided BEFORE the handler reads the
	 * request body — same order as before, so a body-less 404 stays a body-less 404.
	 */
	private async withEngine(
		fn: (engine: AgentStorageEngine, state: AgentState) => Promise<Response>,
	): Promise<Response> {
		const state = await this.getState();
		if (!state) return json({ error: "Not initialized" }, 404);
		return fn(await this.getStorageEngine(state.agentId), state);
	}

	/** Dependencies the knowledge-base routes need (see agent-do-knowledge.ts). */
	private knowledgeCtx(): KnowledgeCtx {
		return {
			storage: this.ctx.storage,
			env: this.env,
			resolve: async () => {
				const state = await this.getState();
				return state
					? { agentId: state.agentId, engine: await this.getStorageEngine(state.agentId) }
					: null;
			},
		};
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
			if (path.startsWith("/messages/") && request.method === "DELETE")
				return this.handleDeleteTurn(decodeURIComponent(path.slice("/messages/".length)));
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

			// Knowledge base (handlers in agent-do-knowledge.ts)
			if (path === "/knowledge" && request.method === "GET")
				return getKnowledge(this.knowledgeCtx());
			if (path === "/knowledge" && request.method === "POST")
				return addKnowledge(this.knowledgeCtx(), request);
			if (path.startsWith("/knowledge/") && request.method === "DELETE") {
				return deleteKnowledge(this.knowledgeCtx(), path.slice("/knowledge/".length));
			}
			if (path === "/knowledge/ingest-url" && request.method === "POST")
				return ingestUrl(this.knowledgeCtx(), request);
			if (path.startsWith("/knowledge/") && request.method === "GET")
				return readKnowledge(this.knowledgeCtx(), path.slice("/knowledge/".length));
			if (path.startsWith("/knowledge/") && request.method === "PUT")
				return updateKnowledge(this.knowledgeCtx(), path.slice("/knowledge/".length), request);

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

			// Everything below is the storage engine and nothing else — the handlers live in
			// agent-do-storage-routes.ts; `withEngine` resolves the engine (404 if the DO was
			// never initialised), which is the only DO state they ever needed.

			// Collections (structured storage)
			if (path === "/collections" && request.method === "GET")
				return this.withEngine((e) => storageRoutes.listCollections(e));
			if (path === "/collections" && request.method === "POST")
				return this.withEngine((e) => storageRoutes.createCollection(e, request));
			if (path.match(/^\/collections\/[^/]+$/) && request.method === "GET")
				return this.withEngine((e) => storageRoutes.getCollection(e, path.slice("/collections/".length)));
			if (path.match(/^\/collections\/[^/]+$/) && request.method === "DELETE")
				return this.withEngine((e) => storageRoutes.deleteCollection(e, path.slice("/collections/".length)));
			if (path.match(/^\/collections\/[^/]+\/records$/) && request.method === "GET")
				return this.withEngine((e) => storageRoutes.queryRecords(e, path.split("/")[2], url));
			if (path.match(/^\/collections\/[^/]+\/records$/) && request.method === "POST")
				return this.withEngine((e) => storageRoutes.insertRecord(e, path.split("/")[2], request));
			if (path.match(/^\/collections\/[^/]+\/records\/[^/]+$/) && request.method === "GET")
				return this.withEngine((e) => storageRoutes.getRecord(e, path.split("/")[2], path.split("/")[4]));
			if (path.match(/^\/collections\/[^/]+\/records\/[^/]+$/) && request.method === "PUT")
				return this.withEngine((e) => storageRoutes.updateRecord(e, path.split("/")[2], path.split("/")[4], request));
			if (path.match(/^\/collections\/[^/]+\/records\/[^/]+$/) && request.method === "DELETE")
				return this.withEngine((e) => storageRoutes.deleteRecord(e, path.split("/")[2], path.split("/")[4]));

			// Files
			if (path === "/files" && request.method === "GET")
				return this.withEngine((e) => storageRoutes.listFiles(e, url));
			if (path === "/files" && request.method === "POST")
				return this.withEngine((e) => storageRoutes.uploadFile(e, request));
			if (path === "/files/register" && request.method === "POST")
				return this.withEngine((e) => storageRoutes.registerFile(e, request));
			if (path.match(/^\/files\/[^/]+$/) && request.method === "GET")
				return this.withEngine((e) => storageRoutes.getFile(e, path.slice("/files/".length)));
			if (path.match(/^\/files\/[^/]+$/) && request.method === "DELETE")
				return this.withEngine((e) => storageRoutes.deleteFile(e, path.slice("/files/".length)));

			// Vector search
			if (path === "/search" && request.method === "POST")
				return this.withEngine((e) => storageRoutes.vectorSearch(e, request));
			if (path === "/vectors" && request.method === "GET")
				return this.withEngine((e) => storageRoutes.vectorStats(e));

			// Activity log
			if (path === "/activity" && request.method === "GET")
				return this.withEngine((e) => storageRoutes.getActivity(e, url));

			// Summaries
			if (path === "/summaries" && request.method === "GET")
				return this.withEngine((e) => storageRoutes.getSummaries(e, url));
			if (path === "/summarize" && request.method === "POST")
				return this.withEngine((e, state) => storageRoutes.forceSummarize(e, state.model));

			// User context
			if (path.match(/^\/users\/[^/]+\/context$/) && request.method === "GET")
				return this.withEngine((e) => storageRoutes.getUserContext(e, path.split("/")[2]));

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
			dictation?: string;
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

		// A turn that died with its request (tab closed, client gone) leaves its side effects
		// committed and no reply in the transcript. Say so before building this turn's context —
		// otherwise the model reasons from a history it can see is missing an answer it in fact
		// gave, and the honesty rules in the prompt cannot help, because the record itself is wrong.
		await this.reapAbandonedTurns(channel);

		// Save user message
		const userMsg: AgentMessage = {
			id: crypto.randomUUID(),
			role: "user",
			content: message,
			channel: channel || "chat",
			userId,
			// Voice turns carry a per-turn audio id; the saved recording is replayed from the
			// message's speaker button. Sanitized (it becomes an R2 key path segment).
			...(typeof body.audioKey === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.audioKey) ? { audioKey: body.audioKey } : {}),
			// The live capture for a voice turn (#319), stored ON the message so it shares the
			// transcript's lifetime exactly — no second retention rule to keep in step, and a
			// cleared chat cannot leave a dictation behind. Capped like any client-supplied
			// string; it is NEVER read back into the model's context, only shown to the user.
			...(typeof body.dictation === "string" && body.dictation.trim() ? { dictation: body.dictation.slice(0, 4000) } : {}),
			// The turn id the caller minted (#514), so this message can be joined to the
			// `chat.in`/`tool.call`/`chat.out`/`chat.truncated` events that describe the same turn.
			...(delegation?.traceId ? { traceId: delegation.traceId } : {}),
			createdAt: new Date().toISOString(),
		};
		await this.appendMessage(userMsg);
		this.broadcast({ type: "message", message: userMsg });

		const engine = await this.getStorageEngine(state.agentId, userId);
		await engine.logEvent("chat.message", userId, { messageId: userMsg.id });

		// Run agent loop
		await this.ctx.storage.put("state", { ...state, status: "thinking" });
		this.broadcast({ type: "status", status: "thinking" });

		// Detach the turn from the request (#251). The work below persists its own results, so
		// once it is started the reply lands in the transcript whether or not the caller is still
		// listening. The request still awaits it — a connected client sees exactly what it saw
		// before — but it no longer OWNS it: navigating away mid-turn can no longer strand the
		// tool side effects with no assistant message beside them.
		//
		// …and only ONE at a time (#429). The user message above is already durable and broadcast,
		// so an arrival mid-turn is never lost; the gate decides only WHEN it is answered. If a turn
		// is running, this arrival joins the single follow-up turn that starts when it finishes, and
		// that turn reads the transcript — including this message — so it answers everything said
		// while the agent was talking. Two turns running at once is what produced two replies to one
		// question, none to the other, and a step count that went backwards.
		const turn = this.turnGate.submit(async () => {
			// Re-read at execution time: a queued turn may start seconds after it was submitted, and
			// `runTurn` writes `state` back at the end. Using the copy captured at submit would
			// resurrect a status the turn before it had already moved on from.
			const current = (await this.getState()) ?? state;
			ensureStateDefaults(current);
			return this.runTurn(current, engine, userId, channel, message, delegation);
		});
		this.keepAlive(turn);
		return turn;
	}

	/**
	 * One chat turn, owned by the DO rather than by the request that asked for it (#251).
	 * Registers an in-flight marker for its lifetime so an interrupted turn is a fact the next
	 * reader can see, instead of a silent gap. Never rejects — every path returns a Response.
	 */
	private async runTurn(
		state: AgentState,
		engine: AgentStorageEngine,
		userId: string | undefined,
		channel: string | undefined,
		message: string,
		delegation: { budgetId: string | null; onBehalfOf: string | null; traceId: string | null } | undefined,
	): Promise<Response> {
		const turnId = crypto.randomUUID();
		this.liveTurns.add(turnId);
		await this.ctx.storage
			.put(inflightKey(turnId), {
				turnId,
				startedAt: Date.now(),
				userId: userId ?? null,
				channel: channel || "chat",
				preview: previewOf(message),
			} satisfies InflightTurn)
			.catch(() => undefined);
		// #442: a previous attempt at THIS question that got as far as running tools and then failed
		// in generation. Read and CLEARED in one step, whether or not it is usable — a round that
		// does not match the question being asked is stale by definition, and leaving it would let a
		// later, unrelated retry of the same words pick it up. One slot per instance; the failure is
		// per-turn and a second stored round would only ever be the first one's ghost.
		const stored = await this.ctx.storage.get<ResumableRound>(RESUMABLE_KEY).catch(() => null);
		const resume = isResumableFor(stored, message, Date.now()) ? stored : undefined;
		if (stored) await this.ctx.storage.delete(RESUMABLE_KEY).catch(() => undefined);
		if (resume) {
			// Labelled, per #442: a user who retries is asking for the answer, not for a decision
			// about caching — but they are entitled to know the results are not fresh.
			const notice = systemMessage(RESUMED_NOTICE, channel);
			await this.appendMessage(notice);
			this.broadcast({ type: "message", message: notice });
		}
		try {
			// #518: one automatic retry, from the round the failed attempt left behind.
			//
			// #442 made the retry cheap and left PERFORMING it to the user, behind a gate that is
			// byte equality with the failed message — on an instance its owner drives by VOICE, where
			// two utterances of one sentence never transcribe alike, and from a console that had
			// already cleared the text the error told him to send again. The platform is the only
			// party still holding that exact string, so the platform is what retries. Only a failure
			// the provider itself called retryable qualifies, so the deterministic `total` deadline —
			// whose message says a retry fails identically — still fails once and stays failed.
			// The event row is the measurement: a recovery nobody can count is one nobody trusts.
			const { response, toolCalls, transfer } = await thinkWithAutoResume(
				(r) => this.think(state, engine, userId, delegation, r),
				{
					resume,
					onAutoResume: (round, failure) =>
						logEvent(this.env, {
							source: "chat",
							event: "chat.auto_resumed",
							level: "warn",
							message: (failure instanceof Error ? failure.message : String(failure)).slice(0, 300),
							userId: userId ?? null,
							instanceId: state.agentId,
							traceId: delegation?.traceId ?? null,
							context: { toolsCarried: round.executedTools, roundsUsed: round.roundsUsed },
						}),
				},
			);

			// Save tool calls as a system message (visible in chat)
			let toolMsg: AgentMessage | undefined;
			if (toolCalls.length > 0) {
				toolMsg = systemMessage(toolCalls.join("\n"), channel);
				await this.appendMessage(toolMsg);
				this.broadcast({ type: "message", message: toolMsg });
			}

			const assistantMsg: AgentMessage = {
				id: crypto.randomUUID(),
				role: "assistant",
				content: response,
				channel: channel || "chat",
				// Same turn id as the user message that provoked it (#514) — the pair is what makes
				// "the message I am complaining about, and the turn before it" addressable at all.
				...(delegation?.traceId ? { traceId: delegation.traceId } : {}),
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

			// #279: the destination the user asked to be moved to, on the response they are already
			// awaiting. It is attached HERE and nowhere else in this DO — not on a broadcast, not on a
			// system message, not on the message list — because a channel a client polls could deliver
			// a move nobody asked for, and this one physically cannot: it exists only as the answer to
			// a sentence the user just spoke. See lib/conversation-transfer.ts.
			return json({ message: assistantMsg, toolMessage: toolMsg, ...(transfer ? { transfer } : {}) });
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

			// #442: this turn ran tools and then failed. Store the round so the retry the user is
			// about to perform continues from the results instead of re-fetching them — and, where
			// the round's tools were writes, does not commit the side effect twice. Stored only on
			// failure and only when something executed; `buildResumableRound` returns null
			// otherwise, and a null store leaves behaviour byte-identical to before.
			const resumable = resumableRoundOf(err);
			if (resumable) await this.ctx.storage.put(RESUMABLE_KEY, resumable).catch(() => undefined);

			// #24: a late-round failure can leave earlier side effects already committed
			// (memory writes, created tasks, inserted records). Surface that completed work
			// as a tool message BEFORE the error, so it isn't hidden behind "Error:…".
			const partialToolLog =
				err && typeof err === "object"
					? (err as { partialToolLog?: string[] }).partialToolLog
					: undefined;
			if (partialToolLog && partialToolLog.length > 0) {
				const partialMsg = systemMessage(partialToolLog.join("\n"), channel);
				await this.appendMessage(partialMsg);
				this.broadcast({ type: "message", message: partialMsg });
			}

			const errorMsg = systemMessage(`Error: ${errMsg}`, channel);
			await this.appendMessage(errorMsg);
			this.broadcast({ type: "message", message: errorMsg });

			return json({ error: errMsg }, status);
		} finally {
			this.liveTurns.delete(turnId);
			await this.ctx.storage.delete(inflightKey(turnId)).catch(() => undefined);
		}
	}

	/**
	 * Keep a promise the DO owns alive past the request that started it. `waitUntil` is a no-op
	 * on some runtimes/test doubles (a Durable Object is not evicted while work is pending), so
	 * it is called defensively — and the promise's rejection is swallowed here, never dropped as
	 * an unhandled one, because nothing else is awaiting this copy of it.
	 */
	private keepAlive(work: Promise<unknown>): void {
		const settled = work.then(
			() => undefined,
			() => undefined,
		);
		const ctx = this.ctx as unknown as { waitUntil?: (p: Promise<unknown>) => void };
		if (typeof ctx.waitUntil === "function") {
			try {
				ctx.waitUntil(settled);
			} catch {
				/* runtime doesn't support it here — the DO keeps the promise alive anyway */
			}
		}
	}

	/** The in-flight turn markers this DO instance has persisted. */
	private async listInflightTurns(): Promise<InflightTurn[]> {
		const all = await this.ctx.storage.list<InflightTurn>({ prefix: INFLIGHT_PREFIX });
		return [...all.values()].filter((t) => t && typeof t.turnId === "string");
	}

	/**
	 * Turn every abandoned marker into a visible line in the transcript, then clear it (#251).
	 * Idempotent — the marker is deleted with the notice, and "with" is literal: only once the append
	 * SUCCEEDED, or a swallowed write loses the record AND the one thing that could ever re-emit it.
	 */
	private async reapAbandonedTurns(channel?: string): Promise<InflightTurn[]> {
		const turns = await this.listInflightTurns().catch(() => [] as InflightTurn[]);
		if (turns.length === 0) return [];
		const { running, abandoned } = partitionTurns(turns, {
			isLive: (id) => this.liveTurns.has(id),
			now: Date.now(),
		});
		for (const turn of abandoned) {
			const msg: AgentMessage = {
				id: crypto.randomUUID(),
				role: "system",
				content: interruptedNotice(turn),
				channel: turn.channel || channel || "chat",
				createdAt: new Date().toISOString(),
			};
			const persisted = await this.appendMessage(msg).then(() => true, () => false);
			this.broadcast({ type: "message", message: msg });
			if (persisted) await this.ctx.storage.delete(inflightKey(turn.turnId)).catch(() => undefined);
		}
		return running;
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
		resume?: ResumableRound,
	): Promise<{ response: string; toolCalls: string[]; transfer?: ConversationTransfer }> {
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
			resume,
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
		await this.ctx.storage.put(messageStorageKey(msg), msg);
	}

	private async getRecentMessages(limit: number): Promise<AgentMessage[]> {
		const all = await this.ctx.storage.list<AgentMessage>({
			prefix: MESSAGE_KEY_PREFIX,
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
		// #428: "Load older messages" returned the newest page forever, because this handler read
		// only `limit`. The seek lives in lib/message-page.ts — one definition of the key format,
		// an exclusive `end` bound for "strictly older than", and a `limit + 1` probe so `hasMore`
		// is measured here rather than guessed from a page length in the console.
		const cursor = resolveCursor(url.searchParams.get("before"));
		if (cursor.kind === "invalid") return json({ error: cursor.reason }, 400);
		const all = await this.ctx.storage.list<AgentMessage>(messageListOptions(cursor, limit));
		const page = assembleMessagePage([...all.entries()], limit);
		// Mark, don't delete (#406). The user ACTED on these answers — an invented ticket list was
		// the basis of a decision — so the row stays exactly as written and is stamped instead, and
		// the console renders a stamped message differently from a real one. The stamp is computed
		// here rather than stored, which is the whole reason it reaches rows written before #395's
		// guard existed. It is decided per message, so it applies to EVERY page — an older page is
		// stamped exactly like the newest one, and paging cannot quietly hand back unmarked rows.
		// What the model sees is handled at the other end, in agent-think.ts.
		return json({
			messages: page.messages.map((m) => (isFabricatedRecord(m) ? { ...m, fabricated: true as const } : m)),
			nextCursor: page.nextCursor,
			hasMore: page.hasMore,
		});
	}

	private async handleClearMessages(): Promise<Response> {
		const all = await this.ctx.storage.list<AgentMessage>({ prefix: MESSAGE_KEY_PREFIX });
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
			await (await this.getStorageEngine(state.agentId)).clearConversationDerived().catch(() => undefined);
		}
		return json({ deleted: keys.length, audioKeys });
	}

	/**
	 * Delete ONE turn (#342) — the exchange containing `messageId`, resolved by `turnSpanFor`.
	 *
	 * The same three things go together that Clear chat already ties together, and for the same
	 * reason: the message record, the `audioKey` of its recording, and the `dictation` captured
	 * beside it (#319). The dictation needs no handling at all — it is stored ON the message, so
	 * it shares the transcript's lifetime by construction; that was the point of putting it there
	 * rather than in a second store with a second retention rule to keep in step. The audio is the
	 * one piece that lives elsewhere (R2, outside the DO), so its ids are RETURNED for the route to
	 * delete — never a prefix sweep, which would take the Coder Co-pilot's recordings with it.
	 *
	 * What is NOT removed, deliberately: conversation summaries and the facts extracted from them.
	 * Clear chat drops those wholesale because it is dropping everything; for one turn there is no
	 * precise removal — a summary is an aggregate over twenty messages and cannot be un-mixed. The
	 * console says so plainly in the confirmation rather than implying the turn is unmade, which is
	 * the same honesty rule the deletion itself is for: an accurate record, not a flattering one.
	 */
	private async handleDeleteTurn(messageId: string): Promise<Response> {
		if (!messageId) return json({ error: "message id required" }, 400);
		const all = await this.ctx.storage.list<AgentMessage>({ prefix: MESSAGE_KEY_PREFIX });
		// `list` returns keys in lexicographic order and the key is `msg:{ISO createdAt}:{id}`,
		// so this is already log order — the ordering `turnSpanFor` assumes.
		const entries = [...all.entries()].map(([key, msg]) => ({ key, ...msg }));
		const span = turnSpanFor(entries, messageId);
		// An id that is not in the log resolves to nothing rather than to its neighbours.
		if (!span.length) return json({ error: "Message not found" }, 404);
		await this.ctx.storage.delete(span.map((m) => m.key));
		const audioKeys = span
			.map((m) => (m as { audioKey?: unknown }).audioKey)
			.filter((k): k is string => typeof k === "string" && !!k);
		return json({ deleted: span.length, ids: span.map((m) => m.id), audioKeys });
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

	/** Owner-facing read (#337) — shape, staleness and limits come from lib/agent-tasks.ts, the
	 *  same module the prompt renders from, so the badge and the prompt cannot disagree. */
	private async handleGetTasks(): Promise<Response> {
		return json(taskListPayload(await this.getAllTasks()));
	}

	private async handleCreateTask(request: Request): Promise<Response> {
		const { title, description } = await request.json<{
			title: string;
			description?: string;
		}>();
		if (!title) return json({ error: "title required" }, 400);
		const existing = await this.getAllTasks();
		if (existing.length >= MAX_TASKS)
			return json({ error: `Task limit reached (${MAX_TASKS}). Delete or complete some first.` }, 409);
		const task: AgentTask = {
			id: crypto.randomUUID(),
			title,
			description: description || "",
			status: "pending",
			// Only an owner-authenticated route reaches this handler — the agent's own
			// `create_task` writes DO storage directly and never speaks HTTP (#337).
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
		const updated: AgentTask = {
			...existing,
			...updates,
			id: existing.id,
			createdAt: existing.createdAt,
			// An owner who edits a task has taken it on — same rule memory uses, where an edit
			// through the owner route becomes `source: "user"`. It also means provenance can only
			// ever move agent → owner: nothing on this path can launder a self-assigned task back
			// into looking self-assigned once a human has vouched for it, and the agent's own
			// `update_task` never reaches here to move it the other way (#337).
			assignedBy: "user",
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(`task:${id}`, updated);
		return json(updated);
	}

	private async handleDeleteTask(id: string): Promise<Response> {
		// Report the truth: an owner deleting a task the agent will keep re-reading needs to
		// know whether it is actually gone, and a blanket `success` on a missing key is how a
		// stale prompt entry survives a delete that appeared to work (#337).
		const existed = await this.ctx.storage.delete(`task:${id}`);
		if (!existed) return json({ error: "Task not found" }, 404);
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

		// Auto-create declared collections.
		//
		// The blanket `catch {}` here was covering ONE benign case — `collectionCreate` throws
		// "already exists", which is just a re-init — and hiding every other one with it: an
		// invalid name, or hitting MAX_COLLECTIONS. Those returned `{success:true}` for an agent
		// whose declared schema had silently been dropped, so `insert_record`/`query_records` then
		// 404'd at runtime with nothing anywhere explaining why. Idempotency stays; real failures
		// are reported to the caller and recorded.
		const collectionErrors: Record<string, string> = {};
		if (config.collections) {
			const engine = await this.getStorageEngine(config.agentId);
			for (const [name, schema] of Object.entries(config.collections)) {
				try {
					await engine.collectionCreate(name, schema.fields);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (/already exists/i.test(msg)) continue; // re-init: the collection is already there
					collectionErrors[name] = msg;
				}
			}
		}
		if (Object.keys(collectionErrors).length) {
			await logError(this.env, {
				source: "agent-init",
				message: `agent ${config.agentId} initialized without ${Object.keys(collectionErrors).length} declared collection(s): ${Object.entries(collectionErrors)
					.map(([n, m]) => `${n}: ${m}`)
					.join("; ")}`,
				context: { agentId: config.agentId, collections: Object.keys(collectionErrors) },
			}).catch(() => undefined);
			return json({ success: true, collectionErrors }, 201);
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

		const engine = await this.getStorageEngine(state.agentId);
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
		// "Is it still working?" is answered here, and it has to be answered honestly (#252):
		// `state.status` is only trustworthy while the object is warm (ensureStateDefaults resets
		// a stale `thinking` on reload), so the live turn markers are the real answer. Reading
		// also REAPS — a client coming back to the page is exactly when an interrupted turn
		// should stop being invisible, and it must not have to send another message to find out.
		const inflight = await this.reapAbandonedTurns().catch(() => [] as InflightTurn[]);
		const { systemPrompt: _, ...public_ } = state;
		return json({ ...public_, inflight });
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
		const engine = await this.getStorageEngine(state.agentId);
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
		const engine = state ? await this.getStorageEngine(state.agentId) : null;
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
			const engine = await this.getStorageEngine(state.agentId);
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
}
