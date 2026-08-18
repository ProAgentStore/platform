-- The Lead Outreach agent's pipeline stops existing only as instance data (#706).
--
-- `draft_outreach` is the second link of the lead chain — Lead Finder emits `lead.created`, the
-- pump routes it here, and this pipeline drafts the message. It is the platform's only live
-- demonstration of agent-to-agent choreography, with 100+ completed runs behind it. Until this
-- migration its definition existed in exactly ONE place: `agent_instances.config.pipelines
-- .draft_outreach` on instance `3c09069a-e866-4218-978e-569f62f4ab10`. There was no reference
-- JSON in the tree, nothing imported it, no test drove it, and `agents.config` for
-- `lead-outreach-tj6qrr` was `{}` — one of only two published agents with an empty config.
--
-- Two consequences, and the second is the one that made this a P1:
--
--   * A NEW subscriber got nothing. Subscribe copies `agents.config.pipelines`
--     (routes/instances.ts `defaultPipelinesFor`), and there was nothing to copy — so the agent
--     the storefront sells as "drafts personalized cold-outreach" would have arrived inert. This
--     is the same defect 0111 fixed for the Lead Finder, on the same field.
--   * Every other pipeline in the catalogue can be rebuilt from the repository. This one could
--     not. Cancelling that one subscription, or any bug that rewrote that one config blob, would
--     have destroyed the definition outright.
--
-- The definition seeded below was READ BACK from the live instance on 2026-08-18 via
-- `GET /v1/instances/3c09069a-…/pipelines/draft_outreach` (the #464 read path, owner-scoped) and
-- committed verbatim as `lib/pipelines/lead-outreach.json`. `lib/pipelines/seed-drift.test.ts`
-- parses it back out of the SQL below and asserts it equals that file, so the two cannot drift the
-- way 0111 was written to stop.
--
-- ── Why the live instance is deliberately NOT re-synced
--
-- #496 established that a migration writing `agents` does not reach existing instances, and 0130
-- had to follow 0111 to repair the one Lead Finder instance that was already stale. There is
-- nothing of that kind to repair here, and the reason is structural rather than lucky: the
-- reference JSON was DERIVED FROM the live instance, so by construction the instance already holds
-- byte-for-byte what this migration seeds. A propagation statement could only do harm — it would
-- rewrite a working, 100-run-old configuration with a value copied from it, for no gain, and would
-- silently discard any tuning the subscriber makes between this commit and the deploy.
--
-- ── Why UPDATE by slug and not INSERT
--
-- Like `small-business-website-lead-finder` (0111) and unlike `site-builder` (0057), this agent was
-- created through the normal creator flow and is owned by a real account. There is no row to insert
-- on a fresh database and nothing here fabricates one; on a fresh DB this is a clean no-op. By SLUG
-- rather than by the id `bf1de46a-…`, for the same reason a seed does not hardcode a uuid.
--
-- ── Why `draft_outreach` and not `lead-outreach`
--
-- The KEY is what resolves: `loadPipeline` looks up `config.pipelines[key]` and nothing resolves by
-- `def.name`. Production — the live instance, `pipeline_runs.pipeline`, the connection fed by
-- `lead.created` — all say `draft_outreach`. Seeding under any other spelling would create a SECOND
-- pipeline beside the live one rather than the same one, which is 0111's lesson restated. The
-- file is named `lead-outreach.json` after the agent, per #706; key == name == `draft_outreach`.
--
-- ── Why no `capabilities.tools` statement
--
-- 0111 needed one because the lead finder reaches `http_request` (from inside `geocode` and
-- `fan_out`, not only from its explicit step). This definition reaches NO connector tool at all —
-- `map`, `ai_generate` and `dedupe_upsert` are the core step library, all instance-local — so
-- `undeclaredPipelineTools` is empty and there is nothing to declare. Declaring a list anyway would
-- be actively harmful: a declared list REPLACES the permissive per-surface default (`toolNamesFor`),
-- so it would strip this agent's chat of the storage and KB tools it uses today. seed-drift.test.ts
-- asserts the empty-gated-set premise against the real registry, so a step that later reaches a
-- connector fails there rather than at 3am mid-run.
--
-- ── Idempotent, and composable
--
-- A targeted `json_set` on one path, never a replacement of the `config` column: another lane may
-- be writing `$.capabilities` on seeded agents at the same time, and a whole-column write would
-- revert whichever landed second. Re-running sets the same JSON.

UPDATE agents
   SET config = json_set(
         -- Ensure the parent object exists: json_set creates a LEAF, never an intermediate
         -- object, so '$.pipelines.draft_outreach' is silently a no-op on a config that has no
         -- '$.pipelines' at all — which is exactly this agent's config today.
         json_set(
           COALESCE(NULLIF(config, ''), '{}'),
           '$.pipelines',
           json(COALESCE(json_extract(COALESCE(NULLIF(config, ''), '{}'), '$.pipelines'), '{}'))
         ),
         '$.pipelines.draft_outreach', json('{
               "name": "draft_outreach",
               "params": {
                 "name": {
                   "type": "string"
                 },
                 "suburb": {
                   "type": "string"
                 },
                 "city": {
                   "type": "string"
                 },
                 "address": {
                   "type": "string"
                 },
                 "phone": {
                   "type": "string"
                 },
                 "website_status": {
                   "type": "string"
                 },
                 "place_id": {
                   "type": "string"
                 }
               },
               "steps": [
                 {
                   "tool": "map",
                   "bind": "lead",
                   "inputs": {
                     "items": [
                       {}
                     ],
                     "derive": {
                       "place_id": {
                         "$param": "place_id"
                       },
                       "name": {
                         "$param": "name"
                       },
                       "suburb": {
                         "$param": "suburb"
                       },
                       "city": {
                         "$param": "city"
                       },
                       "address": {
                         "$param": "address"
                       },
                       "phone": {
                         "$param": "phone"
                       },
                       "website_status": {
                         "$param": "website_status"
                       },
                       "status": "new"
                     }
                   }
                 },
                 {
                   "tool": "ai_generate",
                   "bind": "drafted",
                   "inputs": {
                     "items": {
                       "$ref": "lead.items"
                     },
                     "as": "draft_message",
                     "maxTokens": 300,
                     "system": "You write concise, friendly cold-outreach for a web-design freelancer contacting local small businesses that have NO website (or a broken one). 3-4 sentences, specific to the business, warm, no fluff, end with a soft CTA. Return ONLY the message text.",
                     "prompt": "Business: {{name}} in {{suburb}}, {{city}}. Address: {{address}}. Phone: {{phone}}. Website status: {{website_status}}. Draft a short outreach offering to build them a simple website."
                   }
                 },
                 {
                   "tool": "dedupe_upsert",
                   "bind": "stored",
                   "inputs": {
                     "items": {
                       "$ref": "drafted.items"
                     },
                     "collection": "prospects",
                     "key": "place_id",
                     "mode": "update"
                   }
                 }
               ],
               "sink": {
                 "collection": "prospects",
                 "keyField": "place_id"
               }
             }')
       ),
       updated_at = datetime('now')
 WHERE slug = 'lead-outreach-tj6qrr'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

-- ── The second statement: the route to an instance that already exists (#496)
--
-- `$.pipelines` is copied at subscribe and never re-read, so the statement above fixes the catalog
-- and reaches nobody already running the agent. `seed-identity-propagation.test.ts` requires every
-- migration patching that key on an existing agent row to name a migration that writes the instance
-- copy; this file names ITSELF, because the two halves belong to one decision and splitting them
-- across two files (as 0111 → 0130 had to, nineteen migrations apart) would only be re-creating the
-- gap deliberately.
--
-- It FILLS, it never overwrites — `json_type(…, '$.pipelines.draft_outreach') IS NULL`. That is the
-- whole difference from 0130, and it is not caution for its own sake:
--
--   * The one live instance ALREADY holds this definition, byte for byte, because the definition
--     was read back OFF it. There is no stale copy to repair, which is what 0130 existed to do.
--   * Overwriting it could therefore only destroy something — any tuning the subscriber makes
--     between this commit and the deploy — in exchange for writing back a copy of the instance's
--     own value. So in production this statement is expected to be a no-op, and that is stated
--     rather than discovered. (0111's tools statement shipped on the same footing.)
--   * What it does do is real: an instance of this agent that has NO `draft_outreach` at all —
--     one whose copy went missing, or one created while the agent row was still `{}` — gets the
--     definition instead of running inert.
--
-- Copied FROM the agents row rather than embedded, so there is deliberately no third copy of the
-- definition to drift (0130's principle). Guarded on the agents row actually holding an object, so
-- a database where the first statement matched nothing cannot write a null over the key.

UPDATE agent_instances
   SET config = json_set(
         -- Ensure the parent exists first: json_set creates a LEAF, never an intermediate object.
         json_set(
           CASE WHEN json_valid(config) THEN config ELSE '{}' END,
           '$.pipelines',
           json(COALESCE(json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines'), '{}'))
         ),
         '$.pipelines.draft_outreach',
         json((SELECT json_extract(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.draft_outreach')
                 FROM agents a
                WHERE a.slug = 'lead-outreach-tj6qrr'))
       ),
       updated_at = datetime('now')
 WHERE agent_id IN (SELECT a.id FROM agents a WHERE a.slug = 'lead-outreach-tj6qrr')
   AND json_type(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.pipelines.draft_outreach') IS NULL
   AND (SELECT json_type(CASE WHEN json_valid(a.config) THEN a.config ELSE '{}' END, '$.pipelines.draft_outreach')
          FROM agents a
         WHERE a.slug = 'lead-outreach-tj6qrr') = 'object';
