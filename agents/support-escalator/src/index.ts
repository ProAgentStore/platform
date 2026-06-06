/**
 * support-escalator — ProAgentStore agent.
 *
 * Triages incoming support tickets using Workers AI:
 *   - POST /webhook/ticket   receive a new ticket
 *   - GET  /tickets          list all tickets (optional ?status= filter)
 *   - GET  /tickets/:id      get a single ticket
 *   - PUT  /tickets/:id/resolve  mark a ticket resolved
 *   - GET  /stats            open/closed/auto-responded counts
 *
 * Durable Object (TicketStoreDO) holds all ticket state and the knowledge base.
 * Cron fires daily at 9am UTC and sends an open-ticket summary to the escalation webhook.
 */

import { Hono } from 'hono';
import { DurableObject } from 'cloudflare:workers';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Ticket {
  id: string;
  subject: string;
  body: string;
  customerEmail: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'auto_responded' | 'escalated' | 'resolved';
  classification: 'auto' | 'escalate' | 'pending';
  autoResponse?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntry {
  id: string;
  topic: string;
  question: string;
  answer: string;
}

interface Env {
  AI: Ai;
  TICKET_STORE: DurableObjectNamespace;
  ESCALATION_WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
}

type AiTextResponse = { response?: string };

// ─── Durable Object ──────────────────────────────────────────────────────────

export class TicketStoreDO extends DurableObject {
  private tickets: Map<string, Ticket> = new Map();
  private kb: KnowledgeEntry[] = [];
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async init() {
    if (this.initialized) return;
    const stored = await this.ctx.storage.get<Ticket[]>('tickets');
    if (stored) {
      for (const t of stored) this.tickets.set(t.id, t);
    }
    const kb = await this.ctx.storage.get<KnowledgeEntry[]>('kb');
    this.kb = kb ?? defaultKnowledgeBase();
    this.initialized = true;
  }

  private async persist() {
    await this.ctx.storage.put('tickets', [...this.tickets.values()]);
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/do/tickets') {
      const ticket = await request.json<Ticket>();
      this.tickets.set(ticket.id, ticket);
      await this.persist();
      return Response.json(ticket);
    }

    if (request.method === 'GET' && path === '/do/tickets') {
      const status = url.searchParams.get('status');
      let list = [...this.tickets.values()];
      if (status) list = list.filter(t => t.status === status);
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Response.json(list);
    }

    if (request.method === 'GET' && path.startsWith('/do/tickets/')) {
      const id = path.slice('/do/tickets/'.length);
      const ticket = this.tickets.get(id);
      if (!ticket) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json(ticket);
    }

    if (request.method === 'PUT' && path.startsWith('/do/tickets/') && path.endsWith('/resolve')) {
      const id = path.slice('/do/tickets/'.length).replace('/resolve', '');
      const ticket = this.tickets.get(id);
      if (!ticket) return Response.json({ error: 'Not found' }, { status: 404 });
      ticket.status = 'resolved';
      ticket.updatedAt = new Date().toISOString();
      this.tickets.set(id, ticket);
      await this.persist();
      return Response.json(ticket);
    }

    if (request.method === 'GET' && path === '/do/stats') {
      const all = [...this.tickets.values()];
      return Response.json({
        total: all.length,
        open: all.filter(t => t.status === 'open').length,
        auto_responded: all.filter(t => t.status === 'auto_responded').length,
        escalated: all.filter(t => t.status === 'escalated').length,
        resolved: all.filter(t => t.status === 'resolved').length,
      });
    }

    if (request.method === 'GET' && path === '/do/kb') {
      return Response.json(this.kb);
    }

    if (request.method === 'POST' && path === '/do/kb') {
      const entry = await request.json<KnowledgeEntry>();
      this.kb.push(entry);
      await this.ctx.storage.put('kb', this.kb);
      return Response.json(entry, { status: 201 });
    }

    if (request.method === 'GET' && path === '/do/open-summary') {
      const open = [...this.tickets.values()].filter(t =>
        t.status === 'open' || t.status === 'escalated'
      );
      open.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Response.json(open);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}

// ─── Knowledge base seed ─────────────────────────────────────────────────────

function defaultKnowledgeBase(): KnowledgeEntry[] {
  return [
    {
      id: 'kb-1',
      topic: 'billing',
      question: 'How do I cancel my subscription?',
      answer: 'You can cancel your subscription at any time from your account settings under Billing > Cancel Plan. Your access continues until the end of the current billing period.',
    },
    {
      id: 'kb-2',
      topic: 'billing',
      question: 'Can I get a refund?',
      answer: 'We offer a 14-day money-back guarantee for new subscriptions. Contact support within 14 days of your initial purchase for a full refund.',
    },
    {
      id: 'kb-3',
      topic: 'account',
      question: 'How do I reset my password?',
      answer: 'Click "Forgot Password" on the login page and enter your email. You will receive a reset link within a few minutes. Check your spam folder if it does not arrive.',
    },
    {
      id: 'kb-4',
      topic: 'account',
      question: 'How do I change my email address?',
      answer: 'Go to Account Settings > Profile and update your email. You will need to verify the new address before the change takes effect.',
    },
    {
      id: 'kb-5',
      topic: 'technical',
      question: 'The app is not loading',
      answer: 'Try clearing your browser cache and cookies, then reload. If the issue persists, try a different browser or disable browser extensions. You can also check our status page for any ongoing incidents.',
    },
    {
      id: 'kb-6',
      topic: 'technical',
      question: 'I am getting an error message',
      answer: 'Please note the exact error message and the steps that led to it. Common fixes include refreshing the page, clearing cache, or logging out and back in. If the issue continues, our team will investigate.',
    },
  ];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return `tkt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getDoStub(env: Env): DurableObjectStub {
  // Single shared instance for this agent
  const id = env.TICKET_STORE.idFromName('main');
  return env.TICKET_STORE.get(id);
}

async function doFetch(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<Response> {
  return stub.fetch(`https://do${path}`, init);
}

// ─── AI: classify ticket ──────────────────────────────────────────────────────

async function classifyTicket(
  env: Env,
  subject: string,
  body: string,
  kb: KnowledgeEntry[],
): Promise<{ classification: 'auto' | 'escalate'; confidence: string; reason: string }> {
  const kbSummary = kb
    .map(e => `- ${e.topic}: "${e.question}"`)
    .join('\n');

  const prompt = `You are a support ticket classifier. Decide if this ticket can be AUTO-RESPONDED using the knowledge base, or must be ESCALATED to a human agent.

Knowledge base topics:
${kbSummary}

Ticket subject: ${subject}
Ticket body: ${body}

Rules:
- AUTO if the question clearly matches a KB topic and a standard answer will satisfy it
- ESCALATE if: billing dispute, account suspension, data loss, security concern, legal issue, complex technical bug, angry/frustrated tone, or no KB match

Respond with JSON only, no markdown:
{"classification":"auto"|"escalate","confidence":"high"|"medium"|"low","reason":"one sentence"}`;

  const result = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as Parameters<Ai['run']>[0],
    { messages: [{ role: 'user', content: prompt }] },
  ) as AiTextResponse;

  try {
    const raw = result.response?.trim() ?? '';
    // Strip any accidental markdown fences
    const json = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(json);
  } catch {
    return { classification: 'escalate', confidence: 'low', reason: 'Could not parse AI response' };
  }
}

// ─── AI: generate auto-response ───────────────────────────────────────────────

async function generateAutoResponse(
  env: Env,
  subject: string,
  body: string,
  customerEmail: string,
  kb: KnowledgeEntry[],
): Promise<string> {
  const kbContext = kb
    .map(e => `Q: ${e.question}\nA: ${e.answer}`)
    .join('\n\n');

  const prompt = `You are a friendly and professional customer support agent. Write a helpful email reply to the customer below.

Knowledge base:
${kbContext}

Customer email: ${customerEmail}
Subject: ${subject}
Message: ${body}

Instructions:
- Be warm, concise, and professional
- Use knowledge base answers where relevant
- If you cannot fully resolve it, offer to escalate
- Do NOT make up information not in the knowledge base
- Sign off as "Support Team"
- Plain text only, no markdown`;

  const result = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as Parameters<Ai['run']>[0],
    { messages: [{ role: 'user', content: prompt }] },
  ) as AiTextResponse;

  return result.response?.trim() ?? 'Thank you for contacting support. We have received your message and will get back to you shortly.';
}

// ─── AI: daily summary ────────────────────────────────────────────────────────

async function generateDailySummary(env: Env, openTickets: Ticket[]): Promise<string> {
  if (openTickets.length === 0) {
    return 'No open or escalated tickets. All clear!';
  }

  const ticketList = openTickets
    .slice(0, 20) // cap at 20 to stay within context
    .map((t, i) =>
      `${i + 1}. [${t.priority.toUpperCase()}] ${t.subject} — ${t.customerEmail} (${t.status}, created ${t.createdAt.slice(0, 10)})`
    )
    .join('\n');

  const prompt = `You are a support manager. Write a brief daily summary (5-8 sentences) of open support tickets for the team. Highlight urgent/high priority items and any patterns you notice.

Open tickets (${openTickets.length} total):
${ticketList}

Keep it concise and actionable. Plain text only.`;

  const result = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as Parameters<Ai['run']>[0],
    { messages: [{ role: 'user', content: prompt }] },
  ) as AiTextResponse;

  return result.response?.trim() ?? `${openTickets.length} tickets need attention.`;
}

// ─── Escalation webhook ───────────────────────────────────────────────────────

async function notifyEscalation(env: Env, ticket: Ticket): Promise<void> {
  if (!env.ESCALATION_WEBHOOK_URL) return;

  const payload = {
    type: 'ticket_escalated',
    ticket: {
      id: ticket.id,
      subject: ticket.subject,
      customerEmail: ticket.customerEmail,
      priority: ticket.priority,
      createdAt: ticket.createdAt,
      preview: ticket.body.slice(0, 200),
    },
    timestamp: new Date().toISOString(),
  };

  await fetch(env.ESCALATION_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(err => console.error('Escalation webhook failed:', err));
}

async function notifyDailySummary(env: Env, summary: string, stats: Record<string, number>): Promise<void> {
  if (!env.ESCALATION_WEBHOOK_URL) return;

  const payload = {
    type: 'daily_summary',
    summary,
    stats,
    timestamp: new Date().toISOString(),
  };

  await fetch(env.ESCALATION_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(err => console.error('Daily summary webhook failed:', err));
}

// ─── Request signature verification ──────────────────────────────────────────

async function verifyWebhookSignature(request: Request, secret: string): Promise<boolean> {
  const sig = request.headers.get('X-Webhook-Signature');
  if (!sig) return false;

  const body = await request.clone().text();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = 'sha256=' + Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return sig === expected;
}

// ─── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// Health
app.get('/', c => c.json({ agent: 'support-escalator', status: 'ok' }));

// POST /webhook/ticket — receive a new support ticket
app.post('/webhook/ticket', async c => {
  // Verify HMAC signature if secret is configured
  if (c.env.WEBHOOK_SECRET) {
    const valid = await verifyWebhookSignature(c.req.raw, c.env.WEBHOOK_SECRET);
    if (!valid) return c.json({ error: 'Invalid signature' }, 401);
  }

  let body: { subject?: string; body?: string; customerEmail?: string; priority?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { subject, body: ticketBody, customerEmail, priority } = body;

  if (!subject || !ticketBody || !customerEmail) {
    return c.json({ error: 'subject, body, and customerEmail are required' }, 400);
  }

  const validPriorities = ['low', 'normal', 'high', 'urgent'];
  const resolvedPriority = validPriorities.includes(priority ?? '') ? priority as Ticket['priority'] : 'normal';

  const do_ = getDoStub(c.env);

  // Fetch knowledge base for classification
  const kbRes = await doFetch(do_, '/do/kb');
  const kb = await kbRes.json<KnowledgeEntry[]>();

  // Classify with AI
  const { classification, reason } = await classifyTicket(c.env, subject, ticketBody, kb);

  const now = new Date().toISOString();
  const ticket: Ticket = {
    id: generateId(),
    subject,
    body: ticketBody,
    customerEmail,
    priority: resolvedPriority,
    status: 'open',
    classification,
    createdAt: now,
    updatedAt: now,
  };

  if (classification === 'auto') {
    // Generate and attach auto-response
    const autoResponse = await generateAutoResponse(c.env, subject, ticketBody, customerEmail, kb);
    ticket.autoResponse = autoResponse;
    ticket.status = 'auto_responded';
  } else {
    // Escalate
    ticket.status = 'escalated';
    // Fire-and-forget escalation notification
    c.executionCtx.waitUntil(notifyEscalation(c.env, ticket));
  }

  // Persist ticket
  await doFetch(do_, '/do/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ticket),
  });

  console.log(`Ticket ${ticket.id} created: ${classification} (${reason})`);

  return c.json({ ticket, classificationReason: reason }, 201);
});

// GET /tickets — list tickets with optional ?status= filter
app.get('/tickets', async c => {
  const status = c.req.query('status');
  const do_ = getDoStub(c.env);
  const res = await doFetch(do_, `/do/tickets${status ? `?status=${status}` : ''}`);
  const tickets = await res.json<Ticket[]>();
  return c.json({ tickets, count: tickets.length });
});

// GET /tickets/:id — get a single ticket
app.get('/tickets/:id', async c => {
  const do_ = getDoStub(c.env);
  const res = await doFetch(do_, `/do/tickets/${c.req.param('id')}`);
  if (!res.ok) return c.json({ error: 'Ticket not found' }, 404);
  return c.json(await res.json<Ticket>());
});

// PUT /tickets/:id/resolve — mark a ticket resolved
app.put('/tickets/:id/resolve', async c => {
  const do_ = getDoStub(c.env);
  const res = await doFetch(do_, `/do/tickets/${c.req.param('id')}/resolve`, { method: 'PUT' });
  if (!res.ok) return c.json({ error: 'Ticket not found' }, 404);
  return c.json(await res.json<Ticket>());
});

// GET /stats — ticket counts by status
app.get('/stats', async c => {
  const do_ = getDoStub(c.env);
  const res = await doFetch(do_, '/do/stats');
  return c.json(await res.json());
});

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err.message, err.stack);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound(c => c.json({ error: 'Not found' }, 404));

// ─── Scheduled handler (cron: daily 9am UTC) ─────────────────────────────────

async function handleScheduled(env: Env): Promise<void> {
  console.log(`support-escalator cron fired at ${new Date().toISOString()}`);

  const do_ = env.TICKET_STORE.get(env.TICKET_STORE.idFromName('main'));

  const [openRes, statsRes] = await Promise.all([
    do_.fetch('https://do/do/open-summary'),
    do_.fetch('https://do/do/stats'),
  ]);

  const openTickets = await openRes.json<Ticket[]>();
  const stats = await statsRes.json<Record<string, number>>();

  const summary = await generateDailySummary(env, openTickets);
  console.log('Daily summary:', summary);

  await notifyDailySummary(env, summary, stats);
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};
