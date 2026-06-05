import { Hono } from 'hono';
import type { Env } from '../types.js';
import { signSession } from '../lib/session.js';

export const authRoutes = new Hono<{ Bindings: Env }>();

/** Public config for OAuth flow — returns client_id so the console can build the redirect URL. */
authRoutes.get('/config', async (c) => {
  return c.json({ github_client_id: c.env.GITHUB_CLIENT_ID });
});

/** GitHub OAuth callback — exchange code for token, upsert user, return session. */
authRoutes.post('/github', async (c) => {
  const { code, return_to } = await c.req.json<{ code: string; return_to?: string }>();
  if (!code) return c.json({ error: 'code required' }, 400);

  // Exchange code for GitHub access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    return c.json({ error: tokenData.error || 'OAuth failed' }, 401);
  }

  // Fetch GitHub user profile
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'ProAgentStore' },
  });
  const ghUser = await userRes.json<{ id: number; login: string; avatar_url: string; name: string }>();

  // Upsert user in D1
  const uid = String(ghUser.id);
  await c.env.DB.prepare(
    `INSERT INTO users (id, github_login, github_name, avatar_url, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       github_name = excluded.github_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`,
  ).bind(uid, ghUser.login, ghUser.name || ghUser.login, ghUser.avatar_url).run();

  // Fetch roles
  const row = await c.env.DB.prepare('SELECT roles FROM users WHERE id = ?1').bind(uid).first<{ roles: string }>();
  const roles = row?.roles ? JSON.parse(row.roles) : ['user'];

  const token = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
  return c.json({ token, user: { id: uid, login: ghUser.login, avatar: ghUser.avatar_url, roles }, return_to });
});

/** Verify current session. */
authRoutes.get('/me', async (c) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return c.json({ error: 'Not authenticated' }, 401);

  const { verifySession } = await import('../lib/session.js');
  const session = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!session) return c.json({ error: 'Invalid or expired token' }, 401);

  const row = await c.env.DB.prepare(
    'SELECT id, github_login, github_name, avatar_url, roles, stripe_customer_id FROM users WHERE id = ?1',
  ).bind(session.uid).first<Record<string, string>>();
  if (!row) return c.json({ error: 'User not found' }, 404);

  return c.json({
    id: row.id,
    login: row.github_login,
    name: row.github_name,
    avatar: row.avatar_url,
    roles: JSON.parse(row.roles || '["user"]'),
    hasSubscription: !!row.stripe_customer_id,
  });
});
