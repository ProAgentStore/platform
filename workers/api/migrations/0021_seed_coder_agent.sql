-- Register the first-party "Coder" agent in the catalog (the AgentCoder port).
--
-- Unlike a creator's submission, Coder is a platform-owned agent, so we seed it
-- directly (idempotent) rather than going through the publish flow. It is the
-- subscribable face of the coding capability: a client subscribes → gets an
-- instance == their coding workspace → imports ANY of their GitHub repos → drives
-- the coding CLI on their own machine via `pags up`.
--
-- The runtime descriptor lives in `config.runtime` (mirrors agent.json); the
-- console shows the Coding tab for instances whose agent category is 'code'.

-- Platform owner for first-party agents (LEFT JOIN in the catalog tolerates its
-- absence, but the FK + a sensible creator label want a real row).
INSERT OR IGNORE INTO users (id, github_login, github_name, avatar_url, roles)
VALUES ('system', 'proagentstore', 'ProAgentStore', '', '["user","creator","admin"]');

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_coder',
  'system',
  'coder',
  'Coder',
  'Your AI coding agent for any GitHub repo. Import a repository and the agent runs a coding CLI (Claude Code / Gemini / Codex) on your own machine — drive it from anywhere or hand it an objective and let it work autonomously, with live takeover when it gets stuck.',
  'code',
  'agent',
  '💻',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  '{"runtime":{"kind":"pags-coding-runtime","taskTypes":["coding.session"],"requiresLocalRunner":true,"brainPlacement":"pags-control-plane","runtimePlane":"local-cli"},"repoAgnostic":true}',
  datetime('now'),
  datetime('now')
);
