-- Take the legacy hardcoded Coder out of the public catalogue (#941, epic #939).
--
-- 0063 re-expressed it as declarations — `coder-repo` (one repository per instance) and
-- `coder-lead` (delegation over a supervision graph) — and `local-coder` (0164) followed. The
-- original was never unpublished, so it kept taking subscriptions two months after it was
-- superseded: the last one was created 2026-10-01. Its owner-side instances were cancelled on
-- 2026-10-07 (#940); what is left is the catalogue row.
--
-- `draft` is how every other retired catalogue agent is held (0104, 0112): the row stays, so
-- nothing that joins `agent_instances` to `agents` loses its target, but `list_agents` no longer
-- returns it and `POST /v1/instances/:id/subscribe` refuses it (it selects `visibility =
-- 'published'` only).
--
-- 0145 is the last migration that adds a tool to `slug = 'coder'`. Do not add another: a coding
-- capability belongs on `coder-repo` / `local-coder`.
UPDATE agents
   SET visibility = 'draft',
       updated_at = datetime('now')
 WHERE slug = 'coder';
