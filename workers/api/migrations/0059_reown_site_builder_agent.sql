-- Re-own the "Small Business Website Builder" agent to the operator's creator account.
--
-- 0057 seeded it under 'system' (matching Coder), which means it never appears under
-- "Agents you've built" and can't be edited from the console — a real problem for an
-- agent whose whole behaviour is its pipelines and settingsSchema, both of which want
-- tuning against live leads.
--
-- This is exactly what 0033 did for Repo Chat, and for the same reason: every other
-- first-party catalog agent (Data Analyst, Site Monitor, Job Application Assistant, …)
-- is operator-owned. Same technique too — copy the id from an existing operator-owned
-- agent rather than hardcoding it, with COALESCE keeping the current owner on a fresh
-- DB where no such row exists, so this never breaks the users FK.
UPDATE agents
SET owner_id = COALESCE(
      (SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%' LIMIT 1),
      owner_id
    ),
    updated_at = datetime('now')
WHERE slug = 'site-builder';
