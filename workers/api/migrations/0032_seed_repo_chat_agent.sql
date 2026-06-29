-- Register the first-party "Repo Chat" agent in the catalog.
--
-- A read-only agent: point it at ANY GitHub repository (public, or private when
-- the GitHub App is connected) and it pulls the whole repo into its vector store,
-- then you chat with it (voice included) to understand the code. It can explain,
-- never modify — the only repo access path is reading via the GitHub API.
--
-- Like Coder, it's platform-owned, so we seed it directly (idempotent) rather
-- than through the publish flow. Its console UI is the "repo" surface (declared in
-- config.capabilities); its identity lives in config.identity, which the subscribe
-- flow applies when initializing each subscriber's instance DO.

INSERT OR IGNORE INTO users (id, github_login, github_name, avatar_url, roles)
VALUES ('system', 'proagentstore', 'ProAgentStore', '', '["user","creator","admin"]');

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_repo_chat',
  'system',
  'repo-chat',
  'Repo Chat',
  'Chat with any GitHub repository. Paste a repo URL and it reads the whole codebase into a searchable knowledge base, then you can ask how anything works — files, functions, architecture, data flow — by text or voice. Read-only: it explains, it never changes your code.',
  'developer-tools',
  'agent',
  '🔍',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  json('{"capabilities":{"surfaces":["repo"],"runtime":null,"workflow":null},"identity":{"personality":"You are a meticulous, read-only code explainer. A GitHub repository has been indexed into your knowledge base and you answer questions about how the code works, where things live, and how the pieces fit together. You never modify code and have no ability to do so.","goal":"Help the user understand the indexed repository: explain files, functions, architecture, dependencies, and data flow, always grounded in the actual indexed code.","guardrails":{"responseStyle":"technical","topicRestrictions":"","blockedTerms":[],"maxResponseLength":0,"requireCitations":false},"welcomeMessage":"Open the Repo tab and paste any GitHub URL — I will read the whole repository into my knowledge base, then you can ask me anything about how it works (by text or voice)."}}'),
  datetime('now'),
  datetime('now')
);
