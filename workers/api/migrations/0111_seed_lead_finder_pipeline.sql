-- The Lead Finder's fixed pipeline reaches the agent it belongs to (#394).
--
-- `6b37070` fixed the 1MiB step-output crash in `lib/pipelines/lead-finder.json` and shipped the
-- runner half of that fix to production — `capStepOutput`, `coverageShortfall`, the
-- caller > setting > declared-default param resolution, `responseMap` projection. All correct, all
-- live. But the DEFINITION half landed in a file production never loads: the only importers of
-- lead-finder.json in the whole tree are two tests, and `loadPipeline` reads
-- `agent_instances.config.pipelines[key]`. So the fixed definition could not reach a single user.
--
-- Measured on 2026-08-08 before writing this:
--
--   * `agents.config` for `small-business-website-lead-finder` was
--     `{"capabilities":{"tools":[…16…]}}` — no `pipelines` key and no `settingsSchema`. Subscribe
--     copies `agents.config.pipelines` (routes/instances.ts), so a NEW subscriber got an agent that
--     could do nothing at all, while the storefront card still sold "search by city and business
--     type".
--   * The one live instance carried an 8-step `lead_finder` put there by hand. The reference is 10:
--     the two it is missing are `slice` (the cap) and the second `map` (the reshape that follows
--     the `responseMap` projection) — i.e. exactly the two steps `6b37070` added to stop the crash.
--   * Every capital-city sweep attempted since is still in the failed column
--     (`WorkflowInternalError: Step s3-flatten-1 output is too large`); the only two runs after the
--     fix were Hobart and Launceston, small enough not to hit the bound either way.
--
-- ── Why UPDATE by slug and not INSERT
--
-- Unlike `site-builder` (0057), this agent is not first-party seed data — it was created through
-- the normal creator flow and is owned by a real account, so there is no row to insert on a fresh
-- database and nothing here fabricates one. On a fresh DB both statements are a clean no-op; they
-- are aimed at the database where the agent actually exists. By SLUG rather than by the id
-- `4d9945ab-…` for the same reason a seed does not hardcode a uuid: the slug is the stable name.
--
-- ── Why `lead_finder` and not `lead-finder`
--
-- The KEY is authoritative and always has been: `loadPipeline` looks up `config.pipelines[key]`,
-- nothing resolves by `def.name`, and the console, `pipeline_runs.pipeline`, the board and the one
-- existing connection all say `lead_finder`. Seeding under `lead-finder` would have created a
-- second pipeline beside the live one rather than the same one.
--
-- The reference JSON's own `name` field is changed to match in the same commit. Under key
-- `lead_finder` with `name: "lead-finder"` this seed would have re-created, for every future
-- subscriber, precisely the split #173 fixed — run rows under one spelling and every log line the
-- workflow writes under another. `pipelineDefForKey` normalises that at ATTACH, but
-- `defaultPipelinesFor` (the subscribe path) deliberately does not rewrite what it copies, so the
-- fix has to be in the definition. Key == name is also what 0057 does.
--
-- ── The settings field
--
-- `max_places` at TOP-LEVEL `$.settingsSchema`, not under `capabilities` — `agentCapabilities`
-- reads it from there, and nesting it yields no settings card at all (0057 has the same note).
-- A setting id addresses a param BY NAME exactly (`paramsWithDefaults`), so `max_places` is the id
-- because `max_places` is the param; this is the first knob on this agent that a subscriber can
-- turn and have a run obey. Its default is 300, the same number the definition declares, so an
-- untouched setting cannot change the meaning of the pipeline's own default.
--
-- `city` / `type` / `radius` are deliberately NOT settings: they are per-run arguments, and every
-- run in the history supplies all three.
--
-- ── Idempotent, and composable
--
-- Both statements re-set the same JSON on a re-run, and both are targeted `json_set` writes on
-- specific paths rather than a replacement of the `config` column — `$.capabilities` survives the
-- first statement untouched, and any other pipeline already on the agent (`pump_test`) survives too.
-- `lib/pipelines/seed-drift.test.ts` parses the definition back out of the SQL below and asserts it
-- equals the reference JSON, so the two cannot drift the way they just did.

UPDATE agents
   SET config = json_set(
         -- Ensure the parent object exists: json_set creates a LEAF, never an intermediate
         -- object, so '$.pipelines.lead_finder' is silently a no-op on a config that has no
         -- '$.pipelines' at all — which is exactly this agent's config today.
         json_set(
           COALESCE(NULLIF(config, ''), '{}'),
           '$.pipelines',
           json(COALESCE(json_extract(COALESCE(NULLIF(config, ''), '{}'), '$.pipelines'), '{}'))
         ),
         '$.pipelines.lead_finder', json('{
             "name": "lead_finder",
             "params": {
               "city": {
                 "type": "string",
                 "description": "City to sweep, e.g. \"Sydney, NSW\" — geocoded to the search centre."
               },
               "type": {
                 "type": "string",
                 "description": "Google Places includedType, e.g. \"cafe\" / \"restaurant\"."
               },
               "radius": {
                 "type": "number",
                 "description": "searchNearby radius in metres around each grid cell (e.g. 900)."
               },
               "max_places": {
                 "type": "number",
                 "description": "Most places one sweep examines after the grid is collapsed (default 300). The grid can return 500 (25 cells × maxResultCount 20); anything past the cap is NOT examined and the run reports how many were left, never dropping them silently. Overridden per instance by the agent''s `max_places` setting.",
                 "default": 300
               }
             },
             "steps": [
               {
                 "tool": "geocode",
                 "bind": "geo",
                 "inputs": {
                   "address": {
                     "$param": "city"
                   }
                 }
               },
               {
                 "tool": "fan_out",
                 "bind": "grid",
                 "inputs": {
                   "mode": "grid",
                   "center": {
                     "lat": {
                       "$ref": "geo.lat"
                     },
                     "lng": {
                       "$ref": "geo.lng"
                     }
                   },
                   "extentKm": 2,
                   "stepKm": 1
                 }
               },
               {
                 "tool": "http_request",
                 "bind": "pages",
                 "forEach": {
                   "$ref": "grid.cells"
                 },
                 "inputs": {
                   "method": "POST",
                   "url": "https://places.googleapis.com/v1/places:searchNearby",
                   "headers": {
                     "Content-Type": "application/json",
                     "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.location,places.googleMapsUri,places.addressComponents"
                   },
                   "auth": {
                     "mode": "api-key",
                     "key": {
                       "in": "header",
                       "name": "X-Goog-Api-Key"
                     }
                   },
                   "body": {
                     "includedTypes": [
                       {
                         "$param": "type"
                       }
                     ],
                     "maxResultCount": 20,
                     "locationRestriction": {
                       "circle": {
                         "center": {
                           "latitude": {
                             "$param": "item.lat"
                           },
                           "longitude": {
                             "$param": "item.lng"
                           }
                         },
                         "radius": {
                           "$param": "radius"
                         }
                       }
                     }
                   },
                   "responseMap": "places[].{place_id:id,name:displayName.text,address:formattedAddress,phone:nationalPhoneNumber,websiteUri:websiteUri,lat:location.latitude,lng:location.longitude,maps_url:googleMapsUri,country:addressComponents[types~=country].longText,state:addressComponents[types~=administrative_area_level_1].longText,city:addressComponents[types~=locality].longText,suburb:addressComponents[types~=sublocality].longText}"
                 }
               },
               {
                 "tool": "flatten",
                 "bind": "flat",
                 "inputs": {
                   "items": {
                     "$ref": "pages"
                   },
                   "path": "data"
                 }
               },
               {
                 "tool": "slice",
                 "bind": "bounded",
                 "inputs": {
                   "items": {
                     "$ref": "flat.items"
                   },
                   "limit": {
                     "$param": "max_places"
                   }
                 }
               },
               {
                 "tool": "map",
                 "bind": "shaped",
                 "inputs": {
                   "items": {
                     "$ref": "bounded.items"
                   },
                   "keep": [
                     "place_id",
                     "name",
                     "address",
                     "phone",
                     "lat",
                     "lng",
                     "maps_url",
                     "country",
                     "state",
                     "city",
                     "suburb"
                   ],
                   "rename": {
                     "websiteUri": "website_url"
                   },
                   "derive": {
                     "category": {
                       "$param": "type"
                     },
                     "status": "new"
                   }
                 }
               },
               {
                 "tool": "enrich",
                 "bind": "enriched",
                 "inputs": {
                   "items": {
                     "$ref": "shaped.items"
                   },
                   "tool": "http_reachable",
                   "input": {
                     "url": {
                       "$item": "website_url"
                     }
                   },
                   "as": "reachable",
                   "concurrency": 4
                 }
               },
               {
                 "tool": "map",
                 "bind": "classified",
                 "inputs": {
                   "items": {
                     "$ref": "enriched.items"
                   },
                   "derive": {
                     "website_status": {
                       "$cond": {
                         "field": "website_url",
                         "op": "missing"
                       },
                       "then": "none",
                       "else": {
                         "$cond": {
                           "field": "reachable.ok",
                           "op": "falsy"
                         },
                         "then": "unreachable",
                         "else": "reachable"
                       }
                     }
                   }
                 }
               },
               {
                 "tool": "filter",
                 "bind": "leads",
                 "inputs": {
                   "items": {
                     "$ref": "classified.items"
                   },
                   "where": [
                     {
                       "field": "website_status",
                       "op": "in",
                       "value": [
                         "none",
                         "unreachable"
                       ]
                     }
                   ]
                 }
               },
               {
                 "tool": "dedupe_upsert",
                 "bind": "stored",
                 "inputs": {
                   "items": {
                     "$ref": "leads.items"
                   },
                   "collection": "leads",
                   "key": "place_id",
                   "mode": "update",
                   "emit": "lead.created"
                 }
               }
             ],
             "sink": {
               "collection": "leads",
               "keyField": "place_id"
             }
           }'),
         '$.settingsSchema', json('[
             {
               "id": "max_places",
               "label": "Places per sweep",
               "type": "number",
               "description": "Most places one sweep examines after the grid is collapsed. The grid can return 500; anything past this cap is left unexamined and the run says so. Raise it for a capital city.",
               "default": 300
             }
           ]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'small-business-website-lead-finder'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

-- Second statement, GUARDED: write the declared tool allowlist only when the agent has none.
--
-- The 16 names below are what the account owner applied BY HAND through PUT /v1/agents/:id on
-- 2026-08-08, after #381 made `capabilities.tools` authoritative and refused this agent's own
-- pipeline. They exist in no migration, so the repo could not reproduce the one declaration
-- without which the pipeline seeded above is refused at kick. That is the same drift this
-- migration is here to end, one field over.
--
-- `WHERE … json_type(…, '$.capabilities.tools') IS NULL` rather than an unconditional set,
-- because #444 was landing declared tools on seeded agents at the same time as this and an
-- unconditional restatement would silently revert whichever ran second. As shipped they do not in
-- fact overlap — 0108 writes `coder-lead`, `coder-repo` and `mcp-client`, this one writes a fourth
-- slug — but the guard is what made that safe to find out afterwards rather than beforehand, and it
-- is what keeps the next such pair safe. In production this statement is already a no-op: the
-- account owner applied these sixteen names by hand on 2026-08-08, which is precisely why the
-- repository needs to be able to state them.
--
-- `http_request` is the only GATED name here — it is what `geocode` (step 0), `fan_out`
-- (step 1) and the explicit step 2 all dispatch. The other fifteen carry no connector and are
-- therefore un-gateable; they are present because a declared list REPLACES the permissive
-- per-surface default (`toolNamesFor`), so declaring `http_request` alone would strip this
-- agent's chat of the storage/KB tools its transcript is observably using (`query_records`,
-- `list_collections`, `read_knowledge`) and quietly send it back to estimating from prose.
UPDATE agents
   SET config = json_set(
         json_set(
           COALESCE(NULLIF(config, ''), '{}'),
           '$.capabilities',
           json(COALESCE(json_extract(COALESCE(NULLIF(config, ''), '{}'), '$.capabilities'), '{}'))
         ),
         '$.capabilities.tools', json('[
             "http_request",
             "search_knowledge",
             "list_knowledge",
             "read_knowledge",
             "add_knowledge",
             "update_knowledge",
             "delete_knowledge",
             "upload_file",
             "list_files",
             "read_file",
             "delete_file",
             "create_collection",
             "list_collections",
             "insert_record",
             "query_records",
             "update_record"
           ]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'small-business-website-lead-finder'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'))
   AND json_type(COALESCE(NULLIF(config, ''), '{}'), '$.capabilities.tools') IS NULL;
