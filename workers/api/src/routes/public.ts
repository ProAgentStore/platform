/**
 * Public routes — no auth required.
 * Agent detail, public chat (trial), webhook ingestion.
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { HttpError } from '../lib/auth.js';

export const publicRoutes = new Hono<{ Bindings: Env }>();

/** Public agent detail — full info for the store detail page. */
publicRoutes.get('/agents/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, slug, name, description, category, icon, icon_bg, model, created_at,
            (SELECT COUNT(*) FROM agent_instances WHERE agent_id = agents.id AND status = 'active') as subscriber_count
     FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
  ).bind(id).first();
  if (!row) throw new HttpError(404, 'Agent not found');
  return c.json(row);
});

/**
 * Public chat — anyone can try a published agent (no auth, no instance).
 * Creates an ephemeral DO keyed by agent+session. Limited to 10 messages.
 */
publicRoutes.post('/agents/:id/try', async (c) => {
  const id = c.req.param('id');
  const { message, sessionId } = await c.req.json<{ message: string; sessionId?: string }>();
  if (!message) throw new HttpError(400, 'message required');

  const agent = await c.env.DB.prepare(
    `SELECT id, model FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
  ).bind(id).first<{ id: string; model: string }>();
  if (!agent) throw new HttpError(404, 'Agent not found');

  // Ephemeral session — keyed by agent + client session (or random)
  const sid = sessionId || crypto.randomUUID();
  const doKey = `trial:${agent.id}:${sid}`;
  const doId = c.env.AGENT.idFromName(doKey);
  const stub = c.env.AGENT.get(doId);

  // Ensure initialized (idempotent — init checks if state exists)
  const stateRes = await stub.fetch(new Request('http://agent/state'));
  if (stateRes.status === 404) {
    // Copy template state
    const templateStub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
    const templateRes = await templateStub.fetch(new Request('http://agent/state'));
    const tmpl = await templateRes.json() as Record<string, unknown>;

    await stub.fetch(new Request('http://agent/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: doKey,
        name: tmpl.name || 'Agent',
        personality: tmpl.personality || '',
        goal: tmpl.goal || '',
        model: tmpl.model || agent.model,
        guardrails: tmpl.guardrails || {},
        welcomeMessage: tmpl.welcomeMessage || '',
      }),
    }));

    // Copy template knowledge base
    const kbRes = await templateStub.fetch(new Request('http://agent/knowledge'));
    const kb = await kbRes.json() as { documents?: Array<Record<string, unknown>> };
    if (kb.documents?.length) {
      for (const doc of kb.documents) {
        await stub.fetch(new Request('http://agent/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc),
        }));
      }
    }
  }

  // Check message limit for trial
  const msgsRes = await stub.fetch(new Request('http://agent/messages?limit=20'));
  const msgs = await msgsRes.json() as { messages?: unknown[] };
  if ((msgs.messages?.length || 0) >= 20) {
    return c.json({ error: 'Trial limit reached. Subscribe to continue chatting.', sessionId: sid }, 429);
  }

  const doRes = await stub.fetch(new Request('http://agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, channel: 'trial' }),
  }));

  const data = await doRes.json() as Record<string, unknown>;
  return c.json({ ...data, sessionId: sid }, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
});

/**
 * Webhook ingestion — POST docs to an instance's knowledge base.
 * Used by Zapier, Zoho, Make, n8n, etc.
 * Auth: Bearer token (instance owner's PAGS session token).
 */
publicRoutes.post('/webhook/:instanceId/ingest', async (c) => {
  const instanceId = c.req.param('instanceId');
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) throw new HttpError(401, 'Bearer token required');

  const { verifySession } = await import('../lib/session.js');
  const session = await verifySession(auth.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!session) throw new HttpError(401, 'Invalid token');

  const instance = await c.env.DB.prepare(
    'SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2 AND status = \'active\'',
  ).bind(instanceId, session.uid).first();
  if (!instance) throw new HttpError(404, 'Instance not found');

  const body = await c.req.json<{
    title: string;
    content: string;
    source?: string;
    sourceUrl?: string;
  }>();
  if (!body.title || !body.content) throw new HttpError(400, 'title and content required');

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
  const doRes = await stub.fetch(new Request('http://agent/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: body.title,
      content: body.content,
      source: body.source || 'webhook',
      sourceUrl: body.sourceUrl,
    }),
  }));

  return c.json(await doRes.json(), (doRes.ok ? 201 : doRes.status) as ContentfulStatusCode);
});
