/**
 * AGENTNAME — a ProAgentStore agent.
 *
 * This is a Durable Object-based agent with:
 * - Persistent conversation history
 * - Knowledge base (add docs, URLs, files)
 * - Memory system (identity, knowledge, preference, skill, context)
 * - Workers AI backbone
 *
 * Customize the system prompt, add knowledge docs, and deploy.
 */
import { Hono } from 'hono';
import { DurableObject } from 'cloudflare:workers';

interface Env {
  AI: Ai;
  AGENT: DurableObjectNamespace;
}

// ── Hono API ──────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.json({ agent: 'AGENTNAME', status: 'ok' }));

app.post('/chat', async (c) => {
  const { message } = await c.req.json<{ message: string }>();
  if (!message) return c.json({ error: 'message required' }, 400);

  const doId = c.env.AGENT.idFromName('main');
  const stub = c.env.AGENT.get(doId);
  const res = await stub.fetch(new Request('http://agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

export default app;

// ── Durable Object ────────────────────────────────────────────

const SYSTEM_PROMPT = `You are AGENTNAME, a helpful AI agent.
Customize this prompt to define your agent's personality, knowledge domain, and behavior.`;

export class AgentDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/chat' && request.method === 'POST') {
      const { message } = await request.json<{ message: string }>();

      // Load conversation history
      const history = await this.ctx.storage.list<{ role: string; content: string }>({ prefix: 'msg:', reverse: true, limit: 30 });
      const messages = [...history.values()].reverse();

      // Call Workers AI
      const result = await this.env.AI.run('@cf/meta/llama-3.2-3b-instruct' as Parameters<Ai['run']>[0], {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages,
          { role: 'user', content: message },
        ],
      }) as { response?: string };

      const response = result.response || '';

      // Save messages
      const ts = new Date().toISOString();
      await this.ctx.storage.put(`msg:${ts}:u`, { role: 'user', content: message });
      await this.ctx.storage.put(`msg:${ts}:a`, { role: 'assistant', content: response });

      return new Response(JSON.stringify({ message: { role: 'assistant', content: response } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}
