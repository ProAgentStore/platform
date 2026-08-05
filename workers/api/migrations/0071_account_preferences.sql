-- Account-level preferences: voice + translation stop being per-agent (#211).
--
-- Both were stored ONLY on `agent_instances.config`, so "I prefer Whisper" and "read replies at
-- 1.2x" had to be set once per agent — and a new subscription seeds neither, so every agent you
-- added made you re-tune your own preferences from platform defaults. Neither is a property of an
-- agent; both are properties of the person.
--
-- Storage mirrors the existing account-level JSON precedent, `users.board_config` (migration 0010).
ALTER TABLE users ADD COLUMN preferences TEXT NOT NULL DEFAULT '';

-- Promote what the user already tuned, so nobody has to set it up twice.
--
-- Voice and translation are resolved INDEPENDENTLY — each from the most recently updated instance
-- that actually has that section. A single "newest instance with voiceSettings" query loses the
-- translation config of anyone who had translation on one agent and voice on another (or voice on
-- none), and the rename below would then orphan it with nothing promoted in its place.
--
-- json_object rather than copying the raw config text: it drops every other config key and pins the
-- blob's shape to exactly {voice, translation}, which is what parseAccountPreferences expects. A
-- missing section lands as JSON null, which that parser already reads as "unset".
--
-- Built by CONCATENATION rather than json_object(). json_extract on an object path returns TEXT,
-- and SQLite's JSON subtype does not survive a scalar subquery — so json_object() (and json_set(),
-- and json() inside the subquery) all embed the value as an ESCAPED STRING:
--   {"voice":"{\"speed\":130}"}
-- parseAccountPreferences checks typeof === "object", so every promoted preference would fail that
-- check and silently fall back to platform defaults: the exact "we migrated your settings" lie this
-- section exists to prevent. Verified against real SQLite before committing. Concatenating the
-- extracted text is safe precisely because that text is already valid JSON.
UPDATE users
   SET preferences = '{"voice":' || COALESCE((
           SELECT json_extract(i.config, '$.voiceSettings')
             FROM agent_instances i
            WHERE i.user_id = users.id AND i.config IS NOT NULL AND json_valid(i.config)
              AND json_extract(i.config, '$.voiceSettings') IS NOT NULL
            ORDER BY i.updated_at DESC LIMIT 1
         ), 'null') || ',"translation":' || COALESCE((
           SELECT json_extract(i.config, '$.translation')
             FROM agent_instances i
            WHERE i.user_id = users.id AND i.config IS NOT NULL AND json_valid(i.config)
              AND json_extract(i.config, '$.translation') IS NOT NULL
            ORDER BY i.updated_at DESC LIMIT 1
         ), 'null') || '}'
 WHERE preferences = ''
   AND EXISTS (
         SELECT 1 FROM agent_instances i
          WHERE i.user_id = users.id AND i.config IS NOT NULL AND json_valid(i.config)
            AND (json_extract(i.config, '$.voiceSettings') IS NOT NULL
                 OR json_extract(i.config, '$.translation') IS NOT NULL)
       );

-- Now clear the per-instance copies. This is REQUIRED, not tidiness: presence of
-- `config.voiceSettings` is what marks an agent as "customised for this agent", so leaving the old
-- copies would make every existing agent read as customised — precisely the per-agent sprawl this
-- change removes, with the added insult that they'd all be pinned to whatever they held.
--
-- Renamed rather than deleted. The promotion above picks ONE instance's values; if it picked the
-- wrong one, the others are still recoverable from `*Legacy`. Nothing reads those keys.
UPDATE agent_instances
   SET config = json_remove(
                  json_set(config, '$.voiceSettingsLegacy', json_extract(config, '$.voiceSettings')),
                  '$.voiceSettings'
                ),
       updated_at = updated_at            -- keep updated_at: it is the promotion's ordering key
 WHERE config IS NOT NULL
   AND json_valid(config)
   AND json_extract(config, '$.voiceSettings') IS NOT NULL;

UPDATE agent_instances
   SET config = json_remove(
                  json_set(config, '$.translationLegacy', json_extract(config, '$.translation')),
                  '$.translation'
                ),
       updated_at = updated_at
 WHERE config IS NOT NULL
   AND json_valid(config)
   AND json_extract(config, '$.translation') IS NOT NULL;
