-- The Lead Finder's fixed pipeline reaches the instance that already exists (#394, #496).
--
-- `0111` put the 10-step definition on the `agents` row, which fixes the catalog: a NEW subscriber
-- gets it, because subscribe copies `agents.config.pipelines` (`defaultPipelinesFor`). It reached
-- nobody who was already running the agent, because that is the only moment the copy is made —
-- `loadPipeline` reads `SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2`
-- (`lib/pipeline.ts`) and has no fallback to the agents row. There are no external users, so there
-- are no future subscribers: the one live Lead Finder instance predates `0111` by months and is
-- still running the hand-attached 8-step copy — the one missing exactly the two steps `6b37070`
-- added to stop the 1MiB step-output crash. Every capital-city sweep since 2026-08-03 has died in
-- `flatten`.
--
-- ── The decision, stated here because a migration is where the next author will look
--
-- An instance is a SNAPSHOT, not a view (`lib/instance-copied-config.ts`). That is the marketplace
-- invariant — a creator must not silently change what a running instance does — and it is why the
-- answer is not "make `loadPipeline` fall back to the agents row". The consequence is the rule this
-- file obeys and `lib/seed-identity-propagation.test.ts` now enforces:
--
--   a migration that patches an instance-copied key on `agents` must ALSO write the instance copy
--   where D1 can reach it, gated so it cannot clobber a subscriber's own edit — or record that it
--   deliberately does not.
--
-- `$.pipelines` is the reachable case (a D1 column). `$.identity` is not: it lives in the Durable
-- Object and no migration can touch it, which is the half of #483 that shipped to nobody.
--
-- ── The gate, and why it is this shape
--
-- The definition is not embedded here. It is COPIED FROM THE AGENTS ROW that `0111` seeded, so
-- there is no third copy of the pipeline to drift against `lib/pipelines/lead-finder.json` — the
-- drift `seed-drift.test.ts` exists to prevent, one layer down. It also means this migration says
-- exactly what it does: propagate the seed.
--
-- Matched by SHAPE, not by bytes: the eight steps must be, in order,
-- geocode · fan_out · http_request · flatten · map · enrich · filter · dedupe_upsert, and the sink
-- must be the `leads` collection. That sequence is the reference definition MINUS the two steps the
-- 1MiB fix added — `slice` (the cap) and the second `map` (the reshape that follows the
-- `responseMap` projection) — which is precisely the stale copy this is written for, and cannot
-- match the fixed one (10 steps) or a pipeline that is not a lead finder. `seed-drift.test.ts`
-- derives that sequence from `lead-finder.json` and asserts this WHERE clause names it, so the gate
-- cannot quietly stop describing the definition it is gating on.
--
-- What the shape gate does NOT protect: a subscriber who edited an INPUT inside one of those eight
-- steps (tools unchanged) still matches, and is replaced. Accepted, with a net: the definition being
-- replaced is archived verbatim under `$.pipelinesReplaced.lead_finder`, so nothing is destroyed and
-- a hand edit can be re-applied. The trade is deliberate — the definition being replaced is the one
-- that cannot complete a capital-city sweep at all, so preserving a tuning of it preserves a run
-- that crashes. `$.pipelinesReplaced` is inert: nothing reads it, `pipelineNamesFor` only walks
-- `$.pipelines`, and `instanceListView` whitelists two keys out of the instance config for the API.
--
-- ── Fails closed
--
-- Every read is normalised through `CASE WHEN json_valid(config) THEN config ELSE '{}' END` rather
-- than relying on AND short-circuiting to protect a `json_extract` from a malformed row — a
-- migration that errors takes a deploy with it. On a fresh database, and on any database where
-- `0111` did not apply (no such agent row), the final guard — the agents row must carry a 10-step
-- `lead_finder` — is false and this is a clean no-op. If the live instance's definition turns out
-- not to be the shape above, this is also a no-op: the remaining route is then the owner-run
-- `PUT /v1/instances/:id/pipelines/lead_finder` recorded on #394, and nothing here has damaged
-- anything.
--
-- Idempotent: after it runs the instance carries 10 steps, so the gate no longer matches and the
-- archive is not overwritten with the fixed definition on a re-run.

UPDATE agent_instances
   SET config = json_set(
         json_set(
           -- Ensure `$.pipelinesReplaced` exists first: json_set creates a LEAF, never an
           -- intermediate object, so writing '$.pipelinesReplaced.lead_finder' into a config that
           -- has no '$.pipelinesReplaced' would be a silent no-op and the archive would be lost.
           json_set(
             CASE WHEN json_valid(config) THEN config ELSE '{}' END,
             '$.pipelinesReplaced',
             json(COALESCE(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelinesReplaced'), '{}'))
           ),
           '$.pipelinesReplaced.lead_finder',
           json(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.lead_finder'))
         ),
         -- Narrow path: any other pipeline on the instance (`pump_test`), the display name, the
         -- runner-node pin and the settings all survive untouched.
         '$.pipelines.lead_finder',
         json((SELECT json_extract(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.lead_finder')
                 FROM agents a
                WHERE a.slug = 'small-business-website-lead-finder'))
       ),
       updated_at = datetime('now')
 WHERE agent_id IN (SELECT a.id FROM agents a WHERE a.slug = 'small-business-website-lead-finder')
   AND (SELECT json_group_array(json_extract(value, '$.tool'))
          FROM json_each(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.lead_finder.steps')))
       = '["geocode","fan_out","http_request","flatten","map","enrich","filter","dedupe_upsert"]'
   AND json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.lead_finder.sink.collection') = 'leads'
   AND (SELECT json_array_length(json_extract(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.lead_finder.steps'))
          FROM agents a
         WHERE a.slug = 'small-business-website-lead-finder') = 10;
