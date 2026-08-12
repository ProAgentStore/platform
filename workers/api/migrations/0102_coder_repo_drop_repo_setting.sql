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
-- stops rendering it and `applySettingsPatch` (schema-driven) can no longer write it. It is NOT
-- copied into `coding_repos.workdir`: these values were never validated and at least one of them
-- is provably wrong, so adopting one would install a broken path as though somebody had chosen
-- it, which is precisely the false `ready` claim #405 removed.
--
-- ── CORRECTION (#520, comment only — the DDL below is unchanged and has already run)
--
-- This section used to end "and no code reads it — it is inert". That was FALSE when it was
-- written. `REPO_PATH_SETTINGS` (`workers/api/src/lib/connectors/repo-local.ts:35`) read
-- `config.settings.repo`, and `repoPathForInstance` was the ONLY source of the workdir for all six
-- `repo_*` tools — repo_tree, repo_read_file, repo_git, repo_remote, and later repo_find and
-- repo_grep. So this migration removed the INPUT and left the READER: from `fc01c17` (2026-08-08
-- 04:05 UTC) a `coder-repo` instance could not be given a repository by any route, and its six
-- read tools could only refuse. FIS coder `5d14a2e1-140c-466d-beec-ddd331a1e72b`, subscribed
-- 2026-08-10, is the recorded casualty: its entire conversation history is one failed
-- `repo_remote` — "No repository is configured for this agent."
--
-- The reader now points where this migration said the truth lives: `repoPathForInstance` resolves
-- `coding_repos.workdir` first (the row #410 made editable in the Coding tab), falling back to
-- these orphaned settings when no row carries a folder OR when the runner has MEASURED the row's
-- folder missing (`clone_status = 'needs_attention'`). That second clause is not tidiness: Chess
-- coder `bfc76603` works today off its orphaned setting while its row points at a folder that does
-- not exist, so a flat row-first rule would have broken a working instance. Together the two keep
-- every pre-0102 instance working and keep `local-repo-chat`'s live `repo_path` field
-- authoritative for the agent that still declares it. `repo-path-writer.test.ts` now fails if a
-- schema edit orphans a required setting again; a comment claiming "no code reads it" is not a
-- substitute for that test, which is the lesson of this paragraph existing.
--
-- Corrected in place rather than in a new migration because the statement is documentation, not
-- behaviour: `scripts/check-migrations.mjs` strips comments before comparing history, and 0080 is
-- this repo's precedent for correcting a comment that says something untrue.
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
