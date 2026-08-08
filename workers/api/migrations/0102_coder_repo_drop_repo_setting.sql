-- The Repo Coder's `repo` SETTING is deleted: a repo's address is stored once (#411, with #410).
--
-- "Which repo does this agent work on" was written down in two places.
--
--   agent_instances.config.settings.repo   <- the field the console offers, that an owner can edit
--   coding_repos.workdir                   <- the column every tool actually reads
--
-- The reported bug was "I updated it, but it is still using the old one", and both halves were
-- true. Chess coder's setting read `~/dev/stores/pas/platform/apps/chess-academy` while its repo
-- row read `~/dev/pas/platform/apps/chess-academy`, untouched (`updated_at` two days stale). The
-- one wire between them (`attachSettingRepo`, #157/#182) fired only on CREATE, for an instance
-- with zero repos — so the FIRST value seeded a row and every correction after it went nowhere.
-- Half a wire is worse than none: it makes the field look connected.
--
-- ── Why delete rather than mirror
--
-- `settingsSchema` is for typed, declarative, subscriber-set VALUES (target_language, photo_limit).
-- Making one of them create and mutate `coding_repos` — a table `coding_sessions` and
-- `coding_timeline` hang off by foreign key — puts relational work, runner probes and live-session
-- safety behind a text field, and hides all of it inside a settings save. And a mirror is a second
-- place the same fact is written down: it needs a sync, and a sync that can fail is a disagreement
-- waiting to happen. That is the defect, not the remedy.
--
-- So the repo row is the single home for a repo's address, and #410 makes that address editable
-- where the repo lives: the Coding tab's repo settings sheet, validated by the same #405 check the
-- add path runs, refused while a session is live, and re-verified on save.
--
-- ── Stored values are ORPHANED, deliberately
--
-- Instances keep `config.settings.repo` in their JSON. With the field off the schema the console
-- stops rendering it, `applySettingsPatch` (schema-driven) can no longer write it, and no code
-- reads it — it is inert. It is NOT copied into `coding_repos.workdir`: these values were never
-- validated and at least one of them is provably wrong, so adopting one would install a broken
-- path as though somebody had chosen it, which is precisely the false `ready` claim #405 removed.
--
-- ── Shape
--
-- Rebuilds `$.settingsSchema` as the same array minus the `repo` element, preserving order and
-- every other field. Scoped to `coder-repo`: it is the only agent that declares `repo`, and a
-- creator-authored agent's schema is not this migration's business. Idempotent — the EXISTS guard
-- makes a re-run a no-op — and a no-op on a database without the agent.
--
-- A new file rather than an edit to 0063: that seed has already run in production, editing it
-- changes nothing there while a fresh database gets the new text (scripts/check-migrations.mjs),
-- and 0063 is the repo's own worked example of that trap (see its GRANDFATHERED entry).

UPDATE agents
   SET config = json_set(
         config,
         '$.settingsSchema',
         (SELECT json_group_array(json(field.value))
            FROM json_each(agents.config, '$.settingsSchema') AS field
           WHERE json_extract(field.value, '$.id') <> 'repo')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo'
   AND json_valid(config)
   AND json_type(config, '$.settingsSchema') = 'array'
   AND EXISTS (
         SELECT 1 FROM json_each(agents.config, '$.settingsSchema') AS declared
          WHERE json_extract(declared.value, '$.id') = 'repo'
       );
