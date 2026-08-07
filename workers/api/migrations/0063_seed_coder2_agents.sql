-- Coder 2 — the hardcoded Coder, re-expressed as DECLARATIONS (#160 / epic #58).
--
-- The existing Coder is one agent with six hardcoded moving parts: an Overseer route that knows
-- how to find repos, a Pilot bound to a workflow enum, a browser-driven Loop, and a bespoke
-- `drive_claude` tool defined inline in routes/coding.ts. Its hierarchy lives INSIDE it, so no
-- other agent can reuse any of it.
--
-- Coder 2 is the same capability assembled from platform primitives instead, as two catalog
-- templates plus configuration:
--
--   coder-repo   — one instance PER REPOSITORY. Identical capabilities to the hardcoded Coder
--                  (surfaces/runtime/workflow/tools below are byte-for-byte what migration 0054
--                  left on `coder`), so a repo agent is exactly as capable as today's Coder.
--   coder-lead   — the Overseer, minus the hardcoding. No runtime and no workflow: it is a plain
--                  cloud agent whose power is the supervision connector, and its hierarchy is
--                  rows in `agent_supervision` (#183) rather than a route that knows about repos.
--
-- What replaces what:
--   Overseer route        -> coder-lead + supervision graph (#183)
--   drive_claude tool     -> delegate_goal registry tool (#156/#159)
--   client-driven Loop    -> AgentLoopWorkflow (#158)
--   unbounded spend       -> delegation budget (#184)
--   implicit trust        -> authority containment (#185)
--
-- Nothing here needs a monorepo PR to change: capabilities, settings and identity are all data.
-- Seeded under the operator account, matching every other first-party catalog agent (see 0033).

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_coder_repo',
  COALESCE((SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%' LIMIT 1), 'system'),
  'coder-repo',
  'Repo Coder',
  'A coding agent that owns ONE repository. It drives a coding CLI (Claude Code, Codex or Grok) on your own machine, works through objectives autonomously, and hands back control when it is stuck. Subscribe once per repo, then put a Coder Lead over them to work across repos.',
  'code',
  'agent',
  '⌨️',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  '{"capabilities":{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","tools":["github_create_issue","github_list_issues","github_read_issue"]},"settingsSchema":[{"id":"repo","label":"Repository","type":"text","description":"The repo this agent owns \u2014 a local path (~/dev/my-repo) or owner/name. One agent per repo.","default":""},{"id":"engine","label":"Coding CLI","type":"select","description":"Which CLI this agent drives on your machine.","options":[{"value":"claude","label":"Claude Code"},{"value":"codex","label":"Codex"},{"value":"grok","label":"Grok"}],"default":"claude"},{"id":"autonomy","label":"Autonomy","type":"select","description":"How far it may go before asking. ''Ask first'' escalates on anything ambiguous.","options":[{"value":"ask","label":"Ask first"},{"value":"normal","label":"Normal"},{"value":"autonomous","label":"Autonomous"}],"default":"normal"}],"identity":{"personality":"You are a focused software engineer responsible for exactly one repository. You drive a coding CLI running on the user''s own machine, you read the terminal to see what is happening, and you report progress in plain language. You do not touch repositories other than your own.","goal":"Deliver the objectives you are given in your repository: understand the code, make the change, verify it, and say clearly when you are done or blocked.","guardrails":{"responseStyle":"technical","topicRestrictions":"","blockedTerms":[],"maxResponseLength":0,"requireCitations":false},"welcomeMessage":"Point me at a repo in the Coding tab and run `pags up`, then give me an objective \u2014 I''ll drive the CLI and report back."}}',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_coder_lead',
  COALESCE((SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%' LIMIT 1), 'system'),
  'coder-lead',
  'Coder Lead',
  'An engineering lead for your Repo Coders. Tell it what needs doing across your repositories and it hands each repo agent a goal, tracks what comes back, and reports the whole picture. It writes no code itself — it delegates, with a spend budget and a depth limit it cannot raise.',
  'code',
  'agent',
  '🧭',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  '{"capabilities":{"surfaces":[],"runtime":null,"workflow":null,"tools":["list_subordinates","delegate_goal","check_delegation","github_list_issues","github_read_issue"]},"settingsSchema":[{"id":"strategy","label":"How to split work","type":"select","description":"How the supervisor decides which repo agent gets a goal.","options":[{"value":"by_repo","label":"By repository"},{"value":"by_issue","label":"By GitHub issue"}],"default":"by_repo"},{"id":"max_parallel","label":"Max agents working at once","type":"number","description":"How many subordinates may run concurrently. Each one costs money, so keep this small.","default":3}],"identity":{"personality":"You are an engineering lead. You do not write code yourself \u2014 you have a team of agents, each owning one repository. You find out who you supervise, hand them clear outcomes, and track what comes back. You delegate goals, never keystrokes.","goal":"Turn a cross-repository request into goals for the right repo agents, then follow up until each reports done or blocked, and summarise the whole picture for the human.","guardrails":{"responseStyle":"technical","topicRestrictions":"","blockedTerms":[],"maxResponseLength":0,"requireCitations":false},"welcomeMessage":"Add the repo agents you want me to oversee in Settings \u2192 Supervision, then tell me what needs doing across them."}}',
  datetime('now'), datetime('now')
);
