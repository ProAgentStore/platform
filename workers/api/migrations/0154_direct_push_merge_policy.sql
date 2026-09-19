-- Direct-push-only as a merge policy (#821): the MIRROR of `pr`, not a rung above it.
--
-- Run cda38e26 opened pull request #819 on ProAgentStore/platform — a repository whose entire
-- workflow is commit-and-push to `main`, with no branches and no pull requests. The objective's
-- prose told the run not to. It did anyway, near its iteration limit. Prose is layer 1 of the
-- #314 gate and layer 1 is advisory; this is the value that puts layers 2 and 3 behind it.
--
-- THERE IS NO SCHEMA CHANGE HERE, and that is worth stating rather than leaving a reader to
-- wonder. `coding_repos.merge_policy` (migration 0091) is `TEXT NOT NULL DEFAULT ''` with no CHECK
-- constraint — the vocabulary is enforced in TypeScript by `parseMergePolicy`, which is where it
-- can fall THROUGH an unrecognised value to the next level rather than failing a write. So a repo
-- override of `direct` already stores and already resolves; the one thing missing was the
-- agent-wide option, which is a seeded `settingsSchema` select and therefore data.
--
-- DEFAULT IS UNCHANGED. `DEFAULT_MERGE_POLICY` stays `merge`, the repo column still defaults to
-- '' (inherit), and no existing row is given a policy it did not choose. This migration adds an
-- option to a dropdown; it selects nothing.
--
-- Idempotent, and guarded on the OPTIONS rather than on the document. A `config NOT LIKE
-- '%"direct"%'` guard would skip any agent whose description happens to contain the word, which
-- is a silent no-op on exactly the agents this is for. The NOT EXISTS below asks the only
-- question that matters: does the merge_policy field already offer this value?
--
-- The path is computed because the field's INDEX in settingsSchema is not fixed — 0091 appended
-- it with `[#]`, so it sits wherever that agent's schema happened to end. The subquery cannot
-- return NULL under the WHERE clause (the EXISTS above it requires a match), so the concatenated
-- path cannot be NULL and `json_insert` cannot blank a config.
UPDATE agents
SET config = json_insert(
  COALESCE(NULLIF(config, ''), '{}'),
  '$.settingsSchema[' || (
    SELECT je.key
    FROM json_each(COALESCE(NULLIF(agents.config, ''), '{}'), '$.settingsSchema') je
    WHERE json_extract(je.value, '$.id') = 'merge_policy'
    LIMIT 1
  ) || '].options[#]',
  json('{"value":"direct","label":"Push straight to main — never open a pull request"}')
)
WHERE COALESCE(json_type(COALESCE(NULLIF(config, ''), '{}'), '$.settingsSchema'), '') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(COALESCE(NULLIF(agents.config, ''), '{}'), '$.settingsSchema') je
    WHERE json_extract(je.value, '$.id') = 'merge_policy'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(COALESCE(NULLIF(agents.config, ''), '{}'), '$.settingsSchema') je,
         json_each(je.value, '$.options') op
    WHERE json_extract(je.value, '$.id') = 'merge_policy'
      AND json_extract(op.value, '$.value') = 'direct'
  );
