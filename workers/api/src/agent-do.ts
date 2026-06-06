/**
 * AgentDO — one Durable Object per agent.
 *
 * Holds conversation history, memory, tasks, and runs the agent loop.
 * Inspired by archagent's bridge/agent-loop pattern, rebuilt on CF Durable Objects.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types.js';
import { AGENT_TOOLS, executeTool, type ToolCallRequest } from './lib/tools.js';

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  channel: string;       // 'chat', 'api', 'cron', 'webhook'
  userId?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  createdAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  success: boolean;
}

export interface MemoryEntry {
  key: string;
  type: 'identity' | 'knowledge' | 'preference' | 'skill' | 'context';
  content: string;
  updatedAt: string;
}

export interface AgentTask {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'complete';
  assignedBy: 'user' | 'self' | 'system';
  createdAt: string;
  updatedAt: string;
}

export interface Guardrails {
  topicRestrictions: string;   // "Only answer about cooking, nutrition, and recipes"
  blockedTerms: string[];      // Words/phrases the agent should never use
  responseStyle: string;       // "professional", "casual", "concise", etc.
  maxResponseLength: number;   // 0 = unlimited
  requireCitations: boolean;   // Must cite knowledge sources
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  source: 'upload' | 'url' | 'paste' | 'google-docs' | 'webhook';
  sourceUrl?: string;
  addedAt: string;
}

export interface AgentState {
  agentId: string;
  name: string;
  personality: string;
  goal: string;
  model: string;
  status: 'idle' | 'thinking' | 'error';
  systemPrompt: string;
  guardrails: Guardrails;
  welcomeMessage: string;      // First message shown to users
  isPublished: boolean;
}

const DEFAULT_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const MAX_CONTEXT_MESSAGES = 50;
const DEPRECATED_MODELS = new Set([
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.1-70b-instruct',
  '@cf/mistral/mistral-7b-instruct-v0.2',
  '@cf/qwen/qwen1.5-14b-chat-awq',
]);

/** Models that support structured function calling (tool_calls in response). */
const TOOL_CAPABLE_MODELS = new Set([
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
]);

export class AgentDO extends DurableObject<Env> {

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
      topicRestrictions: config.guardrails?.topicRestrictions || '',
      blockedTerms: config.guardrails?.blockedTerms || [],
      responseStyle: config.guardrails?.responseStyle || '',
      maxResponseLength: config.guardrails?.maxResponseLength || 0,
      requireCitations: config.guardrails?.requireCitations || false,
    };
    const state: AgentState = {
      agentId: config.agentId,
      name: config.name,
      personality: config.personality || '',
      goal: config.goal || '',
      model: config.model || DEFAULT_MODEL,
      status: 'idle',
      systemPrompt: this.buildSystemPrompt(config.name, config.personality, config.goal, guardrails),
      guardrails,
      welcomeMessage: config.welcomeMessage || '',
      isPublished: false,
    };
    await this.ctx.storage.put('state', state);

    // Seed identity memory
    if (config.personality) {
      await this.setMemory('personality', 'identity', config.personality);
    }
    if (config.goal) {
      await this.setMemory('goal', 'identity', config.goal);
    }
  }

  /**
   * Handle HTTP requests to this agent.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade for real-time chat
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket();
    }

    try {
      // Chat (HTTP)
      if (path === '/chat' && request.method === 'POST') return this.handleChat(request);

      // Memory CRUD
      if (path === '/memory' && request.method === 'GET') return this.handleGetMemory();
      if (path === '/memory' && request.method === 'PUT') return this.handleSetMemory(request);
      if (path.startsWith('/memory/') && request.method === 'DELETE') {
        return this.handleDeleteMemory(path.slice('/memory/'.length));
      }

      // Tasks CRUD
      if (path === '/tasks' && request.method === 'GET') return this.handleGetTasks();
      if (path === '/tasks' && request.method === 'POST') return this.handleCreateTask(request);
      if (path.startsWith('/tasks/') && request.method === 'PUT') {
        return this.handleUpdateTask(path.slice('/tasks/'.length), request);
      }
      if (path.startsWith('/tasks/') && request.method === 'DELETE') {
        return this.handleDeleteTask(path.slice('/tasks/'.length));
      }

      // Messages history
      if (path === '/messages' && request.method === 'GET') return this.handleGetMessages(url);

      // Knowledge base
      if (path === '/knowledge' && request.method === 'GET') return this.handleGetKnowledge();
      if (path === '/knowledge' && request.method === 'POST') return this.handleAddKnowledge(request);
      if (path.startsWith('/knowledge/') && request.method === 'DELETE') {
        return this.handleDeleteKnowledge(path.slice('/knowledge/'.length));
      }
      if (path === '/knowledge/ingest-url' && request.method === 'POST') return this.handleIngestUrl(request);

      // State
      if (path === '/init' && request.method === 'POST') return this.handleInit(request);
      if (path === '/state' && request.method === 'GET') return this.handleGetState();
      if (path === '/state' && request.method === 'PUT') return this.handleUpdateState(request);

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('AgentDO error:', message);
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
    if (!message) return json({ error: 'message required' }, 400);

    let state = await this.getState();

    // Auto-initialize if DO has no state (agent created via D1 but DO never init'd)
    if (!state) {
      const url = new URL(request.url);
      const agentId = body.agentId || url.searchParams.get('agentId') || 'unknown';
      const agentName = body.agentName || url.searchParams.get('agentName') || 'Agent';
      await this.init({ agentId, name: agentName });
      state = await this.getState();
      if (!state) return json({ error: 'Failed to initialize agent' }, 500);
    }

    // Auto-heal deprecated models
    if (!state.model || DEPRECATED_MODELS.has(state.model)) {
      state.model = DEFAULT_MODEL;
    }
    // Auto-migrate old state missing new fields
    if (!state.guardrails) {
      state.guardrails = { topicRestrictions: '', blockedTerms: [], responseStyle: '', maxResponseLength: 0, requireCitations: false };
      state.welcomeMessage = state.welcomeMessage || '';
      state.isPublished = state.isPublished || false;
    }
    await this.ctx.storage.put('state', state);

    // Save user message
    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      channel: channel || 'chat',
      userId,
      createdAt: new Date().toISOString(),
    };
    await this.appendMessage(userMsg);
    this.broadcast({ type: 'message', message: userMsg });

    // Run agent loop
    await this.ctx.storage.put('state', { ...state, status: 'thinking' });
    this.broadcast({ type: 'status', status: 'thinking' });

    try {
      const response = await this.think(state);

      const assistantMsg: AgentMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response,
        channel: channel || 'chat',
        createdAt: new Date().toISOString(),
      };
      await this.appendMessage(assistantMsg);

      await this.ctx.storage.put('state', { ...state, status: 'idle' });
      this.broadcast({ type: 'message', message: assistantMsg });
      this.broadcast({ type: 'status', status: 'idle' });

      return json({ message: assistantMsg });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.ctx.storage.put('state', { ...state, status: 'error' });
      this.broadcast({ type: 'status', status: 'error', error: errMsg });

      const errorMsg: AgentMessage = {
        id: crypto.randomUUID(),
        role: 'system',
        content: `Error: ${errMsg}`,
        channel: channel || 'chat',
        createdAt: new Date().toISOString(),
      };
      await this.appendMessage(errorMsg);
      this.broadcast({ type: 'message', message: errorMsg });

      return json({ error: errMsg }, 500);
    }
  }

  /**
   * The agent loop — build context, call Workers AI, return response.
   * This is where archagent's agent-loop.ts concept lives.
   */
  private async think(state: AgentState): Promise<string> {
    const messages = await this.getRecentMessages(MAX_CONTEXT_MESSAGES);
    const memory = await this.getAllMemory();
    const tasks = await this.getAllTasks();
    const knowledge = await this.getAllKnowledge();

    // Build system prompt with knowledge + memory + tasks context
    let systemPrompt = state.systemPrompt;

    // Inject knowledge base — the core of what makes this agent useful
    if (knowledge.length > 0) {
      systemPrompt += '\n\n## Knowledge Base\nAnswer questions using the following documents. Cite the document title when referencing information.\n';
      let totalLen = 0;
      const MAX_KB_CHARS = 30_000; // Keep context manageable
      for (const doc of knowledge) {
        if (totalLen + doc.content.length > MAX_KB_CHARS) {
          systemPrompt += `\n### ${doc.title}\n${doc.content.slice(0, MAX_KB_CHARS - totalLen)}...[truncated]\n`;
          break;
        }
        systemPrompt += `\n### ${doc.title}\n${doc.content}\n`;
        totalLen += doc.content.length;
      }
    }

    if (memory.length > 0) {
      systemPrompt += '\n\n## Your Memory\n';
      for (const m of memory) {
        systemPrompt += `- [${m.type}] ${m.key}: ${m.content}\n`;
      }
    }
    if (tasks.length > 0) {
      const active = tasks.filter(t => t.status !== 'complete');
      if (active.length > 0) {
        systemPrompt += '\n\n## Active Tasks\n';
        for (const t of active) {
          systemPrompt += `- [${t.status}] ${t.title}: ${t.description}\n`;
        }
      }
    }

    const useTools = TOOL_CAPABLE_MODELS.has(state.model);

    if (useTools) {
      systemPrompt += '\n\nYou have tools available. Use them to manage your memory, tasks, fetch data, and store files. Call tools when the user asks you to remember something, work on a task, or fetch external data.';
    }

    const aiMessages: { role: string; content: string }[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    // Simple path: no tool support — just call the model and return
    if (!useTools) {
      const result = await this.env.AI.run(
        state.model as Parameters<Ai['run']>[0],
        { messages: aiMessages },
      ) as { response?: string };
      return result.response || '';
    }

    // Tool-capable model: build tool definitions and run the tool-use loop
    const tools = AGENT_TOOLS.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }]),
          ),
          required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k),
        },
      },
    }));

    const MAX_TOOL_ROUNDS = 5;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await this.env.AI.run(
        state.model as Parameters<Ai['run']>[0],
        { messages: aiMessages, tools },
      ) as { response?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> };

      if (!result.tool_calls || result.tool_calls.length === 0) {
        return result.response || '';
      }

      const toolResults: string[] = [];
      for (const tc of result.tool_calls) {
        const callReq: ToolCallRequest = { name: tc.name, input: tc.arguments };
        const toolResult = await executeTool(callReq, this.ctx.storage, this.env.STORAGE, state.agentId);
        toolResults.push(`[${tc.name}]: ${toolResult.content}`);
        this.broadcast({ type: 'tool_call', tool: tc.name, result: toolResult });
      }

      aiMessages.push({ role: 'assistant', content: `I called tools:\n${toolResults.join('\n')}` });
      aiMessages.push({ role: 'user', content: 'Continue based on the tool results above.' });
    }

    const final = await this.env.AI.run(
      state.model as Parameters<Ai['run']>[0],
      { messages: aiMessages },
    ) as { response?: string };
    return final.response || '';
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

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'chat' && parsed.message) {
        // Handle chat via WebSocket — reuse the same logic
        const request = new Request('http://internal/chat', {
          method: 'POST',
          body: JSON.stringify({ message: parsed.message, channel: 'chat', userId: parsed.userId }),
        });
        await this.handleChat(request);
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid message' }));
    }
  }

  private broadcast(data: Record<string, unknown>): void {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch { /* closed socket, runtime will clean up */ }
    }
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  private async appendMessage(msg: AgentMessage): Promise<void> {
    const key = `msg:${msg.createdAt}:${msg.id}`;
    await this.ctx.storage.put(key, msg);
  }

  private async getRecentMessages(limit: number): Promise<AgentMessage[]> {
    const all = await this.ctx.storage.list<AgentMessage>({ prefix: 'msg:', reverse: true, limit });
    const messages = [...all.values()].reverse();
    return messages;
  }

  private async handleGetMessages(url: URL): Promise<Response> {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const messages = await this.getRecentMessages(limit);
    return json({ messages });
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  private async setMemory(key: string, type: string, content: string): Promise<void> {
    const entry: MemoryEntry = { key, type: type as MemoryEntry['type'], content, updatedAt: new Date().toISOString() };
    await this.ctx.storage.put(`mem:${key}`, entry);
  }

  private async getAllMemory(): Promise<MemoryEntry[]> {
    const all = await this.ctx.storage.list<MemoryEntry>({ prefix: 'mem:' });
    return [...all.values()];
  }

  private async handleGetMemory(): Promise<Response> {
    return json({ memory: await this.getAllMemory() });
  }

  private async handleSetMemory(request: Request): Promise<Response> {
    const { key, type, content } = await request.json<{ key: string; type: string; content: string }>();
    if (!key || !type || content === undefined) return json({ error: 'key, type, content required' }, 400);
    await this.setMemory(key, type, content);
    return json({ success: true });
  }

  private async handleDeleteMemory(key: string): Promise<Response> {
    await this.ctx.storage.delete(`mem:${decodeURIComponent(key)}`);
    return json({ success: true });
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  private async getAllTasks(): Promise<AgentTask[]> {
    const all = await this.ctx.storage.list<AgentTask>({ prefix: 'task:' });
    return [...all.values()];
  }

  private async handleGetTasks(): Promise<Response> {
    return json({ tasks: await this.getAllTasks() });
  }

  private async handleCreateTask(request: Request): Promise<Response> {
    const { title, description } = await request.json<{ title: string; description?: string }>();
    if (!title) return json({ error: 'title required' }, 400);
    const task: AgentTask = {
      id: crypto.randomUUID(),
      title,
      description: description || '',
      status: 'pending',
      assignedBy: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(`task:${task.id}`, task);
    return json(task, 201);
  }

  private async handleUpdateTask(id: string, request: Request): Promise<Response> {
    const existing = await this.ctx.storage.get<AgentTask>(`task:${id}`);
    if (!existing) return json({ error: 'Task not found' }, 404);
    const updates = await request.json<Partial<AgentTask>>();
    const updated = { ...existing, ...updates, id: existing.id, updatedAt: new Date().toISOString() };
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
    }>();
    if (!config.agentId || !config.name) return json({ error: 'agentId and name required' }, 400);
    await this.init(config);
    return json({ success: true }, 201);
  }

  private async getState(): Promise<AgentState | null> {
    return (await this.ctx.storage.get<AgentState>('state')) ?? null;
  }

  private async handleGetState(): Promise<Response> {
    const state = await this.getState();
    if (!state) return json({ error: 'Not initialized' }, 404);
    // Auto-migrate old state missing new fields
    if (!state.guardrails) {
      state.guardrails = { topicRestrictions: '', blockedTerms: [], responseStyle: '', maxResponseLength: 0, requireCitations: false };
      state.welcomeMessage = state.welcomeMessage || '';
      state.isPublished = state.isPublished || false;
      await this.ctx.storage.put('state', state);
    }
    const { systemPrompt: _, ...public_ } = state;
    return json(public_);
  }

  private async handleUpdateState(request: Request): Promise<Response> {
    const state = await this.getState();
    if (!state) return json({ error: 'Not initialized' }, 404);
    const updates = await request.json<Partial<AgentState> & { guardrails?: Partial<Guardrails> }>();

    if (updates.name !== undefined) state.name = updates.name;
    if (updates.personality !== undefined) state.personality = updates.personality;
    if (updates.goal !== undefined) state.goal = updates.goal;
    if (updates.model !== undefined) state.model = updates.model;
    if (updates.welcomeMessage !== undefined) state.welcomeMessage = updates.welcomeMessage;
    if (updates.isPublished !== undefined) state.isPublished = updates.isPublished;
    if (updates.guardrails) {
      state.guardrails = { ...state.guardrails, ...updates.guardrails };
    }
    state.systemPrompt = this.buildSystemPrompt(state.name, state.personality, state.goal, state.guardrails);
    await this.ctx.storage.put('state', state);
    return json({ success: true });
  }

  // ── Knowledge Base ─────────────────────────────────────────────────────────

  private async getAllKnowledge(): Promise<KnowledgeDoc[]> {
    const all = await this.ctx.storage.list<KnowledgeDoc>({ prefix: 'kb:' });
    return [...all.values()];
  }

  private async handleGetKnowledge(): Promise<Response> {
    return json({ documents: await this.getAllKnowledge() });
  }

  private async handleAddKnowledge(request: Request): Promise<Response> {
    const body = await request.json<{
      title: string;
      content: string;
      source?: KnowledgeDoc['source'];
      sourceUrl?: string;
    }>();
    if (!body.title || !body.content) return json({ error: 'title and content required' }, 400);

    const doc: KnowledgeDoc = {
      id: crypto.randomUUID(),
      title: body.title,
      content: body.content,
      source: body.source || 'paste',
      sourceUrl: body.sourceUrl,
      addedAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(`kb:${doc.id}`, doc);
    return json(doc, 201);
  }

  private async handleDeleteKnowledge(id: string): Promise<Response> {
    await this.ctx.storage.delete(`kb:${decodeURIComponent(id)}`);
    return json({ success: true });
  }

  private async handleIngestUrl(request: Request): Promise<Response> {
    const { url, title } = await request.json<{ url: string; title?: string }>();
    if (!url) return json({ error: 'url required' }, 400);

    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ProAgentStore-Ingest' } });
      if (!res.ok) return json({ error: `Failed to fetch: ${res.status}` }, 400);

      const contentType = res.headers.get('content-type') || '';
      let text = await res.text();

      // Strip HTML tags for web pages
      if (contentType.includes('html')) {
        text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                   .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ')
                   .trim();
      }

      // Truncate to 50KB per doc
      if (text.length > 50_000) text = text.slice(0, 50_000) + '\n...[truncated]';

      const doc: KnowledgeDoc = {
        id: crypto.randomUUID(),
        title: title || new URL(url).hostname,
        content: text,
        source: 'url',
        sourceUrl: url,
        addedAt: new Date().toISOString(),
      };
      await this.ctx.storage.put(`kb:${doc.id}`, doc);
      return json(doc, 201);
    } catch (err) {
      return json({ error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildSystemPrompt(name: string, personality?: string, goal?: string, guardrails?: Guardrails): string {
    let prompt = `You are ${name}, a server-powered AI agent on ProAgentStore.`;
    if (personality) prompt += `\n\nPersonality: ${personality}`;
    if (goal) prompt += `\n\nGoal: ${goal}`;

    if (guardrails) {
      if (guardrails.topicRestrictions) {
        prompt += `\n\nTopic restrictions: ${guardrails.topicRestrictions}. If the user asks about anything outside this scope, politely decline and redirect to your area of expertise.`;
      }
      if (guardrails.blockedTerms.length > 0) {
        prompt += `\n\nNever use these words or phrases: ${guardrails.blockedTerms.join(', ')}`;
      }
      if (guardrails.responseStyle) {
        prompt += `\n\nResponse style: ${guardrails.responseStyle}`;
      }
      if (guardrails.maxResponseLength > 0) {
        prompt += `\n\nKeep responses under ${guardrails.maxResponseLength} characters.`;
      }
      if (guardrails.requireCitations) {
        prompt += '\n\nAlways cite which knowledge base document you are drawing from when answering.';
      }
    }

    prompt += '\n\nYou have persistent memory and tasks. Be helpful, concise, and proactive about completing your tasks.';
    return prompt;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
