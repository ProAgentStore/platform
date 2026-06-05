import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types.js';
import { HttpError } from './lib/auth.js';
import { rateLimitDefault, rateLimitStrict } from './lib/rate-limit.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agents.js';
import { chatRoutes } from './routes/chat.js';
import { runRoutes } from './routes/run.js';
import { billingRoutes } from './routes/billing.js';

// Re-export Durable Object class for wrangler
export { AgentDO } from './agent-do.js';

const app = new Hono<{ Bindings: Env }>();

// ── Middleware ──────────────────────────────────────────────────────────────

app.use('*', cors({
  origin: [
    'https://proagentstore.online',
    'https://console.proagentstore.online',
    'http://localhost:5173',
    'http://localhost:4173',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  await next();
});

// Rate limiting: 60 req/min default, 10 req/min for expensive routes
app.use('/v1/*', rateLimitDefault());
app.use('/v1/agents/*/chat', rateLimitStrict());
app.use('/v1/agents/*/run', rateLimitStrict());

// ── Routes ─────────────────────────────────────────────────────────────────

app.route('/v1/auth', authRoutes);
app.route('/v1/agents', agentRoutes);
app.route('/v1/agents', chatRoutes);    // /v1/agents/:id/chat, /ws, /messages, /memory, /tasks
app.route('/v1/agents', runRoutes);     // /v1/agents/:id/run, /executions
app.route('/v1/billing', billingRoutes);

app.get('/health', (c) => c.json({ ok: true, service: 'proagentstore-api' }));

// ── Global error handler ───────────────────────────────────────────────────

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  console.error('Unhandled error:', err.message, err.stack);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
