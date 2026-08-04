-- Local Repo Chat — read-only chat about a repository that stays on the user's machine.
--
-- Why this exists alongside `repo-chat` (0032). That agent INGESTS: it fetches a repo tarball
-- from the GitHub API into Vectorize. Two consequences make it the wrong tool for a private
-- repo in someone else's org:
--   1. Access needs a GitHub-App installation on the repo's OWNER plus a verified binding
--      (lib/github-app.ts). A client org that has not installed the PAGS App is unreachable,
--      and installing it there is the org owner's call, not the user's.
--   2. It copies the source into platform storage. For a client's code that is a data-boundary
--      decision, not a setup step.
--
-- This agent inverts both. The repo is a checkout on the machine running `pags up`; the
-- `repo-local` connector reads it over the same WebSocket relay tmux/browser use. Local
-- git/gh credentials are the access control, so a private repo works iff that machine can
-- already read it, and nothing is ingested — only the excerpts a tool call returns cross the
-- wire, on demand.
--
-- Capabilities, in the declarative form (#141) — no monorepo code is specific to this agent:
--   surfaces []        — chat only. Deliberately NOT ["coding"]: that surface brings sessions,
--                        engines and the terminal, which is the opposite of read-only.
--   runtime  "coding"  — non-null so `pags up` registers the instance and the relay resolves.
--                        It shares the coding runtime's read endpoints; it starts nothing.
--   workflow null      — no Pilot, no autonomous loop. It answers questions.
--   tools    repo_*    — the repo-local connector, every tool scope:"read". The connector
--                        declares scopes.write:false, so it can never be write-consented.
--
-- The repository is a typed SETTING rather than a tool input on purpose: the owner names the
-- path once in the console, so text inside the repo itself cannot re-aim the tools somewhere
-- else. Reads are confined under that root by resolveInside() on the runner.
--
-- Seeded under the operator account, matching every other first-party catalog agent (see 0033).

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_local_repo_chat',
  COALESCE((SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%' LIMIT 1), 'system'),
  'local-repo-chat',
  'Local Repo Chat',
  'Chat with a repository on your own machine. Point it at a checkout, run `pags up`, and ask how the code works — it reads files, the tree and git history live over your runner. Read-only, and nothing is uploaded: private and client repos work with no GitHub App, because your machine''s own git credentials do the access.',
  'developer-tools',
  'agent',
  '📖',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  '{"capabilities":{"surfaces":[],"runtime":"coding","workflow":null,"tools":["repo_tree","repo_read_file","repo_git","repo_remote"]},"settingsSchema":[{"id":"repo_path","label":"Repository path","type":"text","description":"The checkout on the machine running `pags up`, e.g. ~/work/my-repo. One agent per repository. The code is never uploaded — only the parts the agent reads to answer you.","default":""}],"identity":{"personality":"You are a patient engineer who explains an unfamiliar codebase to someone who needs to understand it. You never guess: before you answer anything about the code, you look — repo_tree to see what exists, repo_read_file to read it, repo_git for history and current state. If you have not looked, you say so instead of speculating. You cite the files and functions you are talking about by path, and you translate what you read into plain language rather than pasting it back.","goal":"Help the user understand this repository: what it does, how it is structured, where a given behaviour lives, what changed recently, and what a file or function is actually doing.","guardrails":{"responseStyle":"technical","topicRestrictions":"","blockedTerms":[],"maxResponseLength":0,"requireCitations":false},"welcomeMessage":"Set the repository path in Settings, run `pags up` on that machine, and ask me anything about the code. I read it live from your checkout — nothing is uploaded."}}',
  datetime('now'), datetime('now')
);
