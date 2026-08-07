# Declarative pipelines — reference definitions

Pipelines here are **data, not code** (epic #94). Each `*.json` is a `PipelineDef`
(`workers/api/src/lib/pipeline.ts`) validated by `validatePipeline` and run by the durable
runner (`workers/api/src/workflows/pipeline-run.ts`) via `executePipelineStep`, using the
core step library (`workers/api/src/lib/steps.ts`) + the generic HTTP connector
(`workers/api/src/lib/connectors/http.ts`).

## `lead-finder.json` — the epic #94 capstone

The lead-finder ("find small businesses with no / dead website") expressed as pure
configuration. It is the *proof* that the common **source → transform → sink** class can be
built without a bespoke Worker. As of the #113–#116 fixes this is the **FULL sweep** (grid +
geo + reachability), no longer a spine. Proven end-to-end in `lead-finder.test.ts`: the JSON is
driven through the real runner + real `fan_out`/`flatten`/`map`/`enrich`/`filter`/`dedupe`
handlers; only the two I/O boundaries (outbound HTTP, the collection sink DO) are mocked.

### Epic proof-bullet → concrete step

| Epic bullet | Step in `lead-finder.json` | Status |
|---|---|---|
| **source:** HTTP connector → Google Places nearby (city→geocode, type, radius = params) | `geocode` (city→centre) → `http_request` POST `places:searchNearby`, `X-Goog-Api-Key` via vault `auth`, `X-Goog-FieldMask` header, `responseMap: "places[].{place_id:id,name:displayName.text,…}"` | ✅ composes |
| **paginate:** grid cells around the geocoded centre | `fan_out` (grid, `center:{lat,lng}` from geo) → `http_request` `forEach:{$ref:"grid.cells"}` with `{$param:"item.lat"}`/`{$param:"item.lng"}` in the body → `flatten` (`path:"data"`) collapses the per-cell envelopes to one flat list | ✅ **closed** — #113 (`flatten`) + #114 (dotted-item) |
| **bound:** cap what one sweep examines | `slice` `{items:{$ref:"flat.items"}, limit:{$param:"max_places"}}`, declared with `default: 300` | ✅ see "The bound" below |
| **map:** addressComponents → {city, suburb, state, country} | done in the `http_request` `responseMap`: `country:addressComponents[types~=country].longText`, `state:…[types~=administrative_area_level_1]…`, `city:…[types~=locality]…`, `suburb:…[types~=sublocality]…`; the `map` step then only reshapes (`keep`/`rename`/`derive`) | ✅ **closed** — #116 (type-predicate `getPath`) populates geo from Google's typed array |
| **enrich:** HTTP-reachability on websiteUri | `enrich` `{tool:"http_reachable", input:{url:{$item:"websiteUri"}}, as:"reachable"}` — probes per record, merges `{ok,code}` back onto a copy of the place | ✅ **closed** — #115 (`enrich` merge primitive) |
| **filter:** keep no-website OR unreachable | `filter` `any:true, where:[{field:"websiteUri",op:"missing"},{field:"reachable.ok",op:"eq",value:false}]` | ✅ **closed** — both halves compose (the "OR unreachable" half rides the enriched `reachable.ok`) |
| **dedupe:** upsert by place_id | `dedupe_upsert` `key:"place_id"` | ✅ composes |
| **sink:** instance collection `leads` | `sink.collection: "leads"` + `dedupe_upsert` into it | ✅ composes |
| **audit:** per-record run log | `attachAudit(records, trail, "leads")` — a `{step,detail,at}` entry per step + a sink line | ✅ composes |

### The bound — why a sweep is capped, and how it says so (#394)

Cloudflare journals every `step.do` return value and rejects one over **1MiB**, killing the RUN. A
`StepResult` carries its payload twice (the pretty-printed `content` AND the parsed `output`), so a
step's journal entry is roughly 3× the records it holds. Three production runs died on Sydney and
Brisbane at `Step s3-flatten-1 output is too large`; every run that completed was Hobart or
Launceston. The grid's structural maximum is **500 places** (25 cells × `maxResultCount` 20), and at
that size Google's raw `addressComponents` arrays are ~73% of the bytes — 1.68MB at `flatten`.

Two things keep it under the line, and they are not interchangeable:

1. **The `responseMap` projects the four geo strings** instead of passing the typed-component
   arrays down the chain, so the raw arrays never cross a step boundary. This is what fixes the
   crash: `flatten` is the step that failed, and no later `slice` can shrink an earlier step's
   output.
2. **`slice` bounds the count** before `enrich`, the only per-item connector call — capping after it
   would bound the payload while leaving the spend (one HTTP probe per place) unbounded.

`max_places` declares `default: 300`, because a `slice` whose `limit` is an unsupplied `$param`
resolves to `undefined` and an absent limit means *keep everything* — the step that bounds the run
would stop bounding it whenever the wiring forgets a param. A subscriber overrides it with an agent
setting of the same id (`lib/pipeline-run-start.ts`: caller > setting > declared default).

When the cap binds, the runner emits a warn-level `pipeline.capped` trace event and appends the
shortfall to the run's own detail line (`coverageShortfall`). Silent truncation reads as "covered
everything" when it didn't, and `seen` counts only what was examined — so without that line a capped
sweep of Sydney and a complete sweep of Hobart are indistinguishable.

### Chaining note (envelopes)

`map`/`filter`/`flatten`/`enrich` return `{items,count,…}` and `http_request` returns
`{status,data,…}`. A step's `$ref` reads the **whole** bound output, so the JSON chains off the
envelope field: `grid.cells` → `http_request` `forEach`; the per-cell `forEach` binds an array
of `{status,data}` envelopes at `pages`, so `flatten` uses `{items:{$ref:"pages"}, path:"data"}`
to lift + concatenate each cell's `data`; then `flat.items` → `slice.items`, `bounded.items` →
`map.items`, `shaped.items` → `enrich.items`, `enriched.items` → `filter.items`, `leads.items` →
`dedupe_upsert.items`.
This is the contract, not a gap.

### The enrich follow-on (#99 web_search → extract_contacts)

The socials/email enrichment the epic mentions is a second `enrich` stage that reuses the SAME
primitive as reachability: `enrich {tool:"web_search", input:{query:{$item:"name"}}, as:"hits"}`
→ `map`/`extract_contacts` over `hits` → Instagram / Facebook / email columns on the lead. Both
tools already exist (`steps.ts` `extract_contacts`, the `web_search` connector, #99). Now that
**#115** (`enrich`) has landed, this is fully expressible declaratively — no new primitive needed.

## Gaps found by the capstone — all CLOSED (children of #94)

Each was asserted in `lead-finder.test.ts`; those "GAP #N" tests now assert the fix **works**
(they flipped from asserting-the-limitation), so the green suite hides nothing.

| # | Gap (now closed) | Fix | Issue |
|---|---|---|---|
| 1 | `forEach` over a source whose tool returns an array → **array-of-arrays** couldn't be collapsed | `flatten` step (`{items, depth?, path?}`) — `path` also lifts a sub-array out of each result envelope | [#113](https://github.com/ProAgentStore/platform/issues/113) ✅ |
| 2 | `forEach` `item` had **no dotted access** — `{$param:"item.lat"}` was undefined | `resolveInputValue`: `$param:"item.<path>"` → `readPath(scope.item, path)` (whole-item still works) | [#114](https://github.com/ProAgentStore/platform/issues/114) ✅ |
| 3 | **enrich-merge** missing — a `forEach` tool result was a parallel array, unjoinable | `enrich` step (`{items, tool, input, as, concurrency?}`) — runs `tool` per item (`{$item:"path"}` templates), merges result under `as` on a copy | [#115](https://github.com/ProAgentStore/platform/issues/115) ✅ |
| 4 | `getPath` grammar couldn't **type-select** Google's `addressComponents` array | `getPath` predicate `arr[key~=token].sub` — select the element whose `key` contains the token, then continue | [#116](https://github.com/ProAgentStore/platform/issues/116) ✅ |

## Verdict

**Can this class of agent be built by config alone today? Yes — the WHOLE sweep, not just the
spine.** `geocode → fan_out(grid) → http_request(searchNearby per cell, forEach, geo projected in
the responseMap) → flatten → slice(max_places) → map(reshape/derive) → enrich(http_reachable) →
filter(no-website OR unreachable) → dedupe_upsert → leads`, with a per-record audit trail, is
**100% declarative and proven end-to-end** — including on a full 25-cell × 20-place grid, which is
the size that used to kill the run. The four expressibility gaps the capstone first hit
(#113–#116) are closed as **general runner / step-library primitives** — `flatten`, dotted-item
access, `enrich`-merge, and type-predicate `getPath` — each useful well beyond this pipeline. The
same `enrich` primitive also makes the #99 socials/email stage expressible. None of it touched
the running lead-finder agent; the lead-finder class is now buildable with zero bespoke code.
