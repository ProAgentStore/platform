# Declarative pipelines — reference definitions

Pipelines here are **data, not code** (epic #94). Each `*.json` is a `PipelineDef`
(`workers/api/src/lib/pipeline.ts`) validated by `validatePipeline` and run by the durable
runner (`workers/api/src/workflows/pipeline-run.ts`) via `executePipelineStep`, using the
core step library (`workers/api/src/lib/steps.ts`) + the generic HTTP connector
(`workers/api/src/lib/connectors/http.ts`).

## `lead-finder.json` — the epic #94 capstone

The lead-finder ("find small businesses with no / dead website") expressed as pure
configuration. It is the *proof* that the common **source → transform → sink** class can be
built without a bespoke Worker. Proven end-to-end in `lead-finder.test.ts`: the JSON is driven
through the real runner + real `map`/`filter`/`dedupe` handlers; only the two I/O boundaries
(outbound HTTP, the collection sink DO) are mocked.

### Epic proof-bullet → concrete step

| Epic bullet | Step in `lead-finder.json` | Status |
|---|---|---|
| **source:** HTTP connector → Google Places nearby (city→geocode, type, radius = params) | `geocode` (city→centre) → `http_request` POST `places:searchNearby`, `X-Goog-Api-Key` via vault `auth`, `X-Goog-FieldMask` header, `responseMap: "places[].{place_id:id,name:displayName.text,…}"` | ✅ composes |
| **paginate:** grid cells around the geocoded centre | *intended:* `fan_out` (grid) → `http_request` `forEach: {$ref:"grid.cells"}` | ⚠️ **gap** — see #113 + #114. Shipped JSON uses a **single** `searchNearby` at the centre instead. |
| **map:** addressComponents → {city, suburb, state, country} | `map` `extract: {city:"addressComponents.locality", …}` + `derive: {category,status,website_status}` | ⚠️ derive/rename/passthrough ✅; the geo `extract` targets are correct **intent** but resolve to `null` against real Google data — see #116 |
| **enrich:** HTTP-reachability on websiteUri | *intended:* `http_reachable` per record, merged back onto the place | ⚠️ **gap** — see #115 (+ #114). Not in the shipped JSON. |
| **filter:** keep no-website OR unreachable | `filter` `where:[{field:"websiteUri",op:"missing"}]` | ⚠️ **partial** — the "no-website" half composes; the "OR unreachable" half is blocked by #115 (nothing merges reachability onto the record) |
| **dedupe:** upsert by place_id | `dedupe_upsert` `key:"place_id"` | ✅ composes |
| **sink:** instance collection `leads` | `sink.collection: "leads"` + `dedupe_upsert` into it | ✅ composes |
| **audit:** per-record run log | `attachAudit(records, trail, "leads")` — a `{step,detail,at}` entry per step + a sink line | ✅ composes |

### Chaining note (envelopes)

`map`/`filter` return `{items,count,…}` and `http_request` returns `{status,data,…}`. A step's
`$ref` reads the **whole** bound output, so the JSON chains off the envelope field:
`places.data` → `map.items`, `shaped.items` → `filter.items`, `leads.items` → `dedupe_upsert.items`.
This is the contract, not a gap.

### The enrich follow-on (#99 web_search → extract_contacts)

The socials/email enrichment the epic mentions is a second enrich stage:
`web_search` a business name + suburb → `extract_contacts` (pulls the first Instagram / Facebook
/ email out of the results) → columns on the lead. Both tools already exist (`steps.ts`
`extract_contacts`, the `web_search` connector, #99). Wiring them declaratively per-record
depends on the same **enrich-merge** primitive as reachability — **#115**.

## Gaps found by the capstone (all children of #94)

Each is asserted in `lead-finder.test.ts` (the "GAP #N" tests) so the green suite hides nothing.

| # | Gap | Blocks | Issue |
|---|---|---|---|
| 1 | `forEach` over a source whose tool returns an array → **array-of-arrays**; no `flatten` step / `arr[]` `$ref` grammar to collapse it | grid fan-out source | [#113](https://github.com/ProAgentStore/platform/issues/113) |
| 2 | `forEach` `item` has **no dotted access** — `{$param:"item.lat"}` is undefined; only the whole `{$param:"item"}` works | per-cell request body; per-record reachability url | [#114](https://github.com/ProAgentStore/platform/issues/114) |
| 3 | **enrich-merge** missing — a `forEach` tool result is a parallel array; no `enrich`/`zip` step to join it back onto the records | "unreachable" filter; socials/email enrich (#99) | [#115](https://github.com/ProAgentStore/platform/issues/115) |
| 4 | `map`/`responseMap` `getPath` grammar can't **type-select** Google's `addressComponents` array (`find element whose types[] contains X`) | geo fields {city,suburb,state,country} | [#116](https://github.com/ProAgentStore/platform/issues/116) |

## Verdict

**Can this class of agent be built by config alone today? Mostly — the spine, not yet the whole
sweep.** `geocode → single Places searchNearby → map(reshape/derive) → filter(no-website) →
dedupe_upsert → leads`, with a per-record audit trail, is **100% declarative and proven
end-to-end**. What still needs code (until #113–#116 land): the **grid** multi-cell sweep
(#113+#114), **reachability** to catch dead sites (#115+#114), **geo fields** from Google
address components (#116), and the **socials/email** enrich (#115+#99). None require touching
the running agent — they are runner/step-library primitives.
