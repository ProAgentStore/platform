import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

export const instanceRoutes = new Hono<{ Bindings: Env }>();

interface InstanceRow {
  id: string;
  agent_id: string;
  user_id: string;
  status: string;
  config: string;
  created_at: string;
  updated_at: string;
}

/** Subscribe to an agent — creates a personal instance with its own DO. */
instanceRoutes.post('/:agentId/subscribe', async (c) => {
  const session = await requireUser(c);
  const agentId = c.req.param('agentId');

  // Verify agent exists and is published
  const agent = await c.env.DB.prepare(
    `SELECT id, name, model, visibility FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
  ).bind(agentId).first<{ id: string; name: string; model: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found or not published');

  // Check if already subscribed
  const existing = await c.env.DB.prepare(
    'SELECT id FROM agent_instances WHERE agent_id = ?1 AND user_id = ?2',
  ).bind(agent.id, session.uid).first();
  if (existing) throw new HttpError(409, 'Already subscribed to this agent');

  const instanceId = crypto.randomUUID();

  // Create instance row
  await c.env.DB.prepare(
    `INSERT INTO agent_instances (id, agent_id, user_id, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'active', datetime('now'), datetime('now'))`,
  ).bind(instanceId, agent.id, session.uid).run();

  // Create subscription row
  await c.env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, agent_id, status, started_at)
     VALUES (?1, ?2, ?3, 'active', datetime('now'))`,
  ).bind(crypto.randomUUID(), session.uid, agent.id).run();

  // Initialize the instance's DO — copy template state from the agent's DO
  const templateDoId = c.env.AGENT.idFromName(agent.id);
  const templateStub = c.env.AGENT.get(templateDoId);
  const stateRes = await templateStub.fetch(new Request('http://agent/state'));
  const templateState = await stateRes.json() as Record<string, unknown>;

  // Initialize instance DO with template config
  const instanceDoId = c.env.AGENT.idFromName(instanceId);
  const instanceStub = c.env.AGENT.get(instanceDoId);
  await instanceStub.fetch(new Request('http://agent/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: instanceId,
      name: templateState.name || agent.name,
      personality: templateState.personality || '',
      goal: templateState.goal || '',
      model: templateState.model || agent.model,
      guardrails: templateState.guardrails || {},
      welcomeMessage: templateState.welcomeMessage || '',
    }),
  }));

  // Copy knowledge base from template to instance
  const kbRes = await templateStub.fetch(new Request('http://agent/knowledge'));
  const kbData = await kbRes.json() as { documents?: Array<{ title: string; content: string; source: string; sourceUrl?: string }> };
  if (kbData.documents?.length) {
    for (const doc of kbData.documents) {
      await instanceStub.fetch(new Request('http://agent/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      }));
    }
  }

  return c.json({ instanceId, agentId: agent.id, status: 'active' }, 201);
});

/** List my subscribed instances. */
instanceRoutes.get('/my/instances', async (c) => {
  const session = await requireUser(c);
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.agent_id, i.status, i.created_at,
            a.name, a.slug, a.description, a.category, a.icon, a.icon_bg
     FROM agent_instances i
     JOIN agents a ON a.id = i.agent_id
     WHERE i.user_id = ?1
     ORDER BY i.updated_at DESC`,
  ).bind(session.uid).all();
  return c.json({ instances: results });
});

/** Chat with my instance of an agent. */
instanceRoutes.post('/:instanceId/chat', async (c) => {
  const session = await requireUser(c);
  const instanceId = c.req.param('instanceId');
  const { message } = await c.req.json<{ message: string }>();
  if (!message) throw new HttpError(400, 'message required');

  // Verify ownership
  const instance = await c.env.DB.prepare(
    'SELECT id, agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2',
  ).bind(instanceId, session.uid).first<InstanceRow>();
  if (!instance) throw new HttpError(404, 'Instance not found');

  const doId = c.env.AGENT.idFromName(instanceId);
  const stub = c.env.AGENT.get(doId);
  const doRes = await stub.fetch(new Request('http://agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, channel: 'chat', userId: session.uid }),
  }));

  // Track usage
  await c.env.DB.prepare(
    `INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'instance_chat', ?4, datetime('now'))`,
  ).bind(crypto.randomUUID(), instance.agent_id, session.uid, JSON.stringify({ instanceId })).run();

  const data = await doRes.json();
  return c.json(data, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
});

/** Get messages for my instance. */
instanceRoutes.get('/:instanceId/messages', async (c) => {
  const session = await requireUser(c);
  const instanceId = c.req.param('instanceId');

  const instance = await c.env.DB.prepare(
    'SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2',
  ).bind(instanceId, session.uid).first();
  if (!instance) throw new HttpError(404, 'Instance not found');

  const limit = c.req.query('limit') || '50';
  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
  const doRes = await stub.fetch(new Request(`http://agent/messages?limit=${limit}`));
  return c.json(await doRes.json());
});

/** Add knowledge to my instance (client's own docs). */
instanceRoutes.post('/:instanceId/knowledge', async (c) => {
  const session = await requireUser(c);
  const instanceId = c.req.param('instanceId');

  const instance = await c.env.DB.prepare(
    'SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2',
  ).bind(instanceId, session.uid).first();
  if (!instance) throw new HttpError(404, 'Instance not found');

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
  const doRes = await stub.fetch(new Request('http://agent/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return c.json(await doRes.json(), doRes.status as 201);
});

/** Import URL into my instance's knowledge base. */
instanceRoutes.post('/:instanceId/knowledge/ingest-url', async (c) => {
  const session = await requireUser(c);
  const instanceId = c.req.param('instanceId');

  const instance = await c.env.DB.prepare(
    'SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2',
  ).bind(instanceId, session.uid).first();
  if (!instance) throw new HttpError(404, 'Instance not found');

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
  const doRes = await stub.fetch(new Request('http://agent/knowledge/ingest-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return c.json(await doRes.json(), (doRes.ok ? 201 : doRes.status) as ContentfulStatusCode);
});

/** Get my instance's knowledge base. */
instanceRoutes.get('/:instanceId/knowledge', async (c) => {
  const session = await requireUser(c);
  const instanceId = c.req.param('instanceId');

  const instance = await c.env.DB.prepare(
    'SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2',
  ).bind(instanceId, session.uid).first();
  if (!instance) throw new HttpError(404, 'Instance not found');

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
  const doRes = await stub.fetch(new Request('http://agent/knowledge'));
  return c.json(await doRes.json());
});

/** Cancel subscription / deactivate instance. */
instanceRoutes.post('/:instanceId/cancel', async (c) => {
  const session = await requireUser(c);
  const instanceId = c.req.param('instanceId');

  const instance = await c.env.DB.prepare(
    'SELECT id, agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2',
  ).bind(instanceId, session.uid).first<InstanceRow>();
  if (!instance) throw new HttpError(404, 'Instance not found');

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE agent_instances SET status = 'canceled', updated_at = datetime('now') WHERE id = ?1`,
    ).bind(instanceId),
    c.env.DB.prepare(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = datetime('now')
       WHERE agent_id = ?1 AND user_id = ?2 AND status = 'active'`,
    ).bind(instance.agent_id, session.uid),
  ]);

  return c.json({ success: true });
});
