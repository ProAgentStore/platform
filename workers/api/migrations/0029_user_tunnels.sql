-- Per-user named Cloudflare tunnels (production-grade, replaces quick tunnels).
-- Each user gets ONE tunnel under the PAGS CF account. The connector token is
-- handed to the CLI; cloudflared runs `tunnel run --token <TOKEN>` — no quick
-- tunnel API hammering, no rate limits, stable hostname.

CREATE TABLE IF NOT EXISTS user_tunnels (
  user_id       TEXT PRIMARY KEY,
  tunnel_id     TEXT NOT NULL,
  tunnel_name   TEXT NOT NULL,
  hostname      TEXT NOT NULL,          -- e.g. runner-abc123.proagentstore.online
  dns_record_id TEXT,                   -- CF DNS record id (for cleanup)
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
