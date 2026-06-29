-- Re-own the "Repo Chat" agent to the platform operator's creator account.
--
-- 0032 seeded it under 'system' (matching Coder), but every other first-party
-- catalog agent (Data Analyst, Site Monitor, Job Application Assistant, …) is
-- owned by the operator's own creator account, so it shows under "Agents you've
-- built" and is managed like the rest. Align Repo Chat with them.
--
-- We don't hardcode the account id: we copy it from an existing operator-owned
-- agent. COALESCE keeps the current owner if no such row exists (fresh DBs),
-- so this never breaks the users FK.
UPDATE agents
SET owner_id = COALESCE(
      (SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%' LIMIT 1),
      owner_id
    ),
    updated_at = datetime('now')
WHERE slug = 'repo-chat';
