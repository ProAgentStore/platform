-- #1042: existing coders move to a subscription CLI unless the owner confirmed API-key coding in the UI.
--
-- Until #1042 an engine preset could be set to `auth: "api-key"` (bill every token to a provider key)
-- with no confirmation, and Gemini's shipped preset defaulted to it. No instance can have a confirmed
-- console opt-in yet — `apiCodingOptIns` is new — so every stored `api-key` preset loses that sign-in
-- and runs on the machine's own CLI login (the subscription), as a new preset would. Its label, command
-- and default status are kept; only the sign-in changes.
--
-- `apiCodingMigrated` records which presets this switched, so the engines panel can say so and the
-- owner can choose API-key coding again — deliberately, through its billing confirmation.
--
-- The runtime gate (`resolveEngineEnv`) refuses an unconfirmed `api-key` preset whatever its origin,
-- so this migration is the friendly half: without it those coders would stop with a warning instead
-- of moving to the subscription CLI.
UPDATE agent_instances
   SET config = json_set(
         config,
         '$.codingEngines',
         (SELECT json_group_array(CASE WHEN json_extract(e.value, '$.auth') = 'api-key' THEN json_remove(e.value, '$.auth') ELSE json(e.value) END)
            FROM json_each(agent_instances.config, '$.codingEngines') AS e),
         '$.apiCodingMigrated',
         (SELECT json_group_array(json_extract(e.value, '$.id'))
            FROM json_each(agent_instances.config, '$.codingEngines') AS e
           WHERE json_extract(e.value, '$.auth') = 'api-key')
       ),
       updated_at = datetime('now')
 WHERE json_valid(config)
   AND json_type(config, '$.codingEngines') = 'array'
   AND EXISTS (SELECT 1 FROM json_each(agent_instances.config, '$.codingEngines') AS e WHERE json_extract(e.value, '$.auth') = 'api-key');
