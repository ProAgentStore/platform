import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, requireCreator, HttpError } from '../lib/auth.js';

export const agentRoutes = new Hono<{ Bindings: Env }>();

interface AgentRow {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  icon_bg: string;
  model: string;
  visibility: string;
  status: string;
  worker_name: string | null;
  cron_schedule: string | null;
  created_at: string;
  updated_at: string;
}

/** List agents owned by the current user. Must be before /:id to avoid shadowing. */
agentRoutes.get('/my/agents', async (c) => {
  const session = await requireUser(c);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM agents WHERE owner_id = ?1 ORDER BY updated_at DESC`,
  ).bind(session.uid).all<AgentRow>();
  return c.json({ agents: results });
});

/** List all published agents (public). */
agentRoutes.get('/', async (c) => {
  const category = c.req.query('category');
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);

  let sql = `SELECT id, slug, name, description, category, icon, icon_bg, model, status
             FROM agents WHERE visibility = 'published'`;
  const params: unknown[] = [];

  if (category) {
    sql += ` AND category = ?${params.length + 1}`;
    params.push(category);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
  params.push(limit);

  const stmt = c.env.DB.prepare(sql);
  const { results } = await stmt.bind(...params).all<AgentRow>();
  return c.json({ agents: results });
});

/** Get single agent (public if published). */
agentRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT * FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
  ).bind(id).first<AgentRow>();
  if (!row) return c.json({ error: 'Agent not found' }, 404);
  return c.json(row);
});

/** Create agent (requires creator role). */
agentRoutes.post('/', async (c) => {
  const session = await requireCreator(c);
  const body = await c.req.json<{
    slug: string;
    name: string;
    description?: string;
    category?: string;
    icon?: string;
    icon_bg?: string;
    model?: string;
    personality?: string;
    goal?: string;
  }>();

  if (!body.slug || !body.name) {
    throw new HttpError(400, 'slug and name required');
  }
  if (!/^[a-z0-9-]+$/.test(body.slug)) {
    throw new HttpError(400, 'slug must be lowercase alphanumeric with hyphens');
  }

  // Check slug uniqueness
  const existing = await c.env.DB.prepare('SELECT id FROM agents WHERE slug = ?1').bind(body.slug).first();
  if (existing) throw new HttpError(409, 'Agent slug already taken');

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO agents (id, owner_id, slug, name, description, category, icon, icon_bg, model, visibility, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', 'inactive', datetime('now'), datetime('now'))`,
  ).bind(
    id, session.uid, body.slug, body.name,
    body.description || '', body.category || 'general',
    body.icon || '', body.icon_bg || '#7c3aed',
    body.model || '',
  ).run();

  // Initialize the agent's Durable Object with personality, goal, memory
  const doId = c.env.AGENT.idFromName(id);
  const stub = c.env.AGENT.get(doId);
  await stub.fetch(new Request('http://agent/init', {
    method: 'POST',
    body: JSON.stringify({ agentId: id, name: body.name, personality: body.personality, goal: body.goal, model: body.model }),
  }));

  return c.json({ id, slug: body.slug }, 201);
});

/** Update agent (owner only). */
agentRoutes.put('/:id', async (c) => {
  const session = await requireUser(c);
  const id = c.req.param('id');

  const row = await c.env.DB.prepare('SELECT owner_id FROM agents WHERE id = ?1').bind(id).first<AgentRow>();
  if (!row) throw new HttpError(404, 'Agent not found');
  if (row.owner_id !== session.uid && !session.roles.includes('admin')) {
    throw new HttpError(403, 'Not your agent');
  }

  const body = await c.req.json<Record<string, unknown>>();
  const allowed = ['name', 'description', 'category', 'icon', 'icon_bg', 'model', 'visibility', 'cron_schedule'];
  const sets: string[] = ['updated_at = datetime(\'now\')'];
  const params: unknown[] = [];

  for (const key of allowed) {
    if (body[key] !== undefined) {
      params.push(body[key]);
      sets.push(`${key} = ?${params.length + 1}`);
    }
  }

  if (sets.length === 1) throw new HttpError(400, 'Nothing to update');

  params.unshift(id); // ?1
  await c.env.DB.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?1`).bind(...params).run();
  return c.json({ success: true });
});

/** Delete agent (owner only). */
agentRoutes.delete('/:id', async (c) => {
  const session = await requireUser(c);
  const id = c.req.param('id');

  const row = await c.env.DB.prepare('SELECT owner_id FROM agents WHERE id = ?1').bind(id).first<AgentRow>();
  if (!row) throw new HttpError(404, 'Agent not found');
  if (row.owner_id !== session.uid && !session.roles.includes('admin')) {
    throw new HttpError(403, 'Not your agent');
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM agent_executions WHERE agent_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM usage WHERE agent_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM agents WHERE id = ?1').bind(id),
  ]);
  return c.json({ success: true });
});

