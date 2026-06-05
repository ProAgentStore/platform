import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

export const runRoutes = new Hono<{ Bindings: Env }>();

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  model: string;
  status: string;
  visibility: string;
}

/** Execute an agent — runs Workers AI with the agent's config. */
runRoutes.post('/:id/run', async (c) => {
  const session = await requireUser(c);
  const id = c.req.param('id');

  const agent = await c.env.DB.prepare(
    `SELECT id, slug, name, model, status, visibility FROM agents WHERE (id = ?1 OR slug = ?1)`,
  ).bind(id).first<AgentRow>();

  if (!agent) throw new HttpError(404, 'Agent not found');
  if (agent.visibility !== 'published' && agent.status !== 'active') {
    throw new HttpError(400, 'Agent is not active');
  }

  // TODO: check subscription status for non-owners
  const body = await c.req.json<{ input: Record<string, unknown> }>();
  if (!body.input) throw new HttpError(400, 'input required');

  const model = agent.model || '@cf/meta/llama-3.1-8b-instruct';
  const startMs = Date.now();

  const result = await c.env.AI.run(model as Parameters<Ai['run']>[0], body.input);

  const durationMs = Date.now() - startMs;

  // Log execution
  const execId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO agent_executions (id, agent_id, user_id, model, input_tokens, output_tokens, duration_ms, created_at)
     VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, datetime('now'))`,
  ).bind(execId, agent.id, session.uid, model, durationMs).run();

  // Track usage for creator payouts
  await c.env.DB.prepare(
    `INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'execution', ?4, datetime('now'))`,
  ).bind(crypto.randomUUID(), agent.id, session.uid, JSON.stringify({ model, durationMs })).run();

  return c.json({ result, executionId: execId, durationMs });
});

/** Get execution history for an agent. */
runRoutes.get('/:id/executions', async (c) => {
  const session = await requireUser(c);
  const id = c.req.param('id');
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);

  const { results } = await c.env.DB.prepare(
    `SELECT id, model, input_tokens, output_tokens, duration_ms, created_at
     FROM agent_executions WHERE agent_id = ?1 AND user_id = ?2
     ORDER BY created_at DESC LIMIT ?3`,
  ).bind(id, session.uid, limit).all();

  return c.json({ executions: results });
});
