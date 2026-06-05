import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

export const chatRoutes = new Hono<{ Bindings: Env }>();

/** Send a message to an agent (HTTP). */
chatRoutes.post('/:id/chat', async (c) => {
  const session = await requireUser(c);
  const id = c.req.param('id');
  const { message } = await c.req.json<{ message: string }>();
  if (!message) throw new HttpError(400, 'message required');

  // Verify agent exists in D1
  const agent = await c.env.DB.prepare(
    'SELECT id FROM agents WHERE (id = ?1 OR slug = ?1)',
  ).bind(id).first<{ id: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found');

  // Forward to the agent's Durable Object
  const doId = c.env.AGENT.idFromName(agent.id);
  const stub = c.env.AGENT.get(doId);

  const doRes = await stub.fetch(new Request('http://agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, channel: 'chat', userId: session.uid }),
  }));

  // Track usage
  await c.env.DB.prepare(
    `INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'chat', '{}', datetime('now'))`,
  ).bind(crypto.randomUUID(), agent.id, session.uid).run();

  const data = await doRes.json();
  return c.json(data, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
});

/** WebSocket upgrade for real-time chat. */
chatRoutes.get('/:id/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    throw new HttpError(426, 'Expected WebSocket upgrade');
  }

  const id = c.req.param('id');
  const agent = await c.env.DB.prepare(
    'SELECT id FROM agents WHERE (id = ?1 OR slug = ?1)',
  ).bind(id).first<{ id: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found');

  const doId = c.env.AGENT.idFromName(agent.id);
  const stub = c.env.AGENT.get(doId);

  // Forward the WebSocket upgrade to the DO
  return stub.fetch(c.req.raw);
});

/** Get message history. */
chatRoutes.get('/:id/messages', async (c) => {
  await requireUser(c);
  const id = c.req.param('id');

  const agent = await c.env.DB.prepare(
    'SELECT id FROM agents WHERE (id = ?1 OR slug = ?1)',
  ).bind(id).first<{ id: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found');

  const doId = c.env.AGENT.idFromName(agent.id);
  const stub = c.env.AGENT.get(doId);

  const limit = c.req.query('limit') || '50';
  const doRes = await stub.fetch(new Request(`http://agent/messages?limit=${limit}`));
  const data = await doRes.json();
  return c.json(data);
});

/** Get/set agent memory. */
chatRoutes.get('/:id/memory', async (c) => {
  await requireUser(c);
  const id = c.req.param('id');
  const agent = await c.env.DB.prepare('SELECT id FROM agents WHERE (id = ?1 OR slug = ?1)').bind(id).first<{ id: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found');

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
  const doRes = await stub.fetch(new Request('http://agent/memory'));
  return c.json(await doRes.json());
});

chatRoutes.put('/:id/memory', async (c) => {
  await requireUser(c);
  const id = c.req.param('id');
  const agent = await c.env.DB.prepare('SELECT id FROM agents WHERE (id = ?1 OR slug = ?1)').bind(id).first<{ id: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found');

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
  const doRes = await stub.fetch(new Request('http://agent/memory', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return c.json(await doRes.json());
});

/** Tasks CRUD — forwarded to DO. */
chatRoutes.get('/:id/tasks', async (c) => {
  await requireUser(c);
  const id = c.req.param('id');
  const agent = await c.env.DB.prepare('SELECT id FROM agents WHERE (id = ?1 OR slug = ?1)').bind(id).first<{ id: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found');

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
  const doRes = await stub.fetch(new Request('http://agent/tasks'));
  return c.json(await doRes.json());
});

chatRoutes.post('/:id/tasks', async (c) => {
  await requireUser(c);
  const id = c.req.param('id');
  const agent = await c.env.DB.prepare('SELECT id FROM agents WHERE (id = ?1 OR slug = ?1)').bind(id).first<{ id: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found');

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
  const doRes = await stub.fetch(new Request('http://agent/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return c.json(await doRes.json(), doRes.status as 201);
});
