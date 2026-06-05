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

export interface AgentState {
  agentId: string;
  name: string;
  personality: string;
  goal: string;
  model: string;
  status: 'idle' | 'thinking' | 'error';
  systemPrompt: string;
}

const DEFAULT_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const MAX_CONTEXT_MESSAGES = 50;
const DEPRECATED_MODELS = new Set([
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.1-70b-instruct',
  '@cf/mistral/mistral-7b-instruct-v0.2',
  '@cf/qwen/qwen1.5-14b-chat-awq',
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
  }): Promise<void> {
    const state: AgentState = {
      agentId: config.agentId,
      name: config.name,
      personality: config.personality || '',
      goal: config.goal || '',
      model: config.model || DEFAULT_MODEL,
      status: 'idle',
      systemPrompt: this.buildSystemPrompt(config.name, config.personality, config.goal),
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
    const { message, channel, userId } = await request.json<{
      message: string;
      channel?: string;
      userId?: string;
    }>();
    if (!message) return json({ error: 'message required' }, 400);

    const state = await this.getState();
    if (!state) return json({ error: 'Agent not initialized' }, 400);

    // Auto-heal deprecated models
    if (!state.model || DEPRECATED_MODELS.has(state.model)) {
      state.model = DEFAULT_MODEL;
      await this.ctx.storage.put('state', state);
    }

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

    // Build system prompt with memory + tasks context
    let systemPrompt = state.systemPrompt;
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

    systemPrompt += '\n\nYou have tools available. Use them to manage your memory, tasks, fetch data, and store files. Call tools when the user asks you to remember something, work on a task, or fetch external data.';

    // Build tool definitions for Workers AI function calling
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

    const aiMessages: { role: string; content: string }[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    // Tool-use loop: call AI, execute tools, feed results back, repeat
    const MAX_TOOL_ROUNDS = 5;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await this.env.AI.run(
        state.model as Parameters<Ai['run']>[0],
        { messages: aiMessages, tools },
      ) as { response?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> };

      // No tool calls — return the text response
      if (!result.tool_calls || result.tool_calls.length === 0) {
        return result.response || '';
      }

      // Execute each tool call
      const toolResults: string[] = [];
      for (const tc of result.tool_calls) {
        const callReq: ToolCallRequest = { name: tc.name, input: tc.arguments };
        const toolResult = await executeTool(callReq, this.ctx.storage, this.env.STORAGE, state.agentId);
        toolResults.push(`[${tc.name}]: ${toolResult.content}`);
        this.broadcast({ type: 'tool_call', tool: tc.name, result: toolResult });
      }

      // Feed tool results back into the conversation
      aiMessages.push({ role: 'assistant', content: `I called tools:\n${toolResults.join('\n')}` });
      aiMessages.push({ role: 'user', content: 'Continue based on the tool results above.' });
    }

    // Exhausted tool rounds — get final response
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
    const { systemPrompt: _, ...public_ } = state;
    return json(public_);
  }

  private async handleUpdateState(request: Request): Promise<Response> {
    const state = await this.getState();
    if (!state) return json({ error: 'Not initialized' }, 404);
    const updates = await request.json<Partial<AgentState>>();

    if (updates.name !== undefined) state.name = updates.name;
    if (updates.personality !== undefined) state.personality = updates.personality;
    if (updates.goal !== undefined) state.goal = updates.goal;
    if (updates.model !== undefined) state.model = updates.model;
    state.systemPrompt = this.buildSystemPrompt(state.name, state.personality, state.goal);
    await this.ctx.storage.put('state', state);
    return json({ success: true });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildSystemPrompt(name: string, personality?: string, goal?: string): string {
    let prompt = `You are ${name}, a server-powered AI agent on ProAgentStore.`;
    if (personality) prompt += `\n\nPersonality: ${personality}`;
    if (goal) prompt += `\n\nGoal: ${goal}`;
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
