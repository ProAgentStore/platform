-- #1383: a first-class DISABLED coder state, without a second status.
--
-- "Disabled" is `agent_instances.status = 'paused'` (the reversible stop of #825): every gate that refuses work for a paused
-- instance already refuses it for a disabled one, and re-enabling is `resume`. What was missing is the RECORD of the decision — when it
-- was disabled, by whom, and why — so the Disabled list can say more than "paused" and an owner coming back later knows what they meant.
--
-- All three are NULL on an instance that was never disabled, and on one paused by plain `pause_instance` (no record was asked for; the
-- list shows it as paused with no record rather than inventing one). Enabling clears them. Nothing else about the instance is touched, so a
-- round trip restores pins, repos, queue and schedules exactly. Timestamps are TEXT (`datetime('now')`), like `created_at` and `updated_at`.
ALTER TABLE agent_instances ADD COLUMN disabled_at TEXT;
ALTER TABLE agent_instances ADD COLUMN disabled_by TEXT;
ALTER TABLE agent_instances ADD COLUMN disabled_reason TEXT;
