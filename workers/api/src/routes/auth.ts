import { Hono } from 'hono';
import type { Env } from '../types.js';
import { signSession } from '../lib/session.js';

export const authRoutes = new Hono<{ Bindings: Env }>();

const FAS_API = 'https://api.freeappstore.online';

/** Auth config — tells the console how to start the OAuth flow. */
authRoutes.get('/config', async (c) => {
  return c.json({
    // Use FAS shared OAuth (same approach as FAGS console)
    oauth_url: `${FAS_API}/v1/auth/github/start`,
    app_id: 'pags-console',
    response_mode: 'query',
  });
});

/**
 * Exchange a FAS session token for a PAGS session token.
 * Flow: Console → FAS OAuth → fas_session in URL → POST here → PAGS token.
 * Same pattern as FAGS console — piggyback on FAS's GitHub OAuth app.
 */
authRoutes.post('/exchange', async (c) => {
  const { fas_session } = await c.req.json<{ fas_session: string }>();
  if (!fas_session) return c.json({ error: 'fas_session required' }, 400);

  // Verify the FAS token by calling FAS /v1/auth/me
  const fasRes = await fetch(`${FAS_API}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${fas_session}` },
  });
  if (!fasRes.ok) {
    return c.json({ error: 'Invalid FAS session' }, 401);
  }
  // FAS /v1/auth/me returns: { id, login, githubLogin, avatarUrl, roles, ... }
  const fasUser = await fasRes.json<{
    id?: string; login?: string; githubLogin?: string; avatarUrl?: string;
  }>();
  if (!fasUser.id) {
    return c.json({ error: 'FAS session invalid' }, 401);
  }

  const uid = fasUser.id;
  const github_login = fasUser.githubLogin || fasUser.login || 'unknown';
  const avatar_url = fasUser.avatarUrl || '';
  const github_name = fasUser.login || github_login;

  // Upsert user in PAGS D1 — everyone is a creator on PAGS (it's a creator platform)
  const defaultRoles = JSON.stringify(['user', 'creator']);
  await c.env.DB.prepare(
    `INSERT INTO users (id, github_login, github_name, avatar_url, roles, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_login = excluded.github_login,
       github_name = excluded.github_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`,
  ).bind(uid, github_login, github_name || github_login, avatar_url, defaultRoles).run();

  // Fetch roles (existing users keep their roles, new users get user+creator)
  const row = await c.env.DB.prepare('SELECT roles FROM users WHERE id = ?1').bind(uid).first<{ roles: string }>();
  const roles = row?.roles ? JSON.parse(row.roles) : ['user', 'creator'];

  const token = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
  return c.json({
    token,
    user: { id: uid, login: github_login, avatar: avatar_url, roles },
  });
});

/**
 * Direct GitHub OAuth callback — exchange code for token.
 * Kept for future use when PAGS has its own OAuth app.
 */
authRoutes.post('/github', async (c) => {
  const { code, return_to } = await c.req.json<{ code: string; return_to?: string }>();
  if (!code) return c.json({ error: 'code required' }, 400);

  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.json({ error: 'GitHub OAuth not configured. Use /v1/auth/exchange with a FAS token instead.' }, 501);
  }

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

  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'ProAgentStore' },
  });
  const ghUser = await userRes.json<{ id: number; login: string; avatar_url: string; name: string }>();

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

  const row = await c.env.DB.prepare('SELECT roles FROM users WHERE id = ?1').bind(uid).first<{ roles: string }>();
  const roles = row?.roles ? JSON.parse(row.roles) : ['user'];

  const token = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles });
  return c.json({ token, user: { id: uid, login: ghUser.login, avatar: ghUser.avatar_url, roles }, return_to });
});

/** Verify current PAGS session. */
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
