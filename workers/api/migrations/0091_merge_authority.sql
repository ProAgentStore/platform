-- Merge authority (#314): whether an agent may put code on a repository's trunk.
--
-- Run 73ffc073 opened and merged three pull requests to `main` unattended. The objective did say
-- "merge each before starting the next" — nothing decided whether it was ALLOWED to. #294 made the
-- act visible; this stores the decision.
--
-- DEFAULT IS TODAY'S BEHAVIOUR. The column defaults to '' (inherit) and the resolved default is
-- `merge` (lib/coding-authority.ts DEFAULT_MERGE_POLICY), so nothing an owner already relies on
-- changes. Choosing `pr` is one field per repo, or one setting per agent (below).

ALTER TABLE coding_repos ADD COLUMN merge_policy TEXT NOT NULL DEFAULT '';

-- The per-agent default, expressed as a typed subscriber setting rather than a bespoke conditional
-- — the same mechanism as Language Buddy's `target_language` (migration 0041). It gets its console
-- UI, its validation and its persistence from the settingsSchema machinery that already exists, so
-- there is no new surface to build and nothing new to teach.
--
-- Every read of `config` is normalised with COALESCE(NULLIF(...)) before json_extract/json_type
-- touches it: the column is '' on some legacy rows, and those functions ERROR on a malformed
-- document, which would abort the entire migration over an agent this has nothing to do with.
--
-- Step 1: a coding agent with no settingsSchema at all needs an array to append to.
UPDATE agents
SET config = json_set(COALESCE(NULLIF(config, ''), '{}'), '$.settingsSchema', json('[]'))
WHERE COALESCE(json_extract(COALESCE(NULLIF(config, ''), '{}'), '$.capabilities.surfaces'), '') LIKE '%coding%'
  AND COALESCE(json_type(COALESCE(NULLIF(config, ''), '{}'), '$.settingsSchema'), '') <> 'array';

-- Step 2: append the field. Idempotent — the NOT LIKE guard means a database that already carries
-- the field is left exactly as it is, so a re-run cannot append a duplicate.
UPDATE agents
SET config = json_insert(COALESCE(NULLIF(config, ''), '{}'), '$.settingsSchema[#]', json('{
  "id":"merge_policy","label":"Merge authority","type":"select","default":"merge",
  "description":"What this agent may do with a repository trunk, unless a repo sets its own. Opening a pull request is the safer choice for anything other people depend on.",
  "options":[
    {"value":"merge","label":"May merge to main (current behaviour)"},
    {"value":"pr","label":"Open a pull request, never merge"},
    {"value":"none","label":"Commit only — no push, no pull request"}]}'))
WHERE COALESCE(json_extract(COALESCE(NULLIF(config, ''), '{}'), '$.capabilities.surfaces'), '') LIKE '%coding%'
  AND config NOT LIKE '%"merge_policy"%';
